import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import {
  reddit,
  redis,
  scheduler,
  settings as devvitSettings,
} from '@devvit/web/server';
import type { T3 } from '@devvit/shared-types/tid.js';
import {
  applyModerationAction,
  buildActionReason,
  REMOVAL_MODMAIL_SUBJECT,
  type ModerationActionArgs,
  type ModerationActionResult,
} from '../core/actions';
import { getNextCheckDelayMinutes, getNextCheckRunAt } from '../core/backoff';
import {
  decideTrackedPostCheck,
  getNegativeDecisionScore,
  type NegativeDecisionScore,
  type PostSnapshot,
} from '../core/decision';
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

function buildFallbackPostLink(postId: string, subredditName: string): string {
  return `https://reddit.com/r/${subredditName}/comments/${postId.replace(/^t3_/, '')}`;
}

function buildPostLink(args: {
  postId: string;
  subredditName: string;
  permalink?: string;
}): string {
  if (args.permalink?.startsWith('http')) {
    return args.permalink;
  }

  if (args.permalink?.startsWith('/')) {
    return `https://reddit.com${args.permalink}`;
  }

  return buildFallbackPostLink(args.postId, args.subredditName);
}

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
    lastKnownUpvotes: parsedRecord.lastKnownUpvotes,
    lastKnownDownvotes: parsedRecord.lastKnownDownvotes,
    lastCalculatedVoteScore: parsedRecord.lastCalculatedVoteScore,
    negativeDecisionScore: parsedRecord.negativeDecisionScore,
    negativeDecisionSource: parsedRecord.negativeDecisionSource,
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
    lastKnownUpvotes: record.lastKnownUpvotes,
    lastKnownDownvotes: record.lastKnownDownvotes,
    lastCalculatedVoteScore: record.lastCalculatedVoteScore,
    negativeDecisionScore: record.negativeDecisionScore,
    negativeDecisionSource: record.negativeDecisionSource,
    lastJobId: record.lastJobId,
  });
  await redis.set(redisKey, serializeTrackedPost(record));
}

async function releaseActionLock(postId: string, reason: string): Promise<void> {
  logInfo('Releasing Redis action lock.', {
    postId,
    actionLockKey: actionLockKey(postId),
    reason,
  });
  await redis.del(actionLockKey(postId));
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
    lastKnownUpvotes: record.lastKnownUpvotes,
    lastKnownDownvotes: record.lastKnownDownvotes,
    lastCalculatedVoteScore: record.lastCalculatedVoteScore,
    negativeDecisionScore: record.negativeDecisionScore,
    negativeDecisionSource: record.negativeDecisionSource,
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

function enrichSnapshotWithStoredVotes(
  snapshot: PostSnapshot,
  record: TrackedPost
): PostSnapshot {
  const enrichedSnapshot: PostSnapshot = {
    ...snapshot,
  };

  if (typeof record.lastKnownUpvotes === 'number') {
    enrichedSnapshot.upvotes = record.lastKnownUpvotes;
  }

  if (typeof record.lastKnownDownvotes === 'number') {
    enrichedSnapshot.downvotes = record.lastKnownDownvotes;
  }

  if (typeof record.lastCalculatedVoteScore === 'number') {
    enrichedSnapshot.calculatedVoteScore = record.lastCalculatedVoteScore;
  }

  return enrichedSnapshot;
}

function applyScoreSignals(
  record: TrackedPost,
  snapshot: PostSnapshot | null | undefined,
  negativeDecision: NegativeDecisionScore | undefined
): TrackedPost {
  const updatedRecord: TrackedPost = { ...record };

  if (snapshot) {
    updatedRecord.lastKnownScore = snapshot.score;

    if (typeof snapshot.upvotes === 'number') {
      updatedRecord.lastKnownUpvotes = snapshot.upvotes;
    }

    if (typeof snapshot.downvotes === 'number') {
      updatedRecord.lastKnownDownvotes = snapshot.downvotes;
    }
  }

  if (typeof negativeDecision?.calculatedVoteScore === 'number') {
    updatedRecord.lastCalculatedVoteScore =
      negativeDecision.calculatedVoteScore;
  }

  if (typeof negativeDecision?.score === 'number') {
    updatedRecord.negativeDecisionScore = negativeDecision.score;
    updatedRecord.negativeDecisionSource = negativeDecision.source;
  }

  return updatedRecord;
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

async function scheduleRetryWithoutRecordWrite(
  record: TrackedPost,
  now: number,
  reason: string
): Promise<void> {
  if (now >= record.trackingExpiresAt) {
    logWarn('Retry was not scheduled because tracking window is expired.', {
      postId: record.postId,
      reason,
    });
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

  logInfo('Scheduled retry without rewriting tracking record.', {
    postId: record.postId,
    reason,
    checkCount: record.checkCount,
    nextCheckCount,
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
    const currentSnapshot = fetched
      ? enrichSnapshotWithStoredVotes(fetched.snapshot, initialRecord)
      : null;
    const negativeDecision = currentSnapshot
      ? getNegativeDecisionScore(currentSnapshot)
      : undefined;

    if (currentSnapshot && negativeDecision) {
      logInfo('Computed negative decision score for scheduled check.', {
        postId,
        fetchedScore: currentSnapshot.score,
        storedUpvotes: currentSnapshot.upvotes,
        storedDownvotes: currentSnapshot.downvotes,
        calculatedVoteScore: negativeDecision.calculatedVoteScore,
        negativeDecisionScore: negativeDecision.score,
        negativeDecisionSource: negativeDecision.source,
      });
    }

    const decision = decideTrackedPostCheck({
      tracking: initialRecord,
      settings: currentSettings,
      post: currentSnapshot,
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
        score: currentSnapshot?.score,
        negativeDecisionScore: negativeDecision?.score,
        negativeDecisionSource: negativeDecision?.source,
        checkCount: initialRecord.checkCount,
      });
      await stopTracking(
        applyScoreSignals(initialRecord, currentSnapshot, negativeDecision),
        decision.status,
        now,
        decision.status
      );
      return c.json<TaskResponse>({}, 200);
    }

    if (decision.type === 'action') {
      const actionReason = buildActionReason(
        initialRecord.actionToTake,
        initialRecord.negativeScoreThreshold
      );

      logInfo('Decision: action post because score reached threshold.', {
        postId,
        score: currentSnapshot?.score,
        upvotes: currentSnapshot?.upvotes,
        downvotes: currentSnapshot?.downvotes,
        calculatedVoteScore: negativeDecision?.calculatedVoteScore,
        negativeDecisionScore: negativeDecision?.score,
        negativeDecisionSource: negativeDecision?.source,
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
        const latestRecord = await loadTrackedPost(postId);
        if (latestRecord?.status === 'active') {
          await scheduleRetryWithoutRecordWrite(
            latestRecord,
            Date.now(),
            'action_lock_busy'
          );
        }
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
        await releaseActionLock(postId, 'latest_record_not_actionable');
        return c.json<TaskResponse>({}, 200);
      }

      await writeTrackedPost({
        ...applyScoreSignals(latestRecord, currentSnapshot, negativeDecision),
        status: 'actioning',
        updatedAt: now,
      });

      logInfo('Applying selected moderation action.', {
        postId,
        actionToTake: latestRecord.actionToTake,
        score: currentSnapshot?.score,
        negativeDecisionScore: negativeDecision?.score,
        negativeDecisionSource: negativeDecision?.source,
        negativeScoreThreshold: latestRecord.negativeScoreThreshold,
        reason: actionReason,
      });

      let moderationActionResult: ModerationActionResult = {
        modmailStatus: 'not_applicable',
      };

      try {
        const postLink = buildPostLink({
          postId,
          subredditName: latestRecord.subredditName,
          permalink: fetched.post.permalink,
        });
        const moderationActionArgs: ModerationActionArgs = {
          redditClient: reddit,
          post: fetched.post,
          action: latestRecord.actionToTake,
          threshold: latestRecord.negativeScoreThreshold,
          subredditName: latestRecord.subredditName,
          postLink,
        };

        if (latestRecord.authorName) {
          moderationActionArgs.authorName = latestRecord.authorName;
        }

        if (latestRecord.actionToTake === 'remove') {
          logInfo('Preparing removal modmail notification.', {
            postId,
            authorName: latestRecord.authorName,
            subredditName: latestRecord.subredditName,
            postLink,
            subject: REMOVAL_MODMAIL_SUBJECT,
          });
        }

        moderationActionResult =
          await applyModerationAction(moderationActionArgs);
      } catch (err: unknown) {
        await releaseActionLock(postId, 'moderation_action_failed');
        await markErrorAndReschedule(
          {
            ...applyScoreSignals(latestRecord, currentSnapshot, negativeDecision),
            status: 'active',
          },
          err,
          Date.now()
        );
        return c.json<TaskResponse>({}, 200);
      }

      if (moderationActionResult.modmailStatus === 'sent') {
        logInfo('Removal modmail notification sent.', {
          postId,
          authorName: latestRecord.authorName,
          subredditName: latestRecord.subredditName,
          modmailSentAt: moderationActionResult.modmailSentAt,
        });
      } else if (moderationActionResult.modmailStatus === 'failed') {
        logError(
          'Removal modmail notification failed.',
          {
            postId,
            authorName: latestRecord.authorName,
            subredditName: latestRecord.subredditName,
            modmailErrorMessage: moderationActionResult.modmailErrorMessage,
          },
          moderationActionResult.modmailError
        );
      } else if (moderationActionResult.modmailStatus === 'skipped') {
        logWarn('Removal modmail notification skipped.', {
          postId,
          authorName: latestRecord.authorName,
          subredditName: latestRecord.subredditName,
          reason: moderationActionResult.modmailSkippedReason,
        });
      }

      const actionedRecord: TrackedPost = {
        ...applyScoreSignals(latestRecord, currentSnapshot, negativeDecision),
        status: 'actioned',
        actionedAt: Date.now(),
      };

      actionedRecord.modmailStatus = moderationActionResult.modmailStatus;

      if (typeof moderationActionResult.modmailSentAt === 'number') {
        actionedRecord.modmailSentAt = moderationActionResult.modmailSentAt;
      }

      if (typeof moderationActionResult.modmailSkippedReason === 'string') {
        actionedRecord.modmailSkippedReason =
          moderationActionResult.modmailSkippedReason;
      }

      if (typeof moderationActionResult.modmailErrorMessage === 'string') {
        actionedRecord.modmailErrorMessage =
          moderationActionResult.modmailErrorMessage;
      }

      await stopTracking(
        actionedRecord,
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
        score: currentSnapshot?.score,
        negativeDecisionScore: negativeDecision?.score,
        negativeDecisionSource: negativeDecision?.source,
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
      score: currentSnapshot?.score,
      upvotes: currentSnapshot?.upvotes,
      downvotes: currentSnapshot?.downvotes,
      calculatedVoteScore: negativeDecision?.calculatedVoteScore,
      negativeDecisionScore: negativeDecision?.score,
      negativeDecisionSource: negativeDecision?.source,
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
      ...applyScoreSignals(initialRecord, currentSnapshot, negativeDecision),
      checkCount: nextCheckCount,
      lastJobId: jobId,
      updatedAt: now,
    };

    await writeTrackedPost(updatedRecord);

    logInfo('Scheduled next post check.', {
      postId,
      jobId,
      checkCount: nextCheckCount,
      nextDelayMinutes,
      nextRunAt,
      score: updatedRecord.lastKnownScore,
      upvotes: updatedRecord.lastKnownUpvotes,
      downvotes: updatedRecord.lastKnownDownvotes,
      calculatedVoteScore: updatedRecord.lastCalculatedVoteScore,
      negativeDecisionScore: updatedRecord.negativeDecisionScore,
      negativeDecisionSource: updatedRecord.negativeDecisionSource,
    });
  } catch (err: unknown) {
    await markErrorAndReschedule(initialRecord, err, Date.now());
  }

  return c.json<TaskResponse>({}, 200);
});
