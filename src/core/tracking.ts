import type {
  DownvoteDeleteAction,
  ModeratorPostHandling,
} from './settings';
import type { RatioDecisionReason, VoteState } from './voteRatioModel';

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
  | 'calculated_votes';

export type TrackingMode = 'normal' | 'advanced';

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
  trackingMode?: TrackingMode;
  advancedTrackingStartedAt?: number;
  lastOpenAIRatioCheckAt?: number;
  lastOpenAIRequestedUrl?: string;
  lastOpenAIRetrievedUrl?: string;
  lastOpenAIJsonReceived?: boolean;
  lastOpenAIError?: string;
  lastRawUpvoteRatio?: number;
  lastRawRatioPercent?: string;
  lastRawJsonScore?: number;
  lastRawJsonUps?: number;
  lastRawJsonDowns?: number;
  minimumTotalVotes?: number;
  maximumTotalVotesCap?: number;
  guaranteedSpread?: number | null;
  possibleStates?: VoteState[];
  enteredAdvancedTrackingAt?: number;
  consecutiveNegativeChecks?: number;
  lastRatioDecision?: 'none' | 'watch' | 'remove';
  lastRatioDecisionReason?: RatioDecisionReason;
  lastKnownScore?: number;
  lastKnownUpvotes?: number;
  lastKnownDownvotes?: number;
  lastKnownUpvoteRatio?: number;
  lastKnownPostDataUps?: number;
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
