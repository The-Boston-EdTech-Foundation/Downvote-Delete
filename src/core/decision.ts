import {
  MODERATOR_ACTION_ALL,
  type DownvoteDeleteSettings,
} from './settings';
import type {
  NegativeDecisionSource,
  TrackedPost,
  TrackingStatus,
} from './tracking';

export type TrackEligibilityInput = {
  settings: DownvoteDeleteSettings;
  isModeratorPost: boolean;
};

export function shouldTrackNewPost(input: TrackEligibilityInput): boolean {
  if (!input.settings.isActive) {
    return false;
  }

  return (
    !input.isModeratorPost ||
    input.settings.moderatorPostHandling === MODERATOR_ACTION_ALL
  );
}

export type PostSnapshot = {
  score: number;
  upvotes?: number;
  downvotes?: number;
  postDataUps?: number;
  upvoteRatio?: number;
  calculatedVoteScore?: number;
  ratioEstimatedScore?: number;
  approved: boolean;
  removed: boolean;
  filtered: boolean;
  spam: boolean;
  deleted: boolean;
  unavailable: boolean;
};

export type NegativeDecisionScore = {
  score: number;
  source: NegativeDecisionSource;
  calculatedVoteScore?: number;
  ratioEstimatedScore?: number;
};

type RatioDecisionScore = {
  score: number;
  source: Extract<
    NegativeDecisionSource,
    | 'upvote_ratio_estimate'
    | 'single_upvote_ratio_cutoff'
    | 'zero_upvote_ratio_cutoff'
  >;
};

export type CheckDecision =
  | { type: 'exit' }
  | { type: 'stop'; status: Exclude<TrackingStatus, 'active' | 'actioning'> }
  | { type: 'action' }
  | { type: 'reschedule' };

export function isPostInvalidForTracking(post: PostSnapshot): boolean {
  return post.deleted || post.unavailable;
}

export function isPostAlreadyModerated(post: PostSnapshot): boolean {
  return post.removed || post.filtered || post.spam;
}

export function calculateVoteScore(args: {
  upvotes?: number | undefined;
  downvotes?: number | undefined;
}): number | undefined {
  if (typeof args.upvotes !== 'number' || typeof args.downvotes !== 'number') {
    return undefined;
  }

  return args.upvotes - args.downvotes;
}

export function estimateScoreFromUpvoteRatio(args: {
  upvotes?: number | undefined;
  postDataUps?: number | undefined;
  upvoteRatio?: number | undefined;
}): number | undefined {
  const knownUpvotes =
    typeof args.postDataUps === 'number' &&
    Number.isFinite(args.postDataUps) &&
    args.postDataUps > 0
      ? args.postDataUps
      : args.upvotes;

  if (
    typeof knownUpvotes !== 'number' ||
    !Number.isFinite(knownUpvotes) ||
    knownUpvotes <= 0
  ) {
    return undefined;
  }

  if (
    typeof args.upvoteRatio !== 'number' ||
    !Number.isFinite(args.upvoteRatio) ||
    args.upvoteRatio <= 0 ||
    args.upvoteRatio >= 0.5
  ) {
    return undefined;
  }

  const roundedScore = Math.round(knownUpvotes * (2 - 1 / args.upvoteRatio));
  return Object.is(roundedScore, -0) ? 0 : roundedScore;
}

function estimateScoreFromSingleUpvoteRatioCutoff(args: {
  upvotes?: number | undefined;
  postDataUps?: number | undefined;
  upvoteRatio?: number | undefined;
  negativeScoreThreshold?: number | undefined;
}): number | undefined {
  if (
    typeof args.upvotes === 'number' ||
    typeof args.postDataUps === 'number'
  ) {
    return undefined;
  }

  if (
    typeof args.negativeScoreThreshold !== 'number' ||
    !Number.isFinite(args.negativeScoreThreshold) ||
    args.negativeScoreThreshold >= 0
  ) {
    return undefined;
  }

  if (
    typeof args.upvoteRatio !== 'number' ||
    !Number.isFinite(args.upvoteRatio) ||
    args.upvoteRatio <= 0 ||
    args.upvoteRatio >= 0.5
  ) {
    return undefined;
  }

  const ratioCutoff = 1 / (Math.abs(args.negativeScoreThreshold) + 2);
  return args.upvoteRatio <= ratioCutoff
    ? args.negativeScoreThreshold
    : undefined;
}

function estimateScoreFromZeroUpvoteRatioCutoff(args: {
  score: number;
  upvotes?: number | undefined;
  downvotes?: number | undefined;
  postDataUps?: number | undefined;
  upvoteRatio?: number | undefined;
  negativeScoreThreshold?: number | undefined;
}): number | undefined {
  const hasZeroUpvotes =
    args.upvotes === 0 ||
    (typeof args.postDataUps === 'number' &&
      Number.isFinite(args.postDataUps) &&
      args.postDataUps === 0);

  if (
    !hasZeroUpvotes ||
    typeof args.downvotes === 'number' ||
    args.score !== 0
  ) {
    return undefined;
  }

  if (
    typeof args.negativeScoreThreshold !== 'number' ||
    !Number.isFinite(args.negativeScoreThreshold) ||
    args.negativeScoreThreshold >= 0
  ) {
    return undefined;
  }

  if (
    typeof args.upvoteRatio !== 'number' ||
    !Number.isFinite(args.upvoteRatio) ||
    args.upvoteRatio < 0 ||
    args.upvoteRatio >= 0.5
  ) {
    return undefined;
  }

  return args.upvoteRatio < 0.5 ? -1 : undefined;
}

function getRatioDecisionScore(args: {
  score: number;
  upvotes?: number | undefined;
  downvotes?: number | undefined;
  postDataUps?: number | undefined;
  upvoteRatio?: number | undefined;
  ratioEstimatedScore?: number | undefined;
  negativeScoreThreshold?: number | undefined;
}): RatioDecisionScore | undefined {
  if (typeof args.ratioEstimatedScore === 'number') {
    return {
      score: args.ratioEstimatedScore,
      source: 'upvote_ratio_estimate',
    };
  }

  const ratioEstimatedScore = estimateScoreFromUpvoteRatio({
    upvotes: args.upvotes,
    postDataUps: args.postDataUps,
    upvoteRatio: args.upvoteRatio,
  });

  if (typeof ratioEstimatedScore === 'number') {
    return {
      score: ratioEstimatedScore,
      source: 'upvote_ratio_estimate',
    };
  }

  const zeroUpvoteCutoffScore = estimateScoreFromZeroUpvoteRatioCutoff({
    score: args.score,
    upvotes: args.upvotes,
    downvotes: args.downvotes,
    postDataUps: args.postDataUps,
    upvoteRatio: args.upvoteRatio,
    negativeScoreThreshold: args.negativeScoreThreshold,
  });

  if (typeof zeroUpvoteCutoffScore === 'number') {
    return {
      score: zeroUpvoteCutoffScore,
      source: 'zero_upvote_ratio_cutoff',
    };
  }

  const cutoffScore = estimateScoreFromSingleUpvoteRatioCutoff({
    upvotes: args.upvotes,
    postDataUps: args.postDataUps,
    upvoteRatio: args.upvoteRatio,
    negativeScoreThreshold: args.negativeScoreThreshold,
  });

  return typeof cutoffScore === 'number'
    ? {
        score: cutoffScore,
        source: 'single_upvote_ratio_cutoff',
      }
    : undefined;
}

export function getNegativeDecisionScore(
  post: PostSnapshot,
  options: { negativeScoreThreshold?: number } = {}
): NegativeDecisionScore {
  const calculatedVoteScore = calculateVoteScore({
    upvotes: post.upvotes,
    downvotes: post.downvotes,
  });
  const ratioDecisionScore = getRatioDecisionScore({
    score: post.score,
    upvotes: post.upvotes,
    downvotes: post.downvotes,
    postDataUps: post.postDataUps,
    upvoteRatio: post.upvoteRatio,
    ratioEstimatedScore: post.ratioEstimatedScore,
    negativeScoreThreshold: options.negativeScoreThreshold,
  });

  const decision: NegativeDecisionScore = {
    score: post.score,
    source: 'reddit_score',
  };

  if (typeof calculatedVoteScore === 'number') {
    decision.calculatedVoteScore = calculatedVoteScore;

    if (calculatedVoteScore < decision.score) {
      decision.score = calculatedVoteScore;
      decision.source = 'calculated_votes';
    }
  }

  if (ratioDecisionScore) {
    decision.ratioEstimatedScore = ratioDecisionScore.score;

    if (ratioDecisionScore.score < decision.score) {
      decision.score = ratioDecisionScore.score;
      decision.source = ratioDecisionScore.source;
    }
  }

  return decision;
}

export function decideTrackedPostCheck(args: {
  tracking: TrackedPost | null;
  settings: DownvoteDeleteSettings;
  post: PostSnapshot | null;
  now: number;
}): CheckDecision {
  const { tracking, settings, post, now } = args;

  if (!tracking || tracking.status !== 'active') {
    return { type: 'exit' };
  }

  if (!settings.isActive) {
    return { type: 'stop', status: 'stopped_inactive' };
  }

  if (!post || isPostInvalidForTracking(post)) {
    return { type: 'stop', status: 'stopped_invalid' };
  }

  if (isPostAlreadyModerated(post)) {
    return { type: 'stop', status: 'stopped_removed' };
  }

  if (post.approved) {
    return { type: 'stop', status: 'stopped_approved' };
  }

  if (post.score >= tracking.positiveScoreStopThreshold) {
    return { type: 'stop', status: 'stopped_positive' };
  }

  if (
    getNegativeDecisionScore(post, {
      negativeScoreThreshold: tracking.negativeScoreThreshold,
    }).score <= tracking.negativeScoreThreshold
  ) {
    return { type: 'action' };
  }

  if (now >= tracking.trackingExpiresAt) {
    return { type: 'stop', status: 'stopped_expired' };
  }

  return { type: 'reschedule' };
}
