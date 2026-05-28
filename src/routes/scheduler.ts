import { Hono } from 'hono';
import type {
  SettingsValues,
  TaskRequest,
  TaskResponse,
} from '@devvit/web/server';
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
import {
  fetchAuthenticatedRedditVoteSnapshot,
  readRedditOAuthConfigFromSettings,
  type AuthenticatedRedditVoteSnapshot,
  type RedditOAuthConfig,
} from '../core/redditOAuthRatio';
import { postToSnapshot } from '../core/postStatus';
import {
  normalizeSettings,
  summarizeSubredditSettingsShapes,
} from '../core/settings';
import {
  auditKey,
  createAuditRecord,
  parseTrackedPost,
  refreshTrackedPostActionSettings,
  serializeTrackedPost,
  statsKey,
  type TrackedPost,
  type TrackingStatus,
  watchKey,
} from '../core/tracking';
import {
  advancedTrackingMaxRatio,
  confidenceModelMaxVotes,
  shouldRemoveByRatio,
  type RatioDecision,
} from '../core/voteRatioModel';
import { CHECK_WATCHED_POST_TASK } from './triggers';

type CheckWatchedPostData = {
  postId?: string;
};

type FetchedPostSnapshot = {
  post: Awaited<ReturnType<typeof reddit.getPostById>>;
  snapshot: PostSnapshot;
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
    trackingMode: parsedRecord.trackingMode,
    lastKnownScore: parsedRecord.lastKnownScore,
    lastRawUpvoteRatio: parsedRecord.lastRawUpvoteRatio,
    lastRawRatioPercent: parsedRecord.lastRawRatioPercent,
    minimumTotalVotes: parsedRecord.minimumTotalVotes,
    guaranteedSpread: parsedRecord.guaranteedSpread,
    lastRatioDecision: parsedRecord.lastRatioDecision,
    lastRatioDecisionReason: parsedRecord.lastRatioDecisionReason,
    lastAuthenticatedRatioError: parsedRecord.lastAuthenticatedRatioError,
    lastAuthenticatedRatioSource: parsedRecord.lastAuthenticatedRatioSource,
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
    trackingMode: record.trackingMode,
    lastKnownScore: record.lastKnownScore,
    lastRawUpvoteRatio: record.lastRawUpvoteRatio,
    lastRawRatioPercent: record.lastRawRatioPercent,
    minimumTotalVotes: record.minimumTotalVotes,
    guaranteedSpread: record.guaranteedSpread,
    lastRatioDecision: record.lastRatioDecision,
    lastRatioDecisionReason: record.lastRatioDecisionReason,
    lastAuthenticatedRatioError: record.lastAuthenticatedRatioError,
    lastAuthenticatedRatioSource: record.lastAuthenticatedRatioSource,
    negativeDecisionScore: record.negativeDecisionScore,
    negativeDecisionSource: record.negativeDecisionSource,
    negativeScoreThreshold: record.negativeScoreThreshold,
    positiveScoreStopThreshold: record.positiveScoreStopThreshold,
    actionToTake: record.actionToTake,
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
    trackingMode: record.trackingMode,
    lastKnownScore: record.lastKnownScore,
    lastRawUpvoteRatio: record.lastRawUpvoteRatio,
    lastRawRatioPercent: record.lastRawRatioPercent,
    minimumTotalVotes: record.minimumTotalVotes,
    guaranteedSpread: record.guaranteedSpread,
    lastRatioDecision: record.lastRatioDecision,
    lastRatioDecisionReason: record.lastRatioDecisionReason,
    lastAuthenticatedRatioError: record.lastAuthenticatedRatioError,
    lastAuthenticatedRatioSource: record.lastAuthenticatedRatioSource,
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
): Promise<FetchedPostSnapshot | null> {
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

function applyScoreSignals(
  record: TrackedPost,
  snapshot: PostSnapshot | null | undefined,
  negativeDecision: NegativeDecisionScore | undefined
): TrackedPost {
  const updatedRecord: TrackedPost = { ...record };

  if (snapshot) {
    updatedRecord.lastKnownScore = snapshot.score;
  }

  if (typeof negativeDecision?.score === 'number') {
    updatedRecord.negativeDecisionScore = negativeDecision.score;
    updatedRecord.negativeDecisionSource = negativeDecision.source;
  }

  return updatedRecord;
}

function shouldUseAdvancedTracking(snapshot: PostSnapshot | null): boolean {
  return Boolean(snapshot && snapshot.score <= 0);
}

function clearFreshRatioDecision(
  record: TrackedPost,
  reason: 'invalid_ratio' | 'no_possible_states_after_filter'
): void {
  record.lastRatioDecision = 'none';
  record.lastRatioDecisionReason = reason;
  record.guaranteedSpread = null;
  record.possibleStates = [];
}

async function fetchAndLogRawRatio(args: {
  postId: string;
  config: RedditOAuthConfig | null;
}): Promise<AuthenticatedRedditVoteSnapshot> {
  logInfo('Fetching authenticated Reddit ratio.', {
    postId: args.postId,
    source: 'authenticated_reddit_api',
    endpoint: 'oauth_by_id',
  });

  const result = await fetchAuthenticatedRedditVoteSnapshot(args.postId, {
    config: args.config,
  });

  if (result.ok) {
    logInfo('Authenticated Reddit ratio fetched.', {
      postId: args.postId,
      ok: true,
      source: result.source,
      rawName: result.rawName,
      rawId: result.rawId,
      rawScore: result.score,
      rawUpvoteRatio: result.upvoteRatio,
      rawRatioPercent: result.ratioPercent,
      rawHideScore: result.hideScore,
      rawUps: result.ups,
      rawDowns: result.downs,
    });
  } else {
    logWarn('Authenticated Reddit ratio fetch failed.', {
      postId: args.postId,
      ok: false,
      source: result.source,
      httpStatus: result.httpStatus,
      error: result.error,
      fallback: 'reddit_score_only',
    });
  }

  if (result.ok && result.upvoteRatio === null) {
    logInfo('Authenticated Reddit ratio unavailable.', {
      postId: args.postId,
      ok: true,
      source: result.source,
      reason: 'missing_upvote_ratio',
      fallback: 'reddit_score_only',
    });
  }

  return result;
}

function applyAuthenticatedRatioResult(
  record: TrackedPost,
  result: AuthenticatedRedditVoteSnapshot,
  now: number,
  moderatorThreshold: number,
  latestScore: number
): TrackedPost {
  const updatedRecord: TrackedPost = {
    ...record,
    trackingMode: 'advanced',
    lastAuthenticatedRatioCheckAt: now,
    lastAuthenticatedRatioReceived: result.ok,
    lastAuthenticatedRatioSource: result.source,
  };

  if (result.error) {
    updatedRecord.lastAuthenticatedRatioError = result.error;
  }

  if (typeof result.httpStatus === 'number') {
    updatedRecord.lastAuthenticatedRatioHttpStatus = result.httpStatus;
  }

  if (result.rawName) {
    updatedRecord.lastAuthenticatedRatioRawName = result.rawName;
  }

  if (result.rawId) {
    updatedRecord.lastAuthenticatedRatioRawId = result.rawId;
  }

  if (typeof result.hideScore === 'boolean') {
    updatedRecord.lastAuthenticatedRatioHideScore = result.hideScore;
  }

  if (!record.advancedTrackingStartedAt) {
    updatedRecord.advancedTrackingStartedAt = now;
  }

  if (!record.enteredAdvancedTrackingAt) {
    updatedRecord.enteredAdvancedTrackingAt = now;
  }

  if (!result.ok || typeof result.upvoteRatio !== 'number') {
    clearFreshRatioDecision(updatedRecord, 'invalid_ratio');
    logInfo('Advanced vote tracking did not use a fresh ratio.', {
      postId: record.postId,
      freshRatioUsed: false,
      previousRawUpvoteRatio: record.lastRawUpvoteRatio,
      newRawUpvoteRatio: undefined,
      lastRatioDecision: updatedRecord.lastRatioDecision,
      lastRatioDecisionReason: updatedRecord.lastRatioDecisionReason,
      error: result.error,
      httpStatus: result.httpStatus,
      ratioSource: result.source,
      note: 'Previous raw ratio is historical and was not used for this check.',
    });
  } else {
    const previousRawUpvoteRatio = record.lastRawUpvoteRatio;
    updatedRecord.lastRawUpvoteRatio = result.upvoteRatio;

    const ratioDecision = shouldRemoveByRatio({
      ratio: result.upvoteRatio,
      moderatorThreshold,
      minimumTotalVotes: record.minimumTotalVotes ?? 0,
    });

    updatedRecord.minimumTotalVotes = ratioDecision.updatedMinimumTotalVotes;
    updatedRecord.maximumTotalVotesCap = confidenceModelMaxVotes;
    updatedRecord.guaranteedSpread = ratioDecision.guaranteedSpread;
    updatedRecord.possibleStates = ratioDecision.possibleStates;
    updatedRecord.consecutiveNegativeChecks =
      Number.isFinite(result.upvoteRatio) &&
      result.upvoteRatio <= advancedTrackingMaxRatio
        ? (record.consecutiveNegativeChecks ?? 0) + 1
        : 0;
    updatedRecord.lastRatioDecision = ratioDecision.remove
      ? 'remove'
      : Number.isFinite(result.upvoteRatio) &&
          result.upvoteRatio <= advancedTrackingMaxRatio
        ? 'watch'
        : 'none';
    updatedRecord.lastRatioDecisionReason = ratioDecision.reason;

    logInfo('Advanced vote tracking updated ratio confidence.', {
      postId: record.postId,
      freshRatioUsed: true,
      previousRawUpvoteRatio,
      newRawUpvoteRatio: updatedRecord.lastRawUpvoteRatio,
      ratio: result.upvoteRatio,
      ratioSource: result.source,
      latestScore,
      minimumTotalVotes: updatedRecord.minimumTotalVotes,
      guaranteedSpread: updatedRecord.guaranteedSpread,
      threshold: moderatorThreshold,
      decision: updatedRecord.lastRatioDecision,
      reason: updatedRecord.lastRatioDecisionReason,
      possibleStateCount: ratioDecision.possibleStates.length,
    });
  }

  if (typeof result.ratioPercent === 'string') {
    updatedRecord.lastRawRatioPercent = result.ratioPercent;
  }

  if (typeof result.score === 'number') {
    updatedRecord.lastRawAuthenticatedScore = result.score;
  }

  if (typeof result.ups === 'number') {
    updatedRecord.lastRawAuthenticatedUps = result.ups;
  }

  if (typeof result.downs === 'number') {
    updatedRecord.lastRawAuthenticatedDowns = result.downs;
  }

  return updatedRecord;
}

function mergeFreshActionFields(
  latestRecord: TrackedPost,
  recordForAction: TrackedPost
): TrackedPost {
  const actionRecord: TrackedPost = {
    ...latestRecord,
    status: latestRecord.status,
  };

  if (recordForAction.trackingMode) {
    actionRecord.trackingMode = recordForAction.trackingMode;
  }

  actionRecord.negativeScoreThreshold = recordForAction.negativeScoreThreshold;
  actionRecord.positiveScoreStopThreshold =
    recordForAction.positiveScoreStopThreshold;
  actionRecord.actionToTake = recordForAction.actionToTake;
  actionRecord.moderatorPostHandling = recordForAction.moderatorPostHandling;

  if (typeof recordForAction.lastKnownScore === 'number') {
    actionRecord.lastKnownScore = recordForAction.lastKnownScore;
  }

  if (typeof recordForAction.negativeDecisionScore === 'number') {
    actionRecord.negativeDecisionScore = recordForAction.negativeDecisionScore;
  }

  if (recordForAction.negativeDecisionSource) {
    actionRecord.negativeDecisionSource =
      recordForAction.negativeDecisionSource;
  }

  if (typeof recordForAction.advancedTrackingStartedAt === 'number') {
    actionRecord.advancedTrackingStartedAt =
      recordForAction.advancedTrackingStartedAt;
  }

  if (typeof recordForAction.lastAuthenticatedRatioCheckAt === 'number') {
    actionRecord.lastAuthenticatedRatioCheckAt =
      recordForAction.lastAuthenticatedRatioCheckAt;
  }

  if (typeof recordForAction.lastAuthenticatedRatioReceived === 'boolean') {
    actionRecord.lastAuthenticatedRatioReceived =
      recordForAction.lastAuthenticatedRatioReceived;
  }

  if (recordForAction.lastAuthenticatedRatioSource) {
    actionRecord.lastAuthenticatedRatioSource =
      recordForAction.lastAuthenticatedRatioSource;
  }

  if (typeof recordForAction.lastAuthenticatedRatioError === 'string') {
    actionRecord.lastAuthenticatedRatioError =
      recordForAction.lastAuthenticatedRatioError;
  }

  if (typeof recordForAction.lastAuthenticatedRatioHttpStatus === 'number') {
    actionRecord.lastAuthenticatedRatioHttpStatus =
      recordForAction.lastAuthenticatedRatioHttpStatus;
  }

  if (typeof recordForAction.lastAuthenticatedRatioRawName === 'string') {
    actionRecord.lastAuthenticatedRatioRawName =
      recordForAction.lastAuthenticatedRatioRawName;
  }

  if (typeof recordForAction.lastAuthenticatedRatioRawId === 'string') {
    actionRecord.lastAuthenticatedRatioRawId =
      recordForAction.lastAuthenticatedRatioRawId;
  }

  if (typeof recordForAction.lastAuthenticatedRatioHideScore === 'boolean') {
    actionRecord.lastAuthenticatedRatioHideScore =
      recordForAction.lastAuthenticatedRatioHideScore;
  }

  if (typeof recordForAction.lastRawUpvoteRatio === 'number') {
    actionRecord.lastRawUpvoteRatio = recordForAction.lastRawUpvoteRatio;
  }

  if (typeof recordForAction.lastRawRatioPercent === 'string') {
    actionRecord.lastRawRatioPercent = recordForAction.lastRawRatioPercent;
  }

  if (typeof recordForAction.lastRawAuthenticatedScore === 'number') {
    actionRecord.lastRawAuthenticatedScore =
      recordForAction.lastRawAuthenticatedScore;
  }

  if (typeof recordForAction.lastRawAuthenticatedUps === 'number') {
    actionRecord.lastRawAuthenticatedUps = recordForAction.lastRawAuthenticatedUps;
  }

  if (typeof recordForAction.lastRawAuthenticatedDowns === 'number') {
    actionRecord.lastRawAuthenticatedDowns =
      recordForAction.lastRawAuthenticatedDowns;
  }

  if (typeof recordForAction.minimumTotalVotes === 'number') {
    actionRecord.minimumTotalVotes = recordForAction.minimumTotalVotes;
  }

  if (typeof recordForAction.maximumTotalVotesCap === 'number') {
    actionRecord.maximumTotalVotesCap = recordForAction.maximumTotalVotesCap;
  }

  actionRecord.guaranteedSpread = recordForAction.guaranteedSpread ?? null;

  if (recordForAction.possibleStates) {
    actionRecord.possibleStates = recordForAction.possibleStates;
  }

  if (typeof recordForAction.enteredAdvancedTrackingAt === 'number') {
    actionRecord.enteredAdvancedTrackingAt =
      recordForAction.enteredAdvancedTrackingAt;
  }

  if (typeof recordForAction.consecutiveNegativeChecks === 'number') {
    actionRecord.consecutiveNegativeChecks =
      recordForAction.consecutiveNegativeChecks;
  }

  if (recordForAction.lastRatioDecision) {
    actionRecord.lastRatioDecision = recordForAction.lastRatioDecision;
  }

  if (recordForAction.lastRatioDecisionReason) {
    actionRecord.lastRatioDecisionReason =
      recordForAction.lastRatioDecisionReason;
  }

  return actionRecord;
}

function getRatioDecision(record: TrackedPost): RatioDecision | undefined {
  if (
    record.lastRatioDecisionReason === undefined ||
    record.minimumTotalVotes === undefined ||
    record.possibleStates === undefined
  ) {
    return undefined;
  }

  return {
    remove: record.lastRatioDecision === 'remove',
    reason: record.lastRatioDecisionReason,
    updatedMinimumTotalVotes: record.minimumTotalVotes,
    guaranteedSpread: record.guaranteedSpread ?? null,
    possibleStates: record.possibleStates,
  };
}

function buildRatioActionReason(action: TrackedPost['actionToTake']): string {
  if (action === 'report') {
    return 'Reported for downvote ratio threshold';
  }

  if (action === 'filter') {
    return 'Filtered for downvote ratio threshold';
  }

  return 'Removed for downvote ratio threshold';
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
  const cadence = record.trackingMode === 'advanced' ? 'advanced' : 'normal';
  const nextRunAt = getNextCheckRunAt(nextCheckCount, now, cadence);
  const nextDelayMinutes = getNextCheckDelayMinutes(nextCheckCount, cadence);
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
  const cadence = record.trackingMode === 'advanced' ? 'advanced' : 'normal';
  const nextRunAt = getNextCheckRunAt(nextCheckCount, now, cadence);
  const nextDelayMinutes = getNextCheckDelayMinutes(nextCheckCount, cadence);
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

async function actionTrackedPost(args: {
  postId: string;
  fetched: FetchedPostSnapshot;
  recordForAction: TrackedPost;
  currentSnapshot: PostSnapshot | null;
  negativeDecision: NegativeDecisionScore | undefined;
  now: number;
  actionReason: string;
  stopReason: string;
}): Promise<void> {
  logInfo('Attempting Redis action lock.', {
    postId: args.postId,
    actionLockKey: actionLockKey(args.postId),
  });

  const actionLockWasSet = await redis.set(actionLockKey(args.postId), '1', {
    nx: true,
    expiration: new Date(args.now + 60 * 60 * 1000),
  });

  if (actionLockWasSet !== 'OK') {
    logWarn('Action skipped because another check already owns the action lock.', {
      postId: args.postId,
      actionLockResult: actionLockWasSet,
    });
    const latestRecord = await loadTrackedPost(args.postId);
    if (latestRecord?.status === 'active') {
      await scheduleRetryWithoutRecordWrite(
        latestRecord,
        Date.now(),
        'action_lock_busy'
      );
    }
    return;
  }

  logInfo('Redis action lock acquired.', {
    postId: args.postId,
    actionLockResult: actionLockWasSet,
  });

  const latestRecord = await loadTrackedPost(args.postId);
  if (!latestRecord || latestRecord.status !== 'active') {
    logWarn('Action skipped after lock because latest record is no longer actionable.', {
      postId: args.postId,
      latestStatus: latestRecord?.status,
      hasFetchedPost: true,
    });
    await releaseActionLock(args.postId, 'latest_record_not_actionable');
    return;
  }

  const actionRecord = mergeFreshActionFields(
    latestRecord,
    args.recordForAction
  );

  await writeTrackedPost({
    ...applyScoreSignals(actionRecord, args.currentSnapshot, args.negativeDecision),
    status: 'actioning',
    updatedAt: args.now,
  });

  logInfo('Applying selected moderation action.', {
    postId: args.postId,
    actionToTake: actionRecord.actionToTake,
    score: args.currentSnapshot?.score,
    calculatedVoteScore: args.negativeDecision?.calculatedVoteScore,
    negativeDecisionScore: args.negativeDecision?.score,
    negativeDecisionSource: args.negativeDecision?.source,
    rawUpvoteRatio: actionRecord.lastRawUpvoteRatio,
    minimumTotalVotes: actionRecord.minimumTotalVotes,
    guaranteedSpread: actionRecord.guaranteedSpread,
    threshold: actionRecord.negativeScoreThreshold,
    ratioDecisionReason: actionRecord.lastRatioDecisionReason,
    reason: args.actionReason,
  });

  let moderationActionResult: ModerationActionResult = {
    modmailStatus: 'not_applicable',
  };

  try {
    const postLink = buildPostLink({
      postId: args.postId,
      subredditName: actionRecord.subredditName,
      permalink: args.fetched.post.permalink,
    });
    const moderationActionArgs: ModerationActionArgs = {
      redditClient: reddit,
      post: args.fetched.post,
      action: actionRecord.actionToTake,
      threshold: actionRecord.negativeScoreThreshold,
      subredditName: actionRecord.subredditName,
      postLink,
      reason: args.actionReason,
    };

    if (actionRecord.authorName) {
      moderationActionArgs.authorName = actionRecord.authorName;
    }

    if (actionRecord.actionToTake === 'remove') {
      logInfo('Preparing removal modmail notification.', {
        postId: args.postId,
        authorName: actionRecord.authorName,
        subredditName: actionRecord.subredditName,
        postLink,
        subject: REMOVAL_MODMAIL_SUBJECT,
      });
    }

    moderationActionResult = await applyModerationAction(moderationActionArgs);
  } catch (err: unknown) {
    await releaseActionLock(args.postId, 'moderation_action_failed');
    await markErrorAndReschedule(
      {
        ...applyScoreSignals(actionRecord, args.currentSnapshot, args.negativeDecision),
        status: 'active',
      },
      err,
      Date.now()
    );
    return;
  }

  if (moderationActionResult.modmailStatus === 'sent') {
    logInfo('Removal modmail notification sent.', {
      postId: args.postId,
      authorName: actionRecord.authorName,
      subredditName: actionRecord.subredditName,
      modmailSentAt: moderationActionResult.modmailSentAt,
    });
  } else if (moderationActionResult.modmailStatus === 'failed') {
    logError(
      'Removal modmail notification failed.',
      {
        postId: args.postId,
        authorName: actionRecord.authorName,
        subredditName: actionRecord.subredditName,
        modmailErrorMessage: moderationActionResult.modmailErrorMessage,
      },
      moderationActionResult.modmailError
    );
  } else if (moderationActionResult.modmailStatus === 'skipped') {
    logWarn('Removal modmail notification skipped.', {
      postId: args.postId,
      authorName: actionRecord.authorName,
      subredditName: actionRecord.subredditName,
      reason: moderationActionResult.modmailSkippedReason,
    });
  }

  const actionedRecord: TrackedPost = {
    ...applyScoreSignals(actionRecord, args.currentSnapshot, args.negativeDecision),
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
    args.stopReason
  );
  await redis.hIncrBy(
    statsKey(actionRecord.subredditId),
    `action_${actionRecord.actionToTake}`,
    1
  );

  logInfo('Post action complete and audit record written.', {
    postId: args.postId,
    actionToTake: actionRecord.actionToTake,
    score: args.currentSnapshot?.score,
    calculatedVoteScore: args.negativeDecision?.calculatedVoteScore,
    negativeDecisionScore: args.negativeDecision?.score,
    negativeDecisionSource: args.negativeDecision?.source,
    rawUpvoteRatio: actionRecord.lastRawUpvoteRatio,
    minimumTotalVotes: actionRecord.minimumTotalVotes,
    guaranteedSpread: actionRecord.guaranteedSpread,
    threshold: actionRecord.negativeScoreThreshold,
    ratioDecisionReason: actionRecord.lastRatioDecisionReason,
    auditKey: auditKey(args.postId),
    status: 'actioned',
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
  let activeRecord = initialRecord;

  try {
    logInfo('Reading app installation settings for scheduled check.', { postId });
    const settingsValues = await devvitSettings.getAll<SettingsValues>();
    const currentSettings = normalizeSettings(settingsValues);
    const redditOAuthConfig = readRedditOAuthConfigFromSettings(
      settingsValues as Record<string, unknown>
    );
    logInfo('Loaded app installation settings for scheduled check.', {
      postId,
      isActive: currentSettings.isActive,
      trackingDurationHours: currentSettings.trackingDurationHours,
      negativeScoreThreshold: currentSettings.negativeScoreThreshold,
      positiveScoreStopThreshold: currentSettings.positiveScoreStopThreshold,
      actionToTake: currentSettings.actionToTake,
      moderatorPostHandling: currentSettings.moderatorPostHandling,
      authenticatedRatioConfigured: redditOAuthConfig !== null,
      rawSettingShapes: summarizeSubredditSettingsShapes(settingsValues),
    });
    if (!redditOAuthConfig) {
      logWarn(
        'Authenticated Reddit ratio disabled because required secrets are missing.',
        {
          postId,
          source: 'authenticated_reddit_api',
          fallback: 'reddit_score_only',
        }
      );
    }
    activeRecord = refreshTrackedPostActionSettings(
      initialRecord,
      currentSettings
    );
    logInfo('Refreshed active tracking record from current settings.', {
      postId,
      storedNegativeScoreThreshold: initialRecord.negativeScoreThreshold,
      activeNegativeScoreThreshold: activeRecord.negativeScoreThreshold,
      storedPositiveScoreStopThreshold: initialRecord.positiveScoreStopThreshold,
      activePositiveScoreStopThreshold: activeRecord.positiveScoreStopThreshold,
      storedActionToTake: initialRecord.actionToTake,
      activeActionToTake: activeRecord.actionToTake,
      trackingExpiresAt: new Date(activeRecord.trackingExpiresAt),
    });

    const fetched = await fetchPostSnapshot(postId);
    if (!fetched) {
      logWarn('Decision: retry because Reddit post fetch failed.', {
        postId,
        reason: 'fetch_failed_retrying',
        checkCount: activeRecord.checkCount,
      });
      await markErrorAndReschedule(
        activeRecord,
        new Error('fetch_failed_retrying'),
        now
      );
      return c.json<TaskResponse>({}, 200);
    }

    const currentSnapshot = fetched ? fetched.snapshot : null;
    const negativeDecision = currentSnapshot
      ? getNegativeDecisionScore(currentSnapshot)
      : undefined;

    if (currentSnapshot && negativeDecision) {
      logInfo('Computed negative decision score for scheduled check.', {
        postId,
        fetchedScore: currentSnapshot.score,
        calculatedVoteScore: negativeDecision.calculatedVoteScore,
        negativeDecisionScore: negativeDecision.score,
        negativeDecisionSource: negativeDecision.source,
      });
    }

    const decision = decideTrackedPostCheck({
      tracking: activeRecord,
      settings: currentSettings,
      post: currentSnapshot,
      now,
    });

    if (decision.type === 'exit') {
      logInfo('Decision: exit without action.', {
        postId,
        status: activeRecord.status,
        reason: 'decision_exit',
      });
      return c.json<TaskResponse>({}, 200);
    }

    if (decision.type === 'stop') {
      const stopLogReason =
        decision.status === 'stopped_invalid'
          ? 'post_invalid_stopping'
          : decision.status === 'stopped_removed'
            ? 'post_removed_or_spam_stopping'
            : decision.status;
      logInfo('Decision: stop tracking.', {
        postId,
        status: decision.status,
        reason: stopLogReason,
        score: currentSnapshot?.score,
        negativeDecisionScore: negativeDecision?.score,
        negativeDecisionSource: negativeDecision?.source,
        checkCount: activeRecord.checkCount,
      });
      await stopTracking(
        applyScoreSignals(activeRecord, currentSnapshot, negativeDecision),
        decision.status,
        now,
        decision.status
      );
      return c.json<TaskResponse>({}, 200);
    }

    if (decision.type === 'action') {
      const actionReason = buildActionReason(
        activeRecord.actionToTake,
        activeRecord.negativeScoreThreshold
      );

      logInfo('Decision: action post because score reached threshold.', {
        postId,
        score: currentSnapshot?.score,
        calculatedVoteScore: negativeDecision?.calculatedVoteScore,
        negativeDecisionScore: negativeDecision?.score,
        negativeDecisionSource: negativeDecision?.source,
        negativeScoreThreshold: activeRecord.negativeScoreThreshold,
        actionToTake: activeRecord.actionToTake,
        reason: actionReason,
      });

      if (fetched) {
        await actionTrackedPost({
          postId,
          fetched,
          recordForAction: activeRecord,
          currentSnapshot,
          negativeDecision,
          now,
          actionReason,
          stopReason: activeRecord.actionToTake,
        });
      }

      return c.json<TaskResponse>({}, 200);
    }

    const nextCheckCount = activeRecord.checkCount + 1;
    const advancedTracking = shouldUseAdvancedTracking(currentSnapshot);
    let recordForNextCheck = applyScoreSignals(
      activeRecord,
      currentSnapshot,
      negativeDecision
    );

    if (advancedTracking) {
      const ratioResult = await fetchAndLogRawRatio({
        postId,
        config: redditOAuthConfig,
      });
      recordForNextCheck = applyAuthenticatedRatioResult(
        recordForNextCheck,
        ratioResult,
        now,
        activeRecord.negativeScoreThreshold,
        currentSnapshot?.score ?? 0
      );

      const ratioDecision = getRatioDecision(recordForNextCheck);
      if (ratioDecision?.remove && fetched) {
        const actionReason = buildRatioActionReason(
          recordForNextCheck.actionToTake
        );
        logInfo('Decision: action post because ratio confidence threshold was met.', {
          postId,
          rawUpvoteRatio: recordForNextCheck.lastRawUpvoteRatio,
          minimumTotalVotes: recordForNextCheck.minimumTotalVotes,
          guaranteedSpread: recordForNextCheck.guaranteedSpread,
          threshold: recordForNextCheck.negativeScoreThreshold,
          ratioDecisionReason: recordForNextCheck.lastRatioDecisionReason,
          ratioSource: recordForNextCheck.lastAuthenticatedRatioSource,
          possibleStateCount: recordForNextCheck.possibleStates?.length,
          actionToTake: recordForNextCheck.actionToTake,
          reason: actionReason,
        });
        await actionTrackedPost({
          postId,
          fetched,
          recordForAction: recordForNextCheck,
          currentSnapshot,
          negativeDecision,
          now,
          actionReason,
          stopReason: recordForNextCheck.lastRatioDecisionReason ?? 'ratio_action',
        });
        return c.json<TaskResponse>({}, 200);
      }
    } else {
      recordForNextCheck = {
        ...recordForNextCheck,
        trackingMode: 'normal',
      };
    }

    const nextCadence = advancedTracking ? 'advanced' : 'normal';
    const nextDelayMinutes = getNextCheckDelayMinutes(
      nextCheckCount,
      nextCadence
    );
    const nextRunAt = getNextCheckRunAt(nextCheckCount, now, nextCadence);
    logInfo('Decision: reschedule because no terminal condition was met.', {
      postId,
      score: currentSnapshot?.score,
      calculatedVoteScore: negativeDecision?.calculatedVoteScore,
      negativeDecisionScore: negativeDecision?.score,
      negativeDecisionSource: negativeDecision?.source,
      trackingMode: recordForNextCheck.trackingMode,
      rawUpvoteRatio: recordForNextCheck.lastRawUpvoteRatio,
      rawRatioPercent: recordForNextCheck.lastRawRatioPercent,
      authenticatedRatioReceived:
        recordForNextCheck.lastAuthenticatedRatioReceived,
      authenticatedRatioSource: recordForNextCheck.lastAuthenticatedRatioSource,
      authenticatedRatioError: recordForNextCheck.lastAuthenticatedRatioError,
      previousCheckCount: activeRecord.checkCount,
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
      ...recordForNextCheck,
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
      trackingMode: updatedRecord.trackingMode,
      score: updatedRecord.lastKnownScore,
      rawUpvoteRatio: updatedRecord.lastRawUpvoteRatio,
      rawRatioPercent: updatedRecord.lastRawRatioPercent,
      authenticatedRatioReceived: updatedRecord.lastAuthenticatedRatioReceived,
      authenticatedRatioSource: updatedRecord.lastAuthenticatedRatioSource,
      authenticatedRatioError: updatedRecord.lastAuthenticatedRatioError,
      negativeDecisionScore: updatedRecord.negativeDecisionScore,
      negativeDecisionSource: updatedRecord.negativeDecisionSource,
    });
  } catch (err: unknown) {
    await markErrorAndReschedule(activeRecord, err, Date.now());
  }

  return c.json<TaskResponse>({}, 200);
});
