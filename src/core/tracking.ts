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

export type NegativeDecisionSource = 'reddit_score' | 'calculated_votes';

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
  lastKnownUpvotes?: number;
  lastKnownDownvotes?: number;
  lastCalculatedVoteScore?: number;
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
  calculatedVoteScore?: number;
};

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
  }

  if (typeof update.upvotes === 'number') {
    updatedRecord.lastKnownUpvotes = update.upvotes;
  }

  if (typeof update.downvotes === 'number') {
    updatedRecord.lastKnownDownvotes = update.downvotes;
  }

  if (typeof update.calculatedVoteScore === 'number') {
    updatedRecord.lastCalculatedVoteScore = update.calculatedVoteScore;
  }

  return updatedRecord;
}
