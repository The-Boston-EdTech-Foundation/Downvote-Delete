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
  fetchRedditRatioViaOpenAI,
  type OpenAIRatioFetchResult,
} from '../core/openaiRatio';
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
    lastOpenAIError: parsedRecord.lastOpenAIError,
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
    lastOpenAIError: record.lastOpenAIError,
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
    lastOpenAIError: record.lastOpenAIError,
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

function readOpenAIApiKey(settingsValues: { openaiApiKey?: unknown }): string {
  const value = settingsValues.openaiApiKey;
  return typeof value === 'string' ? value.trim() : '';
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
  apiKey: string;
}): Promise<OpenAIRatioFetchResult> {
  const result = await fetchRedditRatioViaOpenAI({
    apiKey: args.apiKey,
    postId: args.postId,
  });

  if (result.ok) {
    logInfo('Fetched OpenAI-proxied Reddit ratio.', {
      postId: args.postId,
      jsonReceived: result.jsonReceived,
      requestedUrl: result.requestedUrl,
      retrievedUrl: result.retrievedUrl,
      rawName: result.fields?.name,
      rawId: result.fields?.id,
      rawUpvoteRatio: result.fields?.upvoteRatio,
      rawRatioPercent: result.fields?.ratioPercent,
      rawUps: result.fields?.ups,
      rawDowns: result.fields?.downs,
      rawScore: result.fields?.score,
    });
  } else {
    logWarn('OpenAI-proxied Reddit ratio fetch failed.', {
      postId: args.postId,
      jsonReceived: result.jsonReceived,
      requestedUrl: result.requestedUrl,
      retrievedUrl: result.retrievedUrl,
      error: result.error,
    });
  }

  return result;
}

function applyOpenAIRatioResult(
  record: TrackedPost,
  result: OpenAIRatioFetchResult,
  now: number,
  moderatorThreshold: number,
  latestScore: number
): TrackedPost {
  const updatedRecord: TrackedPost = {
    ...record,
    trackingMode: 'advanced',
    lastOpenAIRatioCheckAt: now,
    lastOpenAIRequestedUrl: result.requestedUrl,
    lastOpenAIRetrievedUrl: result.retrievedUrl,
    lastOpenAIJsonReceived: result.jsonReceived,
  };

  if (result.error) {
    updatedRecord.lastOpenAIError = result.error;
  }

  if (!record.advancedTrackingStartedAt) {
    updatedRecord.advancedTrackingStartedAt = now;
  }

  if (!record.enteredAdvancedTrackingAt) {
    updatedRecord.enteredAdvancedTrackingAt = now;
  }

  if (!result.fields || typeof result.fields.upvoteRatio !== 'number') {
    clearFreshRatioDecision(updatedRecord, 'invalid_ratio');
  } else {
    updatedRecord.lastRawUpvoteRatio = result.fields.upvoteRatio;

    const ratioDecision = shouldRemoveByRatio({
      ratio: result.fields.upvoteRatio,
      moderatorThreshold,
      minimumTotalVotes: record.minimumTotalVotes ?? 0,
    });

    updatedRecord.minimumTotalVotes = ratioDecision.updatedMinimumTotalVotes;
    updatedRecord.maximumTotalVotesCap = confidenceModelMaxVotes;
    updatedRecord.guaranteedSpread = ratioDecision.guaranteedSpread;
    updatedRecord.possibleStates = ratioDecision.possibleStates;
    updatedRecord.consecutiveNegativeChecks =
      Number.isFinite(result.fields.upvoteRatio) &&
      result.fields.upvoteRatio <= advancedTrackingMaxRatio
        ? (record.consecutiveNegativeChecks ?? 0) + 1
        : 0;
    updatedRecord.lastRatioDecision = ratioDecision.remove
      ? 'remove'
      : Number.isFinite(result.fields.upvoteRatio) &&
          result.fields.upvoteRatio <= advancedTrackingMaxRatio
        ? 'watch'
        : 'none';
    updatedRecord.lastRatioDecisionReason = ratioDecision.reason;

    logInfo('Advanced vote tracking updated ratio confidence.', {
      postId: record.postId,
      ratio: result.fields.upvoteRatio,
      latestScore,
      minimumTotalVotes: updatedRecord.minimumTotalVotes,
      guaranteedSpread: updatedRecord.guaranteedSpread,
      threshold: moderatorThreshold,
      decision: updatedRecord.lastRatioDecision,
      reason: updatedRecord.lastRatioDecisionReason,
      possibleStateCount: ratioDecision.possibleStates.length,
    });
  }

  if (result.fields) {
    if (result.fields.ratioPercent !== 'missing') {
      updatedRecord.lastRawRatioPercent = result.fields.ratioPercent;
    }

    if (typeof result.fields.score === 'number') {
      updatedRecord.lastRawJsonScore = result.fields.score;
    }

    if (typeof result.fields.ups === 'number') {
      updatedRecord.lastRawJsonUps = result.fields.ups;
    }

    if (typeof result.fields.downs === 'number') {
      updatedRecord.lastRawJsonDowns = result.fields.downs;
    }
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

  if (typeof recordForAction.lastOpenAIRatioCheckAt === 'number') {
    actionRecord.lastOpenAIRatioCheckAt =
      recordForAction.lastOpenAIRatioCheckAt;
  }

  if (typeof recordForAction.lastOpenAIRequestedUrl === 'string') {
    actionRecord.lastOpenAIRequestedUrl =
      recordForAction.lastOpenAIRequestedUrl;
  }

  if (typeof recordForAction.lastOpenAIRetrievedUrl === 'string') {
    actionRecord.lastOpenAIRetrievedUrl =
      recordForAction.lastOpenAIRetrievedUrl;
  }

  if (typeof recordForAction.lastOpenAIJsonReceived === 'boolean') {
    actionRecord.lastOpenAIJsonReceived =
      recordForAction.lastOpenAIJsonReceived;
  }

  if (typeof recordForAction.lastOpenAIError === 'string') {
    actionRecord.lastOpenAIError = recordForAction.lastOpenAIError;
  }

  if (typeof recordForAction.lastRawUpvoteRatio === 'number') {
    actionRecord.lastRawUpvoteRatio = recordForAction.lastRawUpvoteRatio;
  }

  if (typeof recordForAction.lastRawRatioPercent === 'string') {
    actionRecord.lastRawRatioPercent = recordForAction.lastRawRatioPercent;
  }

  if (typeof recordForAction.lastRawJsonScore === 'number') {
    actionRecord.lastRawJsonScore = recordForAction.lastRawJsonScore;
  }

  if (typeof recordForAction.lastRawJsonUps === 'number') {
    actionRecord.lastRawJsonUps = recordForAction.lastRawJsonUps;
  }

  if (typeof recordForAction.lastRawJsonDowns === 'number') {
    actionRecord.lastRawJsonDowns = recordForAction.lastRawJsonDowns;
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

function buildRatioRemovalExplanation(record: TrackedPost): string {
  const parts = [
    "Your post was removed because Reddit's reported upvote ratio indicated sustained negative community feedback.",
  ];

  if (typeof record.guaranteedSpread === 'number') {
    parts.push(
      `The app uses a conservative estimated minimum vote spread; it does not know exact upvote or downvote counts.`
    );
  }

  return parts.join(' ');
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
  removalExplanation?: string;
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

    if (args.removalExplanation) {
      moderationActionArgs.removalExplanation = args.removalExplanation;
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
    const openAIApiKey = readOpenAIApiKey(settingsValues);
    logInfo('Loaded app installation settings for scheduled check.', {
      postId,
      isActive: currentSettings.isActive,
      trackingDurationHours: currentSettings.trackingDurationHours,
      negativeScoreThreshold: currentSettings.negativeScoreThreshold,
      positiveScoreStopThreshold: currentSettings.positiveScoreStopThreshold,
      actionToTake: currentSettings.actionToTake,
      moderatorPostHandling: currentSettings.moderatorPostHandling,
      rawSettingShapes: summarizeSubredditSettingsShapes(settingsValues),
    });
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
        apiKey: openAIApiKey,
      });
      recordForNextCheck = applyOpenAIRatioResult(
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
          removalExplanation: buildRatioRemovalExplanation(recordForNextCheck),
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
      openAIJsonReceived: recordForNextCheck.lastOpenAIJsonReceived,
      openAIError: recordForNextCheck.lastOpenAIError,
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
      openAIJsonReceived: updatedRecord.lastOpenAIJsonReceived,
      openAIError: updatedRecord.lastOpenAIError,
      negativeDecisionScore: updatedRecord.negativeDecisionScore,
      negativeDecisionSource: updatedRecord.negativeDecisionSource,
    });
  } catch (err: unknown) {
    await markErrorAndReschedule(activeRecord, err, Date.now());
  }

  return c.json<TaskResponse>({}, 200);
});
