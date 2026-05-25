import type {
  DownvoteDeleteAction,
  ModeratorPostHandling,
} from './settings';

export type TrackingStatus =
  | 'active'
  | 'actioning'
  | 'actioned'
  | 'stopped_positive'
  | 'stopped_expired'
  | 'stopped_approved'
  | 'stopped_invalid'
  | 'stopped_removed'
  | 'stopped_inactive'
  | 'error';

export type NegativeDecisionSource =
  | 'reddit_score'
  | 'calculated_votes'
  | 'upvote_ratio_estimate'
  | 'single_upvote_ratio_cutoff'
  | 'zero_upvote_ratio_cutoff';

export type TrackedPost = {
  subredditId: string;
  subredditName: string;
  postId: string;
  authorId?: string;
  authorName?: string;
  postCreatedAt: number;
  trackingStartedAt: number;
  trackingExpiresAt: number;
  checkCount: number;
  lastKnownScore?: number;
  lastKnownScoreAt?: number;
  lastKnownUpvotes?: number;
  lastKnownDownvotes?: number;
  lastExactVoteCountsAt?: number;
  lastKnownUpvoteRatio?: number;
  lastKnownPostDataUps?: number;
  lastRatioSignalsAt?: number;
  // Audit/debug only; action decisions recompute from raw vote counts.
  lastCalculatedVoteScore?: number;
  lastRatioEstimatedScore?: number;
  negativeDecisionScore?: number;
  negativeDecisionSource?: NegativeDecisionSource;
  negativeScoreThreshold: number;
  positiveScoreStopThreshold: number;
  actionToTake: DownvoteDeleteAction;
  moderatorPostHandling: ModeratorPostHandling;
  status: TrackingStatus;
  lastJobId?: string;
  updatedAt: number;
  actionedAt?: number;
  modmailStatus?: 'not_applicable' | 'sent' | 'skipped' | 'failed';
  modmailSentAt?: number;
  modmailSkippedReason?: string;
  modmailErrorMessage?: string;
  stopReason?: string;
  errorMessage?: string;
};

export type AuditRecord = TrackedPost & {
  auditedAt: number;
};

export type TrackingVoteSignalUpdate = {
  score?: number;
  upvotes?: number;
  downvotes?: number;
  upvoteRatio?: number;
  postDataUps?: number;
  calculatedVoteScore?: number;
};

export const STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS = 15 * 60 * 1000;

export const watchKey = (postId: string): string =>
  `downvote-delete:watch:${postId}`;

export const auditKey = (postId: string): string =>
  `downvote-delete:audit:${postId}`;

export const statsKey = (subredditId: string): string =>
  `downvote-delete:stats:${subredditId}`;

export function serializeTrackedPost(record: TrackedPost): string {
  return JSON.stringify(record);
}

export function parseTrackedPost(value: string | undefined): TrackedPost | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as TrackedPost;
  } catch {
    return null;
  }
}

export function createAuditRecord(record: TrackedPost, now: number): AuditRecord {
  return {
    ...record,
    auditedAt: now,
  };
}

export function isFreshTimestamp(args: {
  timestamp: number | undefined;
  maxAgeMs: number;
  now: number;
}): boolean {
  return (
    typeof args.timestamp === 'number' &&
    args.timestamp <= args.now &&
    args.now - args.timestamp <= args.maxAgeMs
  );
}

export function shouldUseStoredExactVoteCounts(args: {
  record: TrackedPost;
  hasCurrentPostDataSignals: boolean;
  now: number;
}): boolean {
  return (
    !args.hasCurrentPostDataSignals &&
    isFreshTimestamp({
      timestamp: args.record.lastExactVoteCountsAt,
      maxAgeMs: STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS,
      now: args.now,
    }) &&
    typeof args.record.lastKnownUpvotes === 'number' &&
    typeof args.record.lastKnownDownvotes === 'number'
  );
}

export function shouldUseStoredRatioSignals(args: {
  record: TrackedPost;
  hasCurrentPostDataSignals: boolean;
  now: number;
}): boolean {
  return (
    !args.hasCurrentPostDataSignals &&
    isFreshTimestamp({
      timestamp: args.record.lastRatioSignalsAt,
      maxAgeMs: STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS,
      now: args.now,
    }) &&
    typeof args.record.lastKnownPostDataUps === 'number' &&
    typeof args.record.lastKnownUpvoteRatio === 'number'
  );
}

export function applyActiveTrackingVoteSignalUpdate(
  record: TrackedPost | null,
  update: TrackingVoteSignalUpdate,
  now: number
): TrackedPost | null {
  if (!record || record.status !== 'active') {
    return null;
  }

  const updatedRecord: TrackedPost = {
    ...record,
    updatedAt: now,
  };

  if (typeof update.score === 'number') {
    updatedRecord.lastKnownScore = update.score;
    updatedRecord.lastKnownScoreAt = now;
  }

  if (typeof update.upvotes === 'number') {
    updatedRecord.lastKnownUpvotes = update.upvotes;
  }

  if (typeof update.downvotes === 'number') {
    updatedRecord.lastKnownDownvotes = update.downvotes;
  }

  if (
    typeof update.upvotes === 'number' &&
    typeof update.downvotes === 'number'
  ) {
    updatedRecord.lastExactVoteCountsAt = now;
  }

  if (typeof update.upvoteRatio === 'number') {
    updatedRecord.lastKnownUpvoteRatio = update.upvoteRatio;
    updatedRecord.lastRatioSignalsAt = now;
  }

  if (typeof update.postDataUps === 'number') {
    updatedRecord.lastKnownPostDataUps = update.postDataUps;
    updatedRecord.lastRatioSignalsAt = now;
  }

  if (typeof update.calculatedVoteScore === 'number') {
    updatedRecord.lastCalculatedVoteScore = update.calculatedVoteScore;
  }

  return updatedRecord;
}
