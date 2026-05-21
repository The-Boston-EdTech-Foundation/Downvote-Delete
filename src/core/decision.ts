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

  return Math.round(knownUpvotes * (2 - 1 / args.upvoteRatio));
}

export function getNegativeDecisionScore(
  post: PostSnapshot
): NegativeDecisionScore {
  const calculatedVoteScore =
    post.calculatedVoteScore ??
    calculateVoteScore({ upvotes: post.upvotes, downvotes: post.downvotes });
  const ratioEstimatedScore =
    post.ratioEstimatedScore ??
    estimateScoreFromUpvoteRatio({
      upvotes: post.upvotes,
      postDataUps: post.postDataUps,
      upvoteRatio: post.upvoteRatio,
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

  if (typeof ratioEstimatedScore === 'number') {
    decision.ratioEstimatedScore = ratioEstimatedScore;

    if (ratioEstimatedScore < decision.score) {
      decision.score = ratioEstimatedScore;
      decision.source = 'upvote_ratio_estimate';
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

  if (getNegativeDecisionScore(post).score <= tracking.negativeScoreThreshold) {
    return { type: 'action' };
  }

  if (now >= tracking.trackingExpiresAt) {
    return { type: 'stop', status: 'stopped_expired' };
  }

  return { type: 'reschedule' };
}
