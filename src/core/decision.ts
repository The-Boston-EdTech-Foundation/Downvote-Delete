import {
  MODERATOR_ACTION_ALL,
  type DownvoteDeleteSettings,
} from './settings';
import type { TrackedPost, TrackingStatus } from './tracking';

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
  approved: boolean;
  removed: boolean;
  filtered: boolean;
  spam: boolean;
  deleted: boolean;
  unavailable: boolean;
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

  if (post.score <= tracking.negativeScoreThreshold) {
    return { type: 'action' };
  }

  if (post.score >= tracking.positiveScoreStopThreshold) {
    return { type: 'stop', status: 'stopped_positive' };
  }

  if (now >= tracking.trackingExpiresAt) {
    return { type: 'stop', status: 'stopped_expired' };
  }

  return { type: 'reschedule' };
}
