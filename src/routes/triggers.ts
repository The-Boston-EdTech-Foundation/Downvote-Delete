import { Hono } from 'hono';
import type { OnPostSubmitRequest, TriggerResponse } from '@devvit/web/shared';
import {
  reddit,
  redis,
  scheduler,
  settings as devvitSettings,
} from '@devvit/web/server';
import { getNextCheckRunAt } from '../core/backoff';
import {
  normalizeSettings,
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
    return false;
  }

  const moderators = await reddit
    .getModerators({
      subredditName: args.subredditName,
      username: args.authorName,
      limit: 1,
      pageSize: 1,
    })
    .all();

  return moderators.some((moderator) => moderator.username === args.authorName);
}

async function readSettings(): Promise<DownvoteDeleteSettings> {
  return normalizeSettings(await devvitSettings.getAll());
}

triggers.post('/on-post-submit', async (c) => {
  try {
    const input = await c.req.json<OnPostSubmitRequest>();
    const currentSettings = await readSettings();
    const postId = getPostId(input);
    const subredditId = input.subreddit?.id;
    const subredditName = input.subreddit?.name;
    const authorName = input.author?.name;

    if (!postId || !subredditId || !subredditName) {
      console.warn('Downvote Delete skipped a post with missing trigger data.');
      return c.json<TriggerResponse>({}, 200);
    }

    const moderatorPost = await isModeratorPost({ authorName, subredditName });
    if (
      !shouldTrackNewPost({
        settings: currentSettings,
        isModeratorPost: moderatorPost,
      })
    ) {
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

    await redis.set(watchKey(postId), serializeTrackedPost(record));
    const jobId = await scheduler.runJob({
      name: CHECK_WATCHED_POST_TASK,
      data: { postId },
      runAt: getNextCheckRunAt(record.checkCount, now),
    });

    await redis.set(
      watchKey(postId),
      serializeTrackedPost({ ...record, lastJobId: jobId, updatedAt: Date.now() })
    );
    await redis.hIncrBy(statsKey(subredditId), 'started', 1);
  } catch (err: unknown) {
    console.error('Downvote Delete failed to process post submit trigger.', err);
  }

  return c.json<TriggerResponse>({}, 200);
});

export { CHECK_WATCHED_POST_TASK };
