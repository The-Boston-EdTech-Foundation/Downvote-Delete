import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import {
  reddit,
  redis,
  scheduler,
  settings as devvitSettings,
} from '@devvit/web/server';
import type { T3 } from '@devvit/shared-types/tid.js';
import { applyModerationAction } from '../core/actions';
import { getNextCheckRunAt } from '../core/backoff';
import { decideTrackedPostCheck, type PostSnapshot } from '../core/decision';
import { postToSnapshot } from '../core/postStatus';
import { normalizeSettings } from '../core/settings';
import {
  auditKey,
  createAuditRecord,
  parseTrackedPost,
  serializeTrackedPost,
  statsKey,
  type TrackedPost,
  type TrackingStatus,
  watchKey,
} from '../core/tracking';
import { CHECK_WATCHED_POST_TASK } from './triggers';

type CheckWatchedPostData = {
  postId?: string;
};

export const scheduledJobs = new Hono();

const actionLockKey = (postId: string): string =>
  `downvote-delete:action-lock:${postId}`;

async function loadTrackedPost(postId: string): Promise<TrackedPost | null> {
  return parseTrackedPost(await redis.get(watchKey(postId)));
}

async function writeTrackedPost(record: TrackedPost): Promise<void> {
  await redis.set(watchKey(record.postId), serializeTrackedPost(record));
}

async function stopTracking(
  record: TrackedPost,
  status: Exclude<TrackingStatus, 'active' | 'actioning'>,
  now: number,
  stopReason?: string
): Promise<void> {
  const stoppedRecord: TrackedPost = {
    ...record,
    status,
    updatedAt: now,
  };

  if (stopReason) {
    stoppedRecord.stopReason = stopReason;
  }

  await redis.set(
    auditKey(record.postId),
    JSON.stringify(createAuditRecord(stoppedRecord, now))
  );
  await redis.hIncrBy(statsKey(record.subredditId), status, 1);
  await redis.del(watchKey(record.postId));
}

async function fetchPostSnapshot(
  postId: string
): Promise<{ post: Awaited<ReturnType<typeof reddit.getPostById>>; snapshot: PostSnapshot } | null> {
  try {
    const post = await reddit.getPostById(postId as T3);
    return { post, snapshot: postToSnapshot(post) };
  } catch (err: unknown) {
    console.error(`Downvote Delete could not fetch post ${postId}.`, err);
    return null;
  }
}

async function markErrorAndReschedule(
  record: TrackedPost,
  err: unknown,
  now: number
): Promise<void> {
  console.error(`Downvote Delete check failed for ${record.postId}.`, err);

  if (now >= record.trackingExpiresAt) {
    await stopTracking(record, 'error', now, 'check_failed_after_expiration');
    return;
  }

  const nextCheckCount = record.checkCount + 1;
  const jobId = await scheduler.runJob({
    name: CHECK_WATCHED_POST_TASK,
    data: { postId: record.postId },
    runAt: getNextCheckRunAt(nextCheckCount, now),
  });

  await writeTrackedPost({
    ...record,
    checkCount: nextCheckCount,
    lastJobId: jobId,
    updatedAt: now,
    errorMessage: err instanceof Error ? err.message : String(err),
  });
}

scheduledJobs.post('/check-watched-post', async (c) => {
  const task = await c.req.json<TaskRequest<CheckWatchedPostData>>();
  const postId = task.data?.postId;

  if (!postId) {
    console.warn('Downvote Delete check ran without a post id.');
    return c.json<TaskResponse>({}, 200);
  }

  const initialRecord = await loadTrackedPost(postId);
  if (!initialRecord || initialRecord.status !== 'active') {
    return c.json<TaskResponse>({}, 200);
  }

  const now = Date.now();

  try {
    const currentSettings = normalizeSettings(await devvitSettings.getAll());
    const fetched = await fetchPostSnapshot(postId);
    const decision = decideTrackedPostCheck({
      tracking: initialRecord,
      settings: currentSettings,
      post: fetched?.snapshot ?? null,
      now,
    });

    if (decision.type === 'exit') {
      return c.json<TaskResponse>({}, 200);
    }

    if (decision.type === 'stop') {
      await stopTracking(initialRecord, decision.status, now);
      return c.json<TaskResponse>({}, 200);
    }

    if (decision.type === 'action') {
      const actionLockWasSet = await redis.set(actionLockKey(postId), '1', {
        nx: true,
        expiration: new Date(now + 60 * 60 * 1000),
      });

      if (actionLockWasSet !== 'OK') {
        return c.json<TaskResponse>({}, 200);
      }

      const latestRecord = await loadTrackedPost(postId);
      if (!latestRecord || latestRecord.status !== 'active' || !fetched) {
        return c.json<TaskResponse>({}, 200);
      }

      await writeTrackedPost({
        ...latestRecord,
        status: 'actioning',
        lastKnownScore: fetched.snapshot.score,
        updatedAt: now,
      });

      await applyModerationAction({
        redditClient: reddit,
        post: fetched.post,
        action: latestRecord.actionToTake,
        threshold: latestRecord.negativeScoreThreshold,
      });

      await stopTracking(
        {
          ...latestRecord,
          status: 'actioned',
          lastKnownScore: fetched.snapshot.score,
          actionedAt: Date.now(),
        },
        'actioned',
        Date.now(),
        latestRecord.actionToTake
      );
      await redis.hIncrBy(
        statsKey(latestRecord.subredditId),
        `action_${latestRecord.actionToTake}`,
        1
      );
      return c.json<TaskResponse>({}, 200);
    }

    const nextCheckCount = initialRecord.checkCount + 1;
    const jobId = await scheduler.runJob({
      name: CHECK_WATCHED_POST_TASK,
      data: { postId },
      runAt: getNextCheckRunAt(nextCheckCount, now),
    });

    const updatedRecord: TrackedPost = {
      ...initialRecord,
      checkCount: nextCheckCount,
      lastJobId: jobId,
      updatedAt: now,
    };

    if (fetched) {
      updatedRecord.lastKnownScore = fetched.snapshot.score;
    }

    await writeTrackedPost(updatedRecord);
  } catch (err: unknown) {
    await markErrorAndReschedule(initialRecord, err, Date.now());
  }

  return c.json<TaskResponse>({}, 200);
});
