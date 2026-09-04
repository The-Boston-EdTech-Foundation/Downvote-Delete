import type {
  DownvoteDeleteAction,
  DownvoteDeleteSettings,
  ModeratorPostHandling,
} from './settings';
import type { RatioDecisionReason, VoteState } from './voteRatioModel';

export type TrackingStatus =
  | 'active'
  | 'actioning'
  | 'actioned'
  | 'action_failed'
  | 'action_unknown'
  | 'stopped_positive'
  | 'stopped_expired'
  | 'stopped_approved'
  | 'stopped_invalid'
  | 'stopped_removed'
  | 'stopped_inactive'
  | 'error';

export type NegativeDecisionSource = 'reddit_score' | 'calculated_votes';

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
  // Retained field names and legacy source keep existing Redis records compatible.
  lastAuthenticatedRatioCheckAt?: number;
  lastAuthenticatedRatioReceived?: boolean;
  lastAuthenticatedRatioSource?:
    | 'authenticated_reddit_api'
    | 'praw_router'
    | 'firebase_router';
  lastAuthenticatedRatioError?: string;
  lastAuthenticatedRatioHttpStatus?: number;
  lastAuthenticatedRatioRawName?: string;
  lastAuthenticatedRatioRawId?: string;
  lastAuthenticatedRatioHideScore?: boolean;
  lastRawUpvoteRatio?: number;
  lastRawRatioPercent?: string;
  lastRawAuthenticatedScore?: number;
  lastRawAuthenticatedUps?: number;
  lastRawAuthenticatedDowns?: number;
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
  scheduledRunToken?: string;
  updatedAt: number;
  actionAttemptId?: string;
  actionStartedAt?: number;
  actionCompletedAt?: number;
  actionRecoveryJobId?: string;
  actionRecoveryRunToken?: string;
  attemptedAction?: DownvoteDeleteAction;
  actionOutcome?: 'succeeded' | 'failed' | 'unknown';
  actionErrorMessage?: string;
  removalNoteStatus?: 'not_applicable' | 'added' | 'failed';
  removalNoteErrorMessage?: string;
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

export type TrackedPostParseResult =
  | { ok: true; record: TrackedPost }
  | { ok: false; error: string };

const trackingStatuses: readonly TrackingStatus[] = [
  'active',
  'actioning',
  'actioned',
  'action_failed',
  'action_unknown',
  'stopped_positive',
  'stopped_expired',
  'stopped_approved',
  'stopped_invalid',
  'stopped_removed',
  'stopped_inactive',
  'error',
];

const actionValues: readonly DownvoteDeleteAction[] = [
  'report',
  'filter',
  'remove',
];
const moderatorHandlingValues: readonly ModeratorPostHandling[] = [
  'ignore',
  'action_all',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function invalidOptional(
  record: Record<string, unknown>,
  keys: readonly string[],
  predicate: (value: unknown) => boolean
): string | undefined {
  return keys.find(
    (key) => record[key] !== undefined && !predicate(record[key])
  );
}

function validateTrackedPost(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return 'record_not_object';
  }

  for (const key of ['subredditId', 'subredditName', 'postId'] as const) {
    if (!isNonEmptyString(raw[key])) {
      return `invalid_${key}`;
    }
  }

  for (const key of [
    'postCreatedAt',
    'trackingStartedAt',
    'trackingExpiresAt',
    'updatedAt',
  ] as const) {
    if (!isFiniteNumber(raw[key]) || raw[key] < 0) {
      return `invalid_${key}`;
    }
  }

  if (
    !isFiniteNumber(raw.checkCount) ||
    !Number.isInteger(raw.checkCount) ||
    raw.checkCount < 0
  ) {
    return 'invalid_checkCount';
  }

  if (!isFiniteNumber(raw.negativeScoreThreshold)) {
    return 'invalid_negativeScoreThreshold';
  }
  if (!isFiniteNumber(raw.positiveScoreStopThreshold)) {
    return 'invalid_positiveScoreStopThreshold';
  }
  if (!actionValues.includes(raw.actionToTake as DownvoteDeleteAction)) {
    return 'invalid_actionToTake';
  }
  if (
    !moderatorHandlingValues.includes(
      raw.moderatorPostHandling as ModeratorPostHandling
    )
  ) {
    return 'invalid_moderatorPostHandling';
  }
  if (!trackingStatuses.includes(raw.status as TrackingStatus)) {
    return 'invalid_status';
  }

  const invalidString = invalidOptional(
    raw,
    [
      'authorId',
      'authorName',
      'lastJobId',
      'scheduledRunToken',
      'actionAttemptId',
      'actionRecoveryJobId',
      'actionRecoveryRunToken',
      'actionErrorMessage',
      'removalNoteErrorMessage',
      'lastAuthenticatedRatioError',
      'lastAuthenticatedRatioRawName',
      'lastAuthenticatedRatioRawId',
      'lastRawRatioPercent',
      'stopReason',
      'errorMessage',
      'modmailSkippedReason',
      'modmailErrorMessage',
    ],
    isNonEmptyString
  );
  if (invalidString) {
    return `invalid_${invalidString}`;
  }

  const invalidNumber = invalidOptional(
    raw,
    [
      'advancedTrackingStartedAt',
      'lastAuthenticatedRatioCheckAt',
      'lastAuthenticatedRatioHttpStatus',
      'lastRawUpvoteRatio',
      'lastRawAuthenticatedScore',
      'lastRawAuthenticatedUps',
      'lastRawAuthenticatedDowns',
      'minimumTotalVotes',
      'maximumTotalVotesCap',
      'enteredAdvancedTrackingAt',
      'consecutiveNegativeChecks',
      'lastKnownScore',
      'lastKnownUpvotes',
      'lastKnownDownvotes',
      'lastKnownUpvoteRatio',
      'lastKnownPostDataUps',
      'lastCalculatedVoteScore',
      'negativeDecisionScore',
      'actionedAt',
      'modmailSentAt',
      'actionStartedAt',
      'actionCompletedAt',
    ],
    isFiniteNumber
  );
  if (invalidNumber) {
    return `invalid_${invalidNumber}`;
  }

  const invalidBoolean = invalidOptional(
    raw,
    ['lastAuthenticatedRatioReceived', 'lastAuthenticatedRatioHideScore'],
    (value) => typeof value === 'boolean'
  );
  if (invalidBoolean) {
    return `invalid_${invalidBoolean}`;
  }

  if (
    raw.guaranteedSpread !== undefined &&
    raw.guaranteedSpread !== null &&
    !isFiniteNumber(raw.guaranteedSpread)
  ) {
    return 'invalid_guaranteedSpread';
  }
  if (raw.possibleStates !== undefined) {
    if (!Array.isArray(raw.possibleStates)) {
      return 'invalid_possibleStates';
    }
    const validStates = raw.possibleStates.every(
      (state) =>
        isRecord(state) &&
        isFiniteNumber(state.upvotes) &&
        isFiniteNumber(state.downvotes) &&
        isFiniteNumber(state.total) &&
        isFiniteNumber(state.spread) &&
        isFiniteNumber(state.ratio)
    );
    if (!validStates) {
      return 'invalid_possibleStates';
    }
  }

  const optionalEnums: Array<[string, readonly string[]]> = [
    ['trackingMode', ['normal', 'advanced']],
    [
      'lastAuthenticatedRatioSource',
      ['authenticated_reddit_api', 'praw_router', 'firebase_router'],
    ],
    ['lastRatioDecision', ['none', 'watch', 'remove']],
    [
      'lastRatioDecisionReason',
      [
        'invalid_ratio',
        'severe_downvote_ratio',
        'ratio_above_tracking_range',
        'guaranteed_spread_threshold_met',
        'continue_tracking',
        'no_possible_states_after_filter',
      ],
    ],
    ['negativeDecisionSource', ['reddit_score', 'calculated_votes']],
    ['modmailStatus', ['not_applicable', 'sent', 'skipped', 'failed']],
    ['removalNoteStatus', ['not_applicable', 'added', 'failed']],
    ['attemptedAction', actionValues],
    ['actionOutcome', ['succeeded', 'failed', 'unknown']],
  ];
  for (const [key, values] of optionalEnums) {
    if (raw[key] !== undefined && !values.includes(raw[key] as string)) {
      return `invalid_${key}`;
    }
  }

  return undefined;
}

export function parseTrackedPostResult(
  value: string | undefined
): TrackedPostParseResult {
  if (!value) {
    return { ok: false, error: 'record_missing' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  const error = validateTrackedPost(raw);
  return error
    ? { ok: false, error }
    : { ok: true, record: raw as TrackedPost };
}

export function parseTrackedPost(
  value: string | undefined
): TrackedPost | null {
  const result = parseTrackedPostResult(value);
  return result.ok ? result.record : null;
}

export function createAuditRecord(
  record: TrackedPost,
  now: number
): AuditRecord {
  return {
    ...record,
    auditedAt: now,
  };
}

export function refreshTrackedPostActionSettings(
  record: TrackedPost,
  settings: DownvoteDeleteSettings
): TrackedPost {
  return {
    ...record,
    negativeScoreThreshold: settings.negativeScoreThreshold,
    positiveScoreStopThreshold: settings.positiveScoreStopThreshold,
    actionToTake: settings.actionToTake,
    moderatorPostHandling: settings.moderatorPostHandling,
  };
}
