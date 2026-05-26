import { getNextCheckRunAt } from './backoff';
import { calculateVoteScore, shouldTrackNewPost } from './decision';
import { CHECK_WATCHED_POST_TASK } from './constants';
import { logError, logInfo, logWarn, type LogContext } from './logging';
import { normalizeSettings, type DownvoteDeleteSettings } from './settings';
import {
  applyActiveTrackingVoteSignalUpdate,
  parseTrackedPost,
  serializeTrackedPost,
  statsKey,
  type TrackedPost,
  type TrackingVoteSignalUpdate,
  watchKey,
} from './tracking';

type SettingsValuesLike = Record<string, unknown>;

type SetOptions = {
  nx?: boolean;
  xx?: boolean;
  expiration?: Date;
};

type TriggerRedisClient = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: SetOptions): Promise<string>;
  del(...keys: string[]): Promise<unknown>;
  hIncrBy(key: string, field: string, value: number): Promise<unknown>;
};

type TriggerSchedulerClient = {
  runJob(job: {
    name: string;
    data?: { postId: string };
    runAt: Date;
  }): Promise<string>;
};

type TriggerSettingsClient = {
  getAll(): Promise<SettingsValuesLike>;
};

type ModeratorListing = {
  all(): Promise<Array<{ username?: string; name?: string }>>;
};

type TriggerRedditClient = {
  getModerators(options: {
    subredditName: string;
    username: string;
    limit: number;
    pageSize: number;
  }): ModeratorListing;
};

export type TriggerClients = {
  reddit: TriggerRedditClient;
  redis: TriggerRedisClient;
  scheduler: TriggerSchedulerClient;
  settings: TriggerSettingsClient;
};

export type TriggerSource = 'web_endpoint' | 'legacy_addTrigger';

export type TriggerPost = {
  id?: string | undefined;
  createdAt?: number | undefined;
  score?: number | undefined;
  upvotes?: number | undefined;
  downvotes?: number | undefined;
} & object;

export type TriggerUser = {
  id?: string | undefined;
  name?: string | undefined;
};

export type TriggerSubreddit = {
  id?: string | undefined;
  name?: string | undefined;
};

export type PostSubmitTriggerInput = {
  post?: TriggerPost | undefined;
  author?: TriggerUser | undefined;
  subreddit?: TriggerSubreddit | undefined;
};

export type PostUpdateTriggerInput = {
  post?: TriggerPost | undefined;
  author?: TriggerUser | undefined;
  subreddit?: TriggerSubreddit | undefined;
};

export type TriggerResult =
  | 'started'
  | 'duplicate_active'
  | 'skipped_incomplete'
  | 'skipped_inactive'
  | 'skipped_moderator'
  | 'updated'
  | 'record_missing'
  | 'record_not_active'
  | 'record_not_active_before_write'
  | 'watch_key_missing_before_write'
  | 'error';

function getPostId(input: PostSubmitTriggerInput): string | undefined {
  return input.post?.id;
}

function getPostCreatedAt(input: PostSubmitTriggerInput, now: number): number {
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

export function deriveUpvoteRatio(args: {
  upvotes?: number | undefined;
  downvotes?: number | undefined;
}): number | undefined {
  if (typeof args.upvotes !== 'number' || typeof args.downvotes !== 'number') {
    return undefined;
  }

  const totalVotes = args.upvotes + args.downvotes;
  return totalVotes > 0 ? args.upvotes / totalVotes : undefined;
}

function getPostVoteCounts(post: {
  upvotes?: number | undefined;
  downvotes?: number | undefined;
}) {
  const voteCounts: {
    upvotes?: number;
    downvotes?: number;
    calculatedVoteScore?: number;
    derivedUpvoteRatio?: number;
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

  const derivedUpvoteRatio = deriveUpvoteRatio(voteCounts);
  if (typeof derivedUpvoteRatio === 'number') {
    voteCounts.derivedUpvoteRatio = derivedUpvoteRatio;
  }

  return voteCounts;
}

export function getPostVoteSignalUpdate(
  post: {
    score?: number | undefined;
    upvotes?: number | undefined;
    downvotes?: number | undefined;
  } & object
): TrackingVoteSignalUpdate {
  const voteCounts = getPostVoteCounts(post);
  const update: TrackingVoteSignalUpdate = {
    ...voteCounts,
  };

  if (typeof post.score === 'number') {
    update.score = post.score;
  }

  const nativeUpvoteRatio = getRuntimeNumberField(post, 'upvoteRatio');
  if (typeof nativeUpvoteRatio === 'number') {
    update.upvoteRatio = nativeUpvoteRatio;
  } else if (
    typeof voteCounts.derivedUpvoteRatio === 'number' &&
    typeof voteCounts.upvotes === 'number'
  ) {
    update.upvoteRatio = voteCounts.derivedUpvoteRatio;
    update.postDataUps = voteCounts.upvotes;
  }

  return update;
}

async function loadTrackedPostForTrigger(
  redis: TriggerRedisClient,
  postId: string,
  triggerSource: TriggerSource
): Promise<TrackedPost | null> {
  const redisKey = watchKey(postId);
  logInfo('Pulling tracking record from Redis for trigger update.', {
    postId,
    redisKey,
    triggerSource,
  });

  const rawRecord = await redis.get(redisKey);
  const parsedRecord = parseTrackedPost(rawRecord);

  if (!rawRecord) {
    logInfo('No active tracking record found for trigger update.', {
      postId,
      redisKey,
      triggerSource,
    });
    return null;
  }

  if (!parsedRecord) {
    logError('Tracking record for trigger update is malformed.', {
      postId,
      redisKey,
      triggerSource,
      rawLength: rawRecord.length,
    });
    return null;
  }

  logInfo('Loaded tracking record for trigger update.', {
    postId,
    redisKey,
    triggerSource,
    status: parsedRecord.status,
    checkCount: parsedRecord.checkCount,
  });

  return parsedRecord;
}

async function isModeratorPost(args: {
  reddit: TriggerRedditClient;
  authorName: string | undefined;
  subredditName: string | undefined;
  triggerSource: TriggerSource;
}): Promise<boolean> {
  if (!args.authorName || !args.subredditName) {
    logInfo(
      'Moderator detection skipped because author or subreddit is missing.',
      {
        authorName: args.authorName,
        subredditName: args.subredditName,
        triggerSource: args.triggerSource,
      }
    );
    return false;
  }

  logInfo('Checking whether post author is a moderator.', {
    authorName: args.authorName,
    subredditName: args.subredditName,
    triggerSource: args.triggerSource,
  });

  const moderators = await args.reddit
    .getModerators({
      subredditName: args.subredditName,
      username: args.authorName,
      limit: 1,
      pageSize: 1,
    })
    .all();

  const moderatorPost = moderators.some(
    (moderator) =>
      moderator.username === args.authorName ||
      moderator.name === args.authorName
  );

  logInfo('Moderator detection complete.', {
    authorName: args.authorName,
    subredditName: args.subredditName,
    triggerSource: args.triggerSource,
    isModeratorPost: moderatorPost,
  });

  return moderatorPost;
}

async function readSettings(
  settings: TriggerSettingsClient,
  triggerSource: TriggerSource
): Promise<DownvoteDeleteSettings> {
  try {
    const currentSettings = normalizeSettings(await settings.getAll());
    logInfo('Loaded app installation settings.', {
      triggerSource,
      isActive: currentSettings.isActive,
      trackingDurationHours: currentSettings.trackingDurationHours,
      negativeScoreThreshold: currentSettings.negativeScoreThreshold,
      positiveScoreStopThreshold: currentSettings.positiveScoreStopThreshold,
      actionToTake: currentSettings.actionToTake,
      moderatorPostHandling: currentSettings.moderatorPostHandling,
    });
    return currentSettings;
  } catch (err: unknown) {
    logError(
      'Failed to read app installation settings.',
      { triggerSource },
      err
    );
    throw err;
  }
}

function buildTriggerLogContext(args: {
  triggerSource: TriggerSource;
  postId?: string | undefined;
  subredditId?: string | undefined;
  subredditName?: string | undefined;
  authorName?: string | undefined;
  post?: TriggerPost | undefined;
}): LogContext {
  const nativeUpvoteRatio = getRuntimeNumberField(args.post, 'upvoteRatio');
  const derivedUpvoteRatio = args.post
    ? deriveUpvoteRatio({
        upvotes: args.post.upvotes,
        downvotes: args.post.downvotes,
      })
    : undefined;

  return {
    triggerSource: args.triggerSource,
    postId: args.postId,
    subredditId: args.subredditId,
    subredditName: args.subredditName,
    authorName: args.authorName,
    initialScore: args.post?.score,
    score: args.post?.score,
    upvotes: args.post?.upvotes,
    downvotes: args.post?.downvotes,
    upvoteRatio: nativeUpvoteRatio,
    derivedUpvoteRatio,
  };
}

export async function handlePostSubmitTrigger(args: {
  input: PostSubmitTriggerInput;
  clients: TriggerClients;
  triggerSource: TriggerSource;
  now?: number;
}): Promise<TriggerResult> {
  try {
    const { input, clients, triggerSource } = args;
    const postId = getPostId(input);
    const subredditId = input.subreddit?.id;
    const subredditName = input.subreddit?.name;
    const authorName = input.author?.name;
    const nativeUpvoteRatio = getRuntimeNumberField(input.post, 'upvoteRatio');

    logInfo('Received new post submit trigger.', {
      ...buildTriggerLogContext({
        triggerSource,
        postId,
        subredditId,
        subredditName,
        authorName,
        post: input.post,
      }),
      score: undefined,
    });

    const currentSettings = await readSettings(clients.settings, triggerSource);

    if (!postId || !subredditId || !subredditName) {
      logWarn('Skipping post because trigger data is incomplete.', {
        triggerSource,
        postId,
        subredditId,
        subredditName,
        authorName,
        reason: 'missing_trigger_data',
      });
      return 'skipped_incomplete';
    }

    const moderatorPost = await isModeratorPost({
      reddit: clients.reddit,
      authorName,
      subredditName,
      triggerSource,
    });

    if (!currentSettings.isActive) {
      logInfo('Skipping post because Downvote Delete is inactive.', {
        triggerSource,
        postId,
        subredditName,
        authorName,
        reason: 'inactive',
      });
      return 'skipped_inactive';
    }

    if (
      !shouldTrackNewPost({
        settings: currentSettings,
        isModeratorPost: moderatorPost,
      })
    ) {
      logInfo(
        'Skipping post because moderator posts are ignored by settings.',
        {
          triggerSource,
          postId,
          subredditName,
          authorName,
          isModeratorPost: moderatorPost,
          moderatorPostHandling: currentSettings.moderatorPostHandling,
          reason: 'moderator_post_ignored',
        }
      );
      return 'skipped_moderator';
    }

    const now = args.now ?? Date.now();
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
      record.lastKnownScoreAt = now;
    }

    if (input.post) {
      const voteCounts = getPostVoteCounts(input.post);

      if (typeof voteCounts.upvotes === 'number') {
        record.lastKnownUpvotes = voteCounts.upvotes;
      }

      if (typeof voteCounts.downvotes === 'number') {
        record.lastKnownDownvotes = voteCounts.downvotes;
      }

      if (
        typeof voteCounts.upvotes === 'number' &&
        typeof voteCounts.downvotes === 'number'
      ) {
        record.lastExactVoteCountsAt = now;
      }

      if (typeof voteCounts.calculatedVoteScore === 'number') {
        record.lastCalculatedVoteScore = voteCounts.calculatedVoteScore;
      }

      if (typeof nativeUpvoteRatio === 'number') {
        record.lastKnownUpvoteRatio = nativeUpvoteRatio;
        record.lastRatioSignalsAt = now;
      } else if (
        typeof voteCounts.derivedUpvoteRatio === 'number' &&
        typeof voteCounts.upvotes === 'number'
      ) {
        record.lastKnownUpvoteRatio = voteCounts.derivedUpvoteRatio;
        record.lastKnownPostDataUps = voteCounts.upvotes;
        record.lastRatioSignalsAt = now;
      }
    }

    const redisKey = watchKey(postId);
    logInfo('Writing initial tracking record to Redis.', {
      triggerSource,
      postId,
      subredditName,
      authorName,
      redisKey,
      checkCount: record.checkCount,
      initialScore: record.lastKnownScore,
      upvotes: record.lastKnownUpvotes,
      downvotes: record.lastKnownDownvotes,
      upvoteRatio: nativeUpvoteRatio,
      derivedUpvoteRatio: record.lastKnownUpvoteRatio,
      postDataUps: record.lastKnownPostDataUps,
      calculatedVoteScore: record.lastCalculatedVoteScore,
      lastKnownScoreAt: record.lastKnownScoreAt,
      lastExactVoteCountsAt: record.lastExactVoteCountsAt,
      lastRatioSignalsAt: record.lastRatioSignalsAt,
      expiresAt: new Date(record.trackingExpiresAt),
      negativeScoreThreshold: record.negativeScoreThreshold,
      positiveScoreStopThreshold: record.positiveScoreStopThreshold,
      actionToTake: record.actionToTake,
    });

    const initialWriteResult = await clients.redis.set(
      redisKey,
      serializeTrackedPost(record),
      { nx: true }
    );

    if (initialWriteResult !== 'OK') {
      logInfo('Skipping post submit because tracking record already exists.', {
        triggerSource,
        postId,
        subredditName,
        authorName,
        redisKey,
        writeResult: initialWriteResult,
        reason: 'duplicate_active_tracking_record',
      });
      return 'duplicate_active';
    }

    const firstRunAt = getNextCheckRunAt(record.checkCount, now);
    let jobId: string;
    try {
      jobId = await clients.scheduler.runJob({
        name: CHECK_WATCHED_POST_TASK,
        data: { postId },
        runAt: firstRunAt,
      });
    } catch (err: unknown) {
      await clients.redis.del(redisKey);
      logError(
        'Failed to schedule first post check; rolled back tracking record.',
        {
          triggerSource,
          postId,
          subredditName,
          authorName,
          redisKey,
          firstRunAt,
        },
        err
      );
      throw err;
    }

    await clients.redis.set(
      redisKey,
      serializeTrackedPost({
        ...record,
        lastJobId: jobId,
        updatedAt: Date.now(),
      })
    );
    await clients.redis.hIncrBy(statsKey(subredditId), 'started', 1);

    logInfo('Started tracking new post and scheduled first check.', {
      triggerSource,
      postId,
      subredditName,
      authorName,
      redisKey,
      jobId,
      firstRunAt,
      initialScore: record.lastKnownScore,
      upvotes: record.lastKnownUpvotes,
      downvotes: record.lastKnownDownvotes,
      upvoteRatio: nativeUpvoteRatio,
      derivedUpvoteRatio: record.lastKnownUpvoteRatio,
      postDataUps: record.lastKnownPostDataUps,
      calculatedVoteScore: record.lastCalculatedVoteScore,
      lastKnownScoreAt: record.lastKnownScoreAt,
      lastExactVoteCountsAt: record.lastExactVoteCountsAt,
      lastRatioSignalsAt: record.lastRatioSignalsAt,
      expiresAt: new Date(record.trackingExpiresAt),
    });

    return 'started';
  } catch (err: unknown) {
    logError(
      'Failed to process post submit trigger.',
      { triggerSource: args.triggerSource },
      err
    );
    return 'error';
  }
}

export async function handlePostUpdateTrigger(args: {
  input: PostUpdateTriggerInput;
  clients: TriggerClients;
  triggerSource: TriggerSource;
  now?: number;
}): Promise<TriggerResult> {
  try {
    const { input, clients, triggerSource } = args;
    const postId = input.post?.id;

    logInfo('Received post update trigger.', {
      ...buildTriggerLogContext({
        triggerSource,
        postId,
        subredditId: input.subreddit?.id,
        authorName: input.author?.name,
        post: input.post,
      }),
      initialScore: undefined,
    });

    if (!postId || !input.post) {
      logWarn('Skipping post update because trigger data is incomplete.', {
        triggerSource,
        postId,
        reason: 'missing_update_data',
      });
      return 'skipped_incomplete';
    }

    const existingRecord = await loadTrackedPostForTrigger(
      clients.redis,
      postId,
      triggerSource
    );
    if (!existingRecord || existingRecord.status !== 'active') {
      logInfo(
        'Post update did not update tracking because no active record exists.',
        {
          triggerSource,
          postId,
          status: existingRecord?.status,
          reason: existingRecord ? 'record_not_active' : 'record_missing',
        }
      );
      return existingRecord ? 'record_not_active' : 'record_missing';
    }

    const voteSignalUpdate = getPostVoteSignalUpdate(input.post);
    const updatedRecord = applyActiveTrackingVoteSignalUpdate(
      existingRecord,
      voteSignalUpdate,
      args.now ?? Date.now()
    );

    if (!updatedRecord) {
      logInfo(
        'Post update did not update tracking because record is no longer active.',
        {
          triggerSource,
          postId,
          status: existingRecord.status,
          reason: 'record_not_active_before_write',
        }
      );
      return 'record_not_active_before_write';
    }

    const writeResult = await clients.redis.set(
      watchKey(postId),
      serializeTrackedPost(updatedRecord),
      { xx: true }
    );

    if (writeResult !== 'OK') {
      logWarn(
        'Post update vote-count write skipped because watch key no longer exists.',
        {
          triggerSource,
          postId,
          redisKey: watchKey(postId),
          writeResult,
          reason: 'watch_key_missing_before_write',
        }
      );
      return 'watch_key_missing_before_write';
    }

    logInfo('Updated tracked post vote counts from post update trigger.', {
      triggerSource,
      postId,
      redisKey: watchKey(postId),
      score: updatedRecord.lastKnownScore,
      upvotes: updatedRecord.lastKnownUpvotes,
      downvotes: updatedRecord.lastKnownDownvotes,
      upvoteRatio: getRuntimeNumberField(input.post, 'upvoteRatio'),
      derivedUpvoteRatio: deriveUpvoteRatio({
        upvotes: input.post.upvotes,
        downvotes: input.post.downvotes,
      }),
      postDataUps: updatedRecord.lastKnownPostDataUps,
      calculatedVoteScore: updatedRecord.lastCalculatedVoteScore,
      lastKnownScoreAt: updatedRecord.lastKnownScoreAt,
      lastExactVoteCountsAt: updatedRecord.lastExactVoteCountsAt,
      lastRatioSignalsAt: updatedRecord.lastRatioSignalsAt,
    });

    return 'updated';
  } catch (err: unknown) {
    logError(
      'Failed to process post update trigger.',
      { triggerSource: args.triggerSource },
      err
    );
    return 'error';
  }
}
