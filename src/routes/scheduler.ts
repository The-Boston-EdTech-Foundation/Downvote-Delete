import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import {
  reddit,
  redis,
  scheduler,
  settings as devvitSettings,
} from '@devvit/web/server';
import type { T3 } from '@devvit/shared-types/tid.js';
import { applyModerationAction, buildActionReason } from '../core/actions';
import { getNextCheckDelayMinutes, getNextCheckRunAt } from '../core/backoff';
import { decideTrackedPostCheck, type PostSnapshot } from '../core/decision';
import { logError, logInfo, logWarn } from '../core/logging';
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
  const redisKey = watchKey(postId);
  logInfo('Pulling tracking record from Redis.', { postId, redisKey });

  const rawRecord = await redis.get(redisKey);
  const parsedRecord = parseTrackedPost(rawRecord);

  if (!rawRecord) {
    logInfo('No tracking record found in Redis.', { postId, redisKey });
    return null;
  }

  if (!parsedRecord) {
    logError('Tracking record in Redis is malformed.', {
      postId,
      redisKey,
      rawLength: rawRecord.length,
    });
    return null;
  }

  logInfo('Loaded tracking record from Redis.', {
    postId,
    redisKey,
    status: parsedRecord.status,
    checkCount: parsedRecord.checkCount,
    lastKnownScore: parsedRecord.lastKnownScore,
    negativeScoreThreshold: parsedRecord.negativeScoreThreshold,
    positiveScoreStopThreshold: parsedRecord.positiveScoreStopThreshold,
    actionToTake: parsedRecord.actionToTake,
  });

  return parsedRecord;
}

async function writeTrackedPost(record: TrackedPost): Promise<void> {
  const redisKey = watchKey(record.postId);
  logInfo('Writing tracking record to Redis.', {
    postId: record.postId,
    redisKey,
    status: record.status,
    checkCount: record.checkCount,
    lastKnownScore: record.lastKnownScore,
    lastJobId: record.lastJobId,
  });
  await redis.set(redisKey, serializeTrackedPost(record));
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

  logInfo('Stopping tracking; no further checks will be scheduled.', {
    postId: record.postId,
    subredditName: record.subredditName,
    status,
    reason: stopReason ?? status,
    checkCount: record.checkCount,
    lastKnownScore: record.lastKnownScore,
    auditKey: auditKey(record.postId),
    redisKey: watchKey(record.postId),
  });

  await redis.set(
    auditKey(record.postId),
    JSON.stringify(createAuditRecord(stoppedRecord, now))
  );
  await redis.hIncrBy(statsKey(record.subredditId), status, 1);
  await redis.del(watchKey(record.postId));

  logInfo('Tracking stopped and Redis watch key deleted.', {
    postId: record.postId,
    status,
    auditKey: auditKey(record.postId),
    deletedRedisKey: watchKey(record.postId),
  });
}

async function fetchPostSnapshot(
  postId: string
): Promise<{ post: Awaited<ReturnType<typeof reddit.getPostById>>; snapshot: PostSnapshot } | null> {
  try {
    logInfo('Fetching current Reddit post state.', { postId });
    const post = await reddit.getPostById(postId as T3);
    const snapshot = postToSnapshot(post);
    logInfo('Fetched current Reddit post state.', {
      postId,
      score: snapshot.score,
      approved: snapshot.approved,
      removed: snapshot.removed,
      filtered: snapshot.filtered,
      spam: snapshot.spam,
      deleted: snapshot.deleted,
      unavailable: snapshot.unavailable,
    });
    return { post, snapshot };
  } catch (err: unknown) {
    logError('Could not fetch post from Reddit.', { postId }, err);
    return null;
  }
}

async function markErrorAndReschedule(
  record: TrackedPost,
  err: unknown,
  now: number
): Promise<void> {
  logError(
    'Scheduled check failed before completion.',
    {
      postId: record.postId,
      checkCount: record.checkCount,
      expiresAt: new Date(record.trackingExpiresAt),
    },
    err
  );

  if (now >= record.trackingExpiresAt) {
    logWarn('Stopping after error because tracking window is expired.', {
      postId: record.postId,
      reason: 'check_failed_after_expiration',
    });
    await stopTracking(record, 'error', now, 'check_failed_after_expiration');
    return;
  }

  const nextCheckCount = record.checkCount + 1;
  const nextRunAt = getNextCheckRunAt(nextCheckCount, now);
  const nextDelayMinutes = getNextCheckDelayMinutes(nextCheckCount);
  const jobId = await scheduler.runJob({
    name: CHECK_WATCHED_POST_TASK,
    data: { postId: record.postId },
    runAt: nextRunAt,
  });

  await writeTrackedPost({
    ...record,
    checkCount: nextCheckCount,
    lastJobId: jobId,
    updatedAt: now,
    errorMessage: err instanceof Error ? err.message : String(err),
  });

  logInfo('Rescheduled post check after error.', {
    postId: record.postId,
    checkCount: nextCheckCount,
    nextDelayMinutes,
    nextRunAt,
    jobId,
  });
}

scheduledJobs.post('/check-watched-post', async (c) => {
  const task = await c.req.json<TaskRequest<CheckWatchedPostData>>();
  const postId = task.data?.postId;

  logInfo('Scheduled post check started.', {
    postId,
    payload: task.data,
  });

  if (!postId) {
    logWarn('Scheduled post check ran without a post id.', {
      reason: 'missing_post_id',
    });
    return c.json<TaskResponse>({}, 200);
  }

  const initialRecord = await loadTrackedPost(postId);
  if (!initialRecord || initialRecord.status !== 'active') {
    logInfo('Scheduled check exited without action because no active record exists.', {
      postId,
      status: initialRecord?.status,
      reason: initialRecord ? 'record_not_active' : 'record_missing',
    });
    return c.json<TaskResponse>({}, 200);
  }

  const now = Date.now();

  try {
    logInfo('Reading app installation settings for scheduled check.', { postId });
    const currentSettings = normalizeSettings(await devvitSettings.getAll());
    logInfo('Loaded app installation settings for scheduled check.', {
      postId,
      isActive: currentSettings.isActive,
      trackingDurationHours: currentSettings.trackingDurationHours,
      negativeScoreThreshold: currentSettings.negativeScoreThreshold,
      positiveScoreStopThreshold: currentSettings.positiveScoreStopThreshold,
      actionToTake: currentSettings.actionToTake,
      moderatorPostHandling: currentSettings.moderatorPostHandling,
    });

    const fetched = await fetchPostSnapshot(postId);
    const decision = decideTrackedPostCheck({
      tracking: initialRecord,
      settings: currentSettings,
      post: fetched?.snapshot ?? null,
      now,
    });

    if (decision.type === 'exit') {
      logInfo('Decision: exit without action.', {
        postId,
        status: initialRecord.status,
        reason: 'decision_exit',
      });
      return c.json<TaskResponse>({}, 200);
    }

    if (decision.type === 'stop') {
      logInfo('Decision: stop tracking.', {
        postId,
        status: decision.status,
        reason: decision.status,
        score: fetched?.snapshot.score,
        checkCount: initialRecord.checkCount,
      });
      await stopTracking(initialRecord, decision.status, now, decision.status);
      return c.json<TaskResponse>({}, 200);
    }

    if (decision.type === 'action') {
      const actionReason = buildActionReason(
        initialRecord.actionToTake,
        initialRecord.negativeScoreThreshold
      );

      logInfo('Decision: action post because score reached threshold.', {
        postId,
        score: fetched?.snapshot.score,
        negativeScoreThreshold: initialRecord.negativeScoreThreshold,
        actionToTake: initialRecord.actionToTake,
        reason: actionReason,
      });

      logInfo('Attempting Redis action lock.', {
        postId,
        actionLockKey: actionLockKey(postId),
      });

      const actionLockWasSet = await redis.set(actionLockKey(postId), '1', {
        nx: true,
        expiration: new Date(now + 60 * 60 * 1000),
      });

      if (actionLockWasSet !== 'OK') {
        logWarn('Action skipped because another check already owns the action lock.', {
          postId,
          actionLockResult: actionLockWasSet,
        });
        return c.json<TaskResponse>({}, 200);
      }

      logInfo('Redis action lock acquired.', {
        postId,
        actionLockResult: actionLockWasSet,
      });

      const latestRecord = await loadTrackedPost(postId);
      if (!latestRecord || latestRecord.status !== 'active' || !fetched) {
        logWarn('Action skipped after lock because latest record is no longer actionable.', {
          postId,
          latestStatus: latestRecord?.status,
          hasFetchedPost: Boolean(fetched),
        });
        return c.json<TaskResponse>({}, 200);
      }

      await writeTrackedPost({
        ...latestRecord,
        status: 'actioning',
        lastKnownScore: fetched.snapshot.score,
        updatedAt: now,
      });

      logInfo('Applying selected moderation action.', {
        postId,
        actionToTake: latestRecord.actionToTake,
        score: fetched.snapshot.score,
        negativeScoreThreshold: latestRecord.negativeScoreThreshold,
        reason: actionReason,
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

      logInfo('Post action complete and audit record written.', {
        postId,
        actionToTake: latestRecord.actionToTake,
        score: fetched.snapshot.score,
        auditKey: auditKey(postId),
        status: 'actioned',
      });

      return c.json<TaskResponse>({}, 200);
    }

    const nextCheckCount = initialRecord.checkCount + 1;
    const nextDelayMinutes = getNextCheckDelayMinutes(nextCheckCount);
    const nextRunAt = getNextCheckRunAt(nextCheckCount, now);
    logInfo('Decision: reschedule because no terminal condition was met.', {
      postId,
      score: fetched?.snapshot.score,
      previousCheckCount: initialRecord.checkCount,
      nextCheckCount,
      nextDelayMinutes,
      nextRunAt,
    });

    const jobId = await scheduler.runJob({
      name: CHECK_WATCHED_POST_TASK,
      data: { postId },
      runAt: nextRunAt,
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

    logInfo('Scheduled next post check.', {
      postId,
      jobId,
      checkCount: nextCheckCount,
      nextDelayMinutes,
      nextRunAt,
      score: updatedRecord.lastKnownScore,
    });
  } catch (err: unknown) {
    await markErrorAndReschedule(initialRecord, err, Date.now());
  }

  return c.json<TaskResponse>({}, 200);
});
