import { randomUUID } from 'node:crypto';
import { redis, scheduler } from '@devvit/web/server';
import { logError, logWarn } from './logging';
import {
  auditKey,
  parseTrackedPostResult,
  serializeTrackedPost,
  statsKey,
  type TrackedPost,
  watchKey,
} from './tracking';

export const CHECK_WATCHED_POST_TASK = 'checkWatchedPost';
const INITIALIZATION_CLAIM_TTL_MS = 2 * 60 * 1000;

type SchedulingKind = 'check' | 'action_recovery';
type SchedulingCommitVerification = 'committed' | 'not_committed' | 'unknown';

class InitialTrackingTransactionAbortedError extends Error {}

export type CheckWatchedPostData = {
  postId?: string;
  kind?: 'check' | 'action_recovery';
  runToken?: string;
  actionAttemptId?: string;
};

type SchedulingDependencies = {
  redisClient?: typeof redis;
  schedulerClient?: typeof scheduler;
  createRunToken?: () => string;
  now?: () => number;
};

export type InitialScheduleResult =
  | { status: 'scheduled'; record: TrackedPost }
  | { status: 'already_tracking' };

export const initializationClaimKey = (postId: string): string =>
  `downvote-delete:initialization-claim:${postId}`;

export function isCurrentCheckDelivery(
  record: TrackedPost,
  data: CheckWatchedPostData | undefined
): boolean {
  return data?.runToken === undefined
    ? record.scheduledRunToken === undefined
    : data.runToken === record.scheduledRunToken;
}

async function cancelOrphanedJob(
  jobId: string,
  postId: string,
  schedulerClient: typeof scheduler
): Promise<void> {
  try {
    await schedulerClient.cancelJob(jobId);
  } catch (err: unknown) {
    logError(
      'Failed to cancel an orphaned scheduled job; its token will self-discard.',
      { postId, jobId },
      err
    );
  }
}

async function persistInitialTracking(
  record: TrackedPost,
  redisClient: typeof redis
): Promise<void> {
  const transaction = await redisClient.watch(watchKey(record.postId));
  await transaction.multi();
  await transaction.set(watchKey(record.postId), serializeTrackedPost(record));
  await transaction.hIncrBy(statsKey(record.subredditId), 'started', 1);
  const replies = await transaction.exec();
  if (replies.length === 0) {
    throw new InitialTrackingTransactionAbortedError(
      'Initial tracking transaction was not committed.'
    );
  }
}

async function verifySchedulingCommit(args: {
  expectedRecord: TrackedPost;
  kind: SchedulingKind;
  redisClient: typeof redis;
}): Promise<SchedulingCommitVerification> {
  let rawRecord: string | undefined;
  try {
    rawRecord = await args.redisClient.get(
      watchKey(args.expectedRecord.postId)
    );
  } catch {
    return 'unknown';
  }

  if (rawRecord === undefined) {
    return 'not_committed';
  }

  const parsed = parseTrackedPostResult(rawRecord);
  if (!parsed.ok) {
    return 'unknown';
  }

  if (args.kind === 'action_recovery') {
    return parsed.record.actionRecoveryJobId ===
      args.expectedRecord.actionRecoveryJobId &&
      parsed.record.actionRecoveryRunToken ===
        args.expectedRecord.actionRecoveryRunToken &&
      parsed.record.actionAttemptId === args.expectedRecord.actionAttemptId
      ? 'committed'
      : 'not_committed';
  }

  return parsed.record.lastJobId === args.expectedRecord.lastJobId &&
    parsed.record.scheduledRunToken === args.expectedRecord.scheduledRunToken
    ? 'committed'
    : 'not_committed';
}

async function resolveSchedulingPersistenceError(args: {
  error: unknown;
  expectedRecord: TrackedPost;
  jobId: string;
  runToken: string;
  kind: SchedulingKind;
  redisClient: typeof redis;
  schedulerClient: typeof scheduler;
}): Promise<boolean> {
  if (args.error instanceof InitialTrackingTransactionAbortedError) {
    await cancelOrphanedJob(
      args.jobId,
      args.expectedRecord.postId,
      args.schedulerClient
    );
    return false;
  }

  const verification = await verifySchedulingCommit({
    expectedRecord: args.expectedRecord,
    kind: args.kind,
    redisClient: args.redisClient,
  });
  logWarn('Verified scheduling state after a Redis persistence error.', {
    postId: args.expectedRecord.postId,
    jobId: args.jobId,
    runToken: args.runToken,
    schedulingKind: args.kind,
    verification,
    persistenceError:
      args.error instanceof Error ? args.error.message : String(args.error),
  });

  if (verification === 'committed') {
    return true;
  }
  if (verification === 'not_committed') {
    await cancelOrphanedJob(
      args.jobId,
      args.expectedRecord.postId,
      args.schedulerClient
    );
  }
  return false;
}

export async function schedulePostCheck(args: {
  record: TrackedPost;
  checkCount: number;
  runAt: Date;
  incrementStarted?: boolean;
  dependencies?: SchedulingDependencies;
}): Promise<TrackedPost> {
  const redisClient = args.dependencies?.redisClient ?? redis;
  const schedulerClient = args.dependencies?.schedulerClient ?? scheduler;
  const now = args.dependencies?.now ?? Date.now;
  const runToken = (args.dependencies?.createRunToken ?? randomUUID)();
  const jobId = await schedulerClient.runJob({
    name: CHECK_WATCHED_POST_TASK,
    data: {
      postId: args.record.postId,
      kind: 'check',
      runToken,
    } satisfies CheckWatchedPostData,
    runAt: args.runAt,
  });
  const updatedRecord: TrackedPost = {
    ...args.record,
    checkCount: args.checkCount,
    lastJobId: jobId,
    scheduledRunToken: runToken,
    updatedAt: now(),
  };

  try {
    if (args.incrementStarted) {
      await persistInitialTracking(updatedRecord, redisClient);
    } else {
      await redisClient.set(
        watchKey(updatedRecord.postId),
        serializeTrackedPost(updatedRecord)
      );
    }
  } catch (err: unknown) {
    const committed = await resolveSchedulingPersistenceError({
      error: err,
      expectedRecord: updatedRecord,
      jobId,
      runToken,
      kind: 'check',
      redisClient,
      schedulerClient,
    });
    if (committed) {
      return updatedRecord;
    }
    throw err;
  }

  return updatedRecord;
}

export async function scheduleInitialPostCheck(args: {
  record: TrackedPost;
  runAt: Date;
  dependencies?: SchedulingDependencies;
}): Promise<InitialScheduleResult> {
  const redisClient = args.dependencies?.redisClient ?? redis;
  const now = args.dependencies?.now ?? Date.now;
  const claimToken = (args.dependencies?.createRunToken ?? randomUUID)();
  const claimKey = initializationClaimKey(args.record.postId);
  const claimed = await redisClient.set(claimKey, claimToken, {
    nx: true,
    expiration: new Date(now() + INITIALIZATION_CLAIM_TTL_MS),
  });

  if (claimed !== 'OK') {
    return { status: 'already_tracking' };
  }

  try {
    const existing = await redisClient.mGet([
      watchKey(args.record.postId),
      auditKey(args.record.postId),
    ]);
    if (existing.some((value) => value !== null)) {
      return { status: 'already_tracking' };
    }

    const scheduleArgs: Parameters<typeof schedulePostCheck>[0] = {
      record: args.record,
      checkCount: 0,
      runAt: args.runAt,
      incrementStarted: true,
    };
    if (args.dependencies) {
      scheduleArgs.dependencies = args.dependencies;
    }
    const record = await schedulePostCheck(scheduleArgs);
    return { status: 'scheduled', record };
  } finally {
    try {
      if ((await redisClient.get(claimKey)) === claimToken) {
        await redisClient.del(claimKey);
      }
    } catch (err: unknown) {
      logWarn('Initialization claim cleanup failed.', {
        postId: args.record.postId,
        claimKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function scheduleActionRecovery(args: {
  record: TrackedPost;
  runAt: Date;
  actionAttemptId: string;
  dependencies?: SchedulingDependencies;
}): Promise<TrackedPost> {
  const redisClient = args.dependencies?.redisClient ?? redis;
  const schedulerClient = args.dependencies?.schedulerClient ?? scheduler;
  const now = args.dependencies?.now ?? Date.now;
  const runToken = (args.dependencies?.createRunToken ?? randomUUID)();
  const jobId = await schedulerClient.runJob({
    name: CHECK_WATCHED_POST_TASK,
    data: {
      postId: args.record.postId,
      kind: 'action_recovery',
      runToken,
      actionAttemptId: args.actionAttemptId,
    } satisfies CheckWatchedPostData,
    runAt: args.runAt,
  });
  const updatedRecord: TrackedPost = {
    ...args.record,
    actionAttemptId: args.actionAttemptId,
    actionRecoveryJobId: jobId,
    actionRecoveryRunToken: runToken,
    updatedAt: now(),
  };

  try {
    await redisClient.set(
      watchKey(updatedRecord.postId),
      serializeTrackedPost(updatedRecord)
    );
  } catch (err: unknown) {
    const committed = await resolveSchedulingPersistenceError({
      error: err,
      expectedRecord: updatedRecord,
      jobId,
      runToken,
      kind: 'action_recovery',
      redisClient,
      schedulerClient,
    });
    if (committed) {
      return updatedRecord;
    }
    throw err;
  }

  return updatedRecord;
}

export async function cancelScheduledJobSafely(args: {
  postId: string;
  jobId?: string;
  reason: string;
}): Promise<void> {
  if (!args.jobId) {
    return;
  }

  try {
    await scheduler.cancelJob(args.jobId);
  } catch (err: unknown) {
    logWarn('Scheduled job cancellation failed.', {
      postId: args.postId,
      jobId: args.jobId,
      reason: args.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
