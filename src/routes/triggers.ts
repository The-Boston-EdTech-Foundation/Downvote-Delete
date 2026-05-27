import { Hono } from 'hono';
import type {
  OnPostSubmitRequest,
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
  summarizeSubredditSettingsShapes,
  type DownvoteDeleteSettings,
} from '../core/settings';
import { shouldTrackNewPost } from '../core/decision';
import {
  serializeTrackedPost,
  statsKey,
  type TrackedPost,
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
    const rawSettings = await devvitSettings.getAll();
    const currentSettings = normalizeSettings(rawSettings);
    logInfo('Loaded app installation settings.', {
      isActive: currentSettings.isActive,
      trackingDurationHours: currentSettings.trackingDurationHours,
      negativeScoreThreshold: currentSettings.negativeScoreThreshold,
      positiveScoreStopThreshold: currentSettings.positiveScoreStopThreshold,
      actionToTake: currentSettings.actionToTake,
      moderatorPostHandling: currentSettings.moderatorPostHandling,
      rawSettingShapes: summarizeSubredditSettingsShapes(rawSettings),
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

    logInfo('Received new post submit trigger.', {
      postId,
      subredditId,
      subredditName,
      authorName,
      initialScore: input.post?.score,
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

    const redisKey = watchKey(postId);
    logInfo('Writing initial tracking record to Redis.', {
      postId,
      subredditName,
      authorName,
      redisKey,
      checkCount: record.checkCount,
      initialScore: record.lastKnownScore,
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
      expiresAt: new Date(record.trackingExpiresAt),
    });
  } catch (err: unknown) {
    logError('Failed to process post submit trigger.', undefined, err);
  }

  return c.json<TriggerResponse>({}, 200);
});

export { CHECK_WATCHED_POST_TASK };
