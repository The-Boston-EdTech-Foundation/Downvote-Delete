import { randomUUID } from 'node:crypto';
import { redis } from '@devvit/web/server';
import {
  auditKey,
  createAuditRecord,
  statsKey,
  type TrackedPost,
  type TrackingStatus,
  watchKey,
} from './tracking';

export type FinalizationResult =
  | { status: 'committed' }
  | { status: 'already_finalized' }
  | { status: 'retry_required'; reason: 'claim_busy' | 'commit_unconfirmed' };

type FinalizationDependencies = {
  redisClient?: typeof redis;
  createClaimToken?: () => string;
  now?: () => number;
};

export const actionLockKey = (postId: string): string =>
  `downvote-delete:action-lock:${postId}`;
export const finalizationClaimKey = (postId: string): string =>
  `downvote-delete:finalization-claim:${postId}`;

async function auditExists(
  redisClient: typeof redis,
  postId: string
): Promise<boolean | undefined> {
  try {
    return Boolean(await redisClient.get(auditKey(postId)));
  } catch {
    return undefined;
  }
}

export async function finalizeTrackedPost(args: {
  record: TrackedPost;
  status: Exclude<TrackingStatus, 'active' | 'actioning'>;
  stopReason?: string;
  successfulAction?: TrackedPost['actionToTake'];
  dependencies?: FinalizationDependencies;
}): Promise<FinalizationResult> {
  const redisClient = args.dependencies?.redisClient ?? redis;
  const now = (args.dependencies?.now ?? Date.now)();
  const claimToken = (args.dependencies?.createClaimToken ?? randomUUID)();
  const claimKey = finalizationClaimKey(args.record.postId);
  const claimed = await redisClient.set(claimKey, claimToken, {
    nx: true,
    expiration: new Date(now + 10 * 60 * 1000),
  });

  if (claimed !== 'OK') {
    return (await auditExists(redisClient, args.record.postId)) === true
      ? { status: 'already_finalized' }
      : { status: 'retry_required', reason: 'claim_busy' };
  }

  try {
    const existingAudit = await auditExists(redisClient, args.record.postId);
    if (existingAudit === true) {
      return { status: 'already_finalized' };
    }
    if (existingAudit === undefined) {
      return { status: 'retry_required', reason: 'commit_unconfirmed' };
    }

    const stoppedRecord: TrackedPost = {
      ...args.record,
      status: args.status,
      updatedAt: now,
    };
    if (args.stopReason) {
      stoppedRecord.stopReason = args.stopReason;
    }

    try {
      const transaction = await redisClient.watch(
        watchKey(args.record.postId),
        auditKey(args.record.postId)
      );
      await transaction.multi();
      await transaction.set(
        auditKey(args.record.postId),
        JSON.stringify(createAuditRecord(stoppedRecord, now))
      );
      await transaction.hIncrBy(
        statsKey(args.record.subredditId),
        args.status,
        1
      );
      if (args.successfulAction) {
        await transaction.hIncrBy(
          statsKey(args.record.subredditId),
          `action_${args.successfulAction}`,
          1
        );
      }
      await transaction.del(
        watchKey(args.record.postId),
        actionLockKey(args.record.postId)
      );
      const replies = await transaction.exec();
      if (replies.length > 0) {
        return { status: 'committed' };
      }
    } catch {
      // An EXEC response can fail after Redis committed it. Verify the durable
      // audit marker before allowing any recovery record to be written.
    }

    return (await auditExists(redisClient, args.record.postId)) === true
      ? { status: 'already_finalized' }
      : { status: 'retry_required', reason: 'commit_unconfirmed' };
  } finally {
    try {
      if ((await redisClient.get(claimKey)) === claimToken) {
        await redisClient.del(claimKey);
      }
    } catch {
      // Expiration is the fallback if claim cleanup is unavailable.
    }
  }
}
