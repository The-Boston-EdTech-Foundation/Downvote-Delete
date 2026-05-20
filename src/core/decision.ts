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
  calculatedVoteScore?: number;
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

export function getNegativeDecisionScore(
  post: PostSnapshot
): NegativeDecisionScore {
  const calculatedVoteScore =
    post.calculatedVoteScore ??
    calculateVoteScore({ upvotes: post.upvotes, downvotes: post.downvotes });

  if (
    typeof calculatedVoteScore === 'number' &&
    calculatedVoteScore < post.score
  ) {
    return {
      score: calculatedVoteScore,
      source: 'calculated_votes',
      calculatedVoteScore,
    };
  }

  const redditScoreDecision: NegativeDecisionScore = {
    score: post.score,
    source: 'reddit_score',
  };

  if (typeof calculatedVoteScore === 'number') {
    redditScoreDecision.calculatedVoteScore = calculatedVoteScore;
  }

  return redditScoreDecision;
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
