import { Hono } from 'hono';
import type {
  OnPostSubmitRequest,
  OnPostUpdateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import {
  reddit,
  redis,
  scheduler,
  settings as devvitSettings,
} from '@devvit/web/server';
import { getNextCheckRunAt } from '../core/backoff';
import { logError, logInfo, logWarn } from '../core/logging';
import {
  normalizeSettings,
  type DownvoteDeleteSettings,
} from '../core/settings';
import { calculateVoteScore, shouldTrackNewPost } from '../core/decision';
import {
  applyActiveTrackingVoteSignalUpdate,
  parseTrackedPost,
  serializeTrackedPost,
  statsKey,
  type TrackedPost,
  type TrackingVoteSignalUpdate,
  watchKey,
} from '../core/tracking';

export const triggers = new Hono();

const CHECK_WATCHED_POST_TASK = 'checkWatchedPost';

function getPostId(input: OnPostSubmitRequest): string | undefined {
  return input.post?.id;
}

function getPostCreatedAt(input: OnPostSubmitRequest, now: number): number {
  return input.post?.createdAt ? input.post.createdAt * 1000 : now;
}

function getRuntimeNumberField(
  source: object | undefined,
  fieldName: string
): number | undefined {
  if (!source) {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[fieldName];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function getPostVoteCounts(post: { upvotes?: number; downvotes?: number }) {
  const voteCounts: {
    upvotes?: number;
    downvotes?: number;
    calculatedVoteScore?: number;
  } = {};

  if (typeof post.upvotes === 'number') {
    voteCounts.upvotes = post.upvotes;
  }

  if (typeof post.downvotes === 'number') {
    voteCounts.downvotes = post.downvotes;
  }

  const calculatedVoteScore = calculateVoteScore(voteCounts);
  if (typeof calculatedVoteScore === 'number') {
    voteCounts.calculatedVoteScore = calculatedVoteScore;
  }

  return voteCounts;
}

function getPostVoteSignalUpdate(post: {
  score?: number;
  upvotes?: number;
  downvotes?: number;
} & object): TrackingVoteSignalUpdate {
  const voteCounts = getPostVoteCounts(post);
  const update: TrackingVoteSignalUpdate = {
    ...voteCounts,
  };

  if (typeof post.score === 'number') {
    update.score = post.score;
  }

  const upvoteRatio = getRuntimeNumberField(post, 'upvoteRatio');
  if (typeof upvoteRatio === 'number') {
    update.upvoteRatio = upvoteRatio;
  }

  return update;
}

async function loadTrackedPostForTrigger(
  postId: string
): Promise<TrackedPost | null> {
  const redisKey = watchKey(postId);
  logInfo('Pulling tracking record from Redis for trigger update.', {
    postId,
    redisKey,
  });

  const rawRecord = await redis.get(redisKey);
  const parsedRecord = parseTrackedPost(rawRecord);

  if (!rawRecord) {
    logInfo('No active tracking record found for trigger update.', {
      postId,
      redisKey,
    });
    return null;
  }

  if (!parsedRecord) {
    logError('Tracking record for trigger update is malformed.', {
      postId,
      redisKey,
      rawLength: rawRecord.length,
    });
    return null;
  }

  logInfo('Loaded tracking record for trigger update.', {
    postId,
    redisKey,
    status: parsedRecord.status,
    checkCount: parsedRecord.checkCount,
  });

  return parsedRecord;
}

async function isModeratorPost(args: {
  authorName: string | undefined;
  subredditName: string | undefined;
}): Promise<boolean> {
  if (!args.authorName || !args.subredditName) {
    logInfo('Moderator detection skipped because author or subreddit is missing.', {
      authorName: args.authorName,
      subredditName: args.subredditName,
    });
    return false;
  }

  logInfo('Checking whether post author is a moderator.', {
    authorName: args.authorName,
    subredditName: args.subredditName,
  });

  const moderators = await reddit
    .getModerators({
      subredditName: args.subredditName,
      username: args.authorName,
      limit: 1,
      pageSize: 1,
    })
    .all();

  const moderatorPost = moderators.some(
    (moderator) => moderator.username === args.authorName
  );

  logInfo('Moderator detection complete.', {
    authorName: args.authorName,
    subredditName: args.subredditName,
    isModeratorPost: moderatorPost,
  });

  return moderatorPost;
}

async function readSettings(): Promise<DownvoteDeleteSettings> {
  try {
    const currentSettings = normalizeSettings(await devvitSettings.getAll());
    logInfo('Loaded app installation settings.', {
      isActive: currentSettings.isActive,
      trackingDurationHours: currentSettings.trackingDurationHours,
      negativeScoreThreshold: currentSettings.negativeScoreThreshold,
      positiveScoreStopThreshold: currentSettings.positiveScoreStopThreshold,
      actionToTake: currentSettings.actionToTake,
      moderatorPostHandling: currentSettings.moderatorPostHandling,
    });
    return currentSettings;
  } catch (err: unknown) {
    logError('Failed to read app installation settings.', undefined, err);
    throw err;
  }
}

triggers.post('/on-post-submit', async (c) => {
  try {
    const input = await c.req.json<OnPostSubmitRequest>();
    const postId = getPostId(input);
    const subredditId = input.subreddit?.id;
    const subredditName = input.subreddit?.name;
    const authorName = input.author?.name;
    const initialUpvoteRatio = getRuntimeNumberField(
      input.post,
      'upvoteRatio'
    );

    logInfo('Received new post submit trigger.', {
      postId,
      subredditId,
      subredditName,
      authorName,
      initialScore: input.post?.score,
      upvotes: input.post?.upvotes,
      downvotes: input.post?.downvotes,
      upvoteRatio: initialUpvoteRatio,
    });

    const currentSettings = await readSettings();

    if (!postId || !subredditId || !subredditName) {
      logWarn('Skipping post because trigger data is incomplete.', {
        postId,
        subredditId,
        subredditName,
        authorName,
        reason: 'missing_trigger_data',
      });
      return c.json<TriggerResponse>({}, 200);
    }

    const moderatorPost = await isModeratorPost({ authorName, subredditName });

    if (!currentSettings.isActive) {
      logInfo('Skipping post because Downvote Delete is inactive.', {
        postId,
        subredditName,
        authorName,
        reason: 'inactive',
      });
      return c.json<TriggerResponse>({}, 200);
    }

    if (!shouldTrackNewPost({ settings: currentSettings, isModeratorPost: moderatorPost })) {
      logInfo('Skipping post because moderator posts are ignored by settings.', {
        postId,
        subredditName,
        authorName,
        isModeratorPost: moderatorPost,
        moderatorPostHandling: currentSettings.moderatorPostHandling,
        reason: 'moderator_post_ignored',
      });
      return c.json<TriggerResponse>({}, 200);
    }

    const now = Date.now();
    const trackingStartedAt = now;
    const trackingExpiresAt =
      trackingStartedAt +
      currentSettings.trackingDurationHours * 60 * 60 * 1000;

    const record: TrackedPost = {
      subredditId,
      subredditName,
      postId,
      postCreatedAt: getPostCreatedAt(input, now),
      trackingStartedAt,
      trackingExpiresAt,
      checkCount: 0,
      trackingMode: 'normal',
      negativeScoreThreshold: currentSettings.negativeScoreThreshold,
      positiveScoreStopThreshold: currentSettings.positiveScoreStopThreshold,
      actionToTake: currentSettings.actionToTake,
      moderatorPostHandling: currentSettings.moderatorPostHandling,
      status: 'active',
      updatedAt: now,
    };

    if (input.author?.id) {
      record.authorId = input.author.id;
    }

    if (authorName) {
      record.authorName = authorName;
    }

    if (typeof input.post?.score === 'number') {
      record.lastKnownScore = input.post.score;
    }

    if (input.post) {
      const voteCounts = getPostVoteCounts(input.post);

      if (typeof voteCounts.upvotes === 'number') {
        record.lastKnownUpvotes = voteCounts.upvotes;
      }

      if (typeof voteCounts.downvotes === 'number') {
        record.lastKnownDownvotes = voteCounts.downvotes;
      }

      if (typeof voteCounts.calculatedVoteScore === 'number') {
        record.lastCalculatedVoteScore = voteCounts.calculatedVoteScore;
      }

      if (typeof initialUpvoteRatio === 'number') {
        record.lastKnownUpvoteRatio = initialUpvoteRatio;
      }
    }

    const redisKey = watchKey(postId);
    logInfo('Writing initial tracking record to Redis.', {
      postId,
      subredditName,
      authorName,
      redisKey,
      checkCount: record.checkCount,
      initialScore: record.lastKnownScore,
      upvotes: record.lastKnownUpvotes,
      downvotes: record.lastKnownDownvotes,
      upvoteRatio: record.lastKnownUpvoteRatio,
      calculatedVoteScore: record.lastCalculatedVoteScore,
      expiresAt: new Date(record.trackingExpiresAt),
      negativeScoreThreshold: record.negativeScoreThreshold,
      positiveScoreStopThreshold: record.positiveScoreStopThreshold,
      actionToTake: record.actionToTake,
    });

    await redis.set(redisKey, serializeTrackedPost(record));

    const firstRunAt = getNextCheckRunAt(record.checkCount, now);
    const jobId = await scheduler.runJob({
      name: CHECK_WATCHED_POST_TASK,
      data: { postId },
      runAt: firstRunAt,
    });

    await redis.set(
      redisKey,
      serializeTrackedPost({ ...record, lastJobId: jobId, updatedAt: Date.now() })
    );
    await redis.hIncrBy(statsKey(subredditId), 'started', 1);

    logInfo('Started tracking new post and scheduled first check.', {
      postId,
      subredditName,
      authorName,
      redisKey,
      jobId,
      firstRunAt,
      initialScore: record.lastKnownScore,
      upvotes: record.lastKnownUpvotes,
      downvotes: record.lastKnownDownvotes,
      upvoteRatio: record.lastKnownUpvoteRatio,
      calculatedVoteScore: record.lastCalculatedVoteScore,
      expiresAt: new Date(record.trackingExpiresAt),
    });
  } catch (err: unknown) {
    logError('Failed to process post submit trigger.', undefined, err);
  }

  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-post-update', async (c) => {
  try {
    const input = await c.req.json<OnPostUpdateRequest>();
    const postId = input.post?.id;
    const upvoteRatio = getRuntimeNumberField(input.post, 'upvoteRatio');

    logInfo('Received post update trigger.', {
      postId,
      subredditId: input.subreddit?.id,
      authorName: input.author?.name,
      score: input.post?.score,
      upvotes: input.post?.upvotes,
      downvotes: input.post?.downvotes,
      upvoteRatio,
    });

    if (!postId || !input.post) {
      logWarn('Skipping post update because trigger data is incomplete.', {
        postId,
        reason: 'missing_update_data',
      });
      return c.json<TriggerResponse>({}, 200);
    }

    const existingRecord = await loadTrackedPostForTrigger(postId);
    if (!existingRecord || existingRecord.status !== 'active') {
      logInfo('Post update did not update tracking because no active record exists.', {
        postId,
        status: existingRecord?.status,
        reason: existingRecord ? 'record_not_active' : 'record_missing',
      });
      return c.json<TriggerResponse>({}, 200);
    }

    const voteSignalUpdate = getPostVoteSignalUpdate(input.post);
    const updatedRecord = applyActiveTrackingVoteSignalUpdate(
      existingRecord,
      voteSignalUpdate,
      Date.now()
    );

    if (!updatedRecord) {
      logInfo('Post update did not update tracking because record is no longer active.', {
        postId,
        status: existingRecord.status,
        reason: 'record_not_active_before_write',
      });
      return c.json<TriggerResponse>({}, 200);
    }

    const writeResult = await redis.set(
      watchKey(postId),
      serializeTrackedPost(updatedRecord),
      { xx: true }
    );

    if (writeResult !== 'OK') {
      logWarn('Post update vote-count write skipped because watch key no longer exists.', {
        postId,
        redisKey: watchKey(postId),
        writeResult,
        reason: 'watch_key_missing_before_write',
      });
      return c.json<TriggerResponse>({}, 200);
    }

    logInfo('Updated tracked post vote counts from post update trigger.', {
      postId,
      redisKey: watchKey(postId),
      score: updatedRecord.lastKnownScore,
      upvotes: updatedRecord.lastKnownUpvotes,
      downvotes: updatedRecord.lastKnownDownvotes,
      upvoteRatio: updatedRecord.lastKnownUpvoteRatio,
      calculatedVoteScore: updatedRecord.lastCalculatedVoteScore,
    });
  } catch (err: unknown) {
    logError('Failed to process post update trigger.', undefined, err);
  }

  return c.json<TriggerResponse>({}, 200);
});

export { CHECK_WATCHED_POST_TASK };
