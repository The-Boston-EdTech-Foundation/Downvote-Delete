import { describe, expect, test } from 'vitest';
import { getNextCheckDelayMinutes } from '../src/core/backoff';
import {
  calculateVoteScore,
  decideTrackedPostCheck,
  getNegativeDecisionScore,
  shouldTrackNewPost,
  type PostSnapshot,
} from '../src/core/decision';
import { formatLogContext } from '../src/core/logging';
import {
  ACTION_REMOVE,
  MODERATOR_ACTION_ALL,
  MODERATOR_IGNORE,
  type DownvoteDeleteSettings,
} from '../src/core/settings';
import {
  applyActiveTrackingVoteSignalUpdate,
  type TrackedPost,
} from '../src/core/tracking';

const now = 1_700_000_000_000;

const activeSettings: DownvoteDeleteSettings = {
  isActive: true,
  trackingDurationHours: 2,
  negativeScoreThreshold: -3,
  positiveScoreStopThreshold: 5,
  actionToTake: ACTION_REMOVE,
  moderatorPostHandling: MODERATOR_IGNORE,
};

function trackedPost(overrides: Partial<TrackedPost> = {}): TrackedPost {
  return {
    subredditId: 't5_test',
    subredditName: 'test',
    postId: 't3_post',
    authorId: 't2_author',
    authorName: 'author',
    postCreatedAt: now,
    trackingStartedAt: now,
    trackingExpiresAt: now + 2 * 60 * 60 * 1000,
    checkCount: 0,
    lastKnownScore: 1,
    negativeScoreThreshold: -3,
    positiveScoreStopThreshold: 5,
    actionToTake: ACTION_REMOVE,
    moderatorPostHandling: MODERATOR_IGNORE,
    status: 'active',
    updatedAt: now,
    ...overrides,
  };
}

function postSnapshot(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    score: 0,
    approved: false,
    removed: false,
    filtered: false,
    spam: false,
    deleted: false,
    unavailable: false,
    ...overrides,
  };
}

describe('backoff schedule', () => {
  test('uses incremental delays for post ages around 2, 5, 10, then every 10 minutes', () => {
    expect(getNextCheckDelayMinutes(0)).toBe(2);
    expect(getNextCheckDelayMinutes(1)).toBe(3);
    expect(getNextCheckDelayMinutes(2)).toBe(5);
    expect(getNextCheckDelayMinutes(3)).toBe(10);
    expect(getNextCheckDelayMinutes(4)).toBe(10);
    expect(getNextCheckDelayMinutes(20)).toBe(10);
  });
});

describe('tracked post decisions', () => {
  test('calculates vote score from upvotes and downvotes', () => {
    expect(calculateVoteScore({ upvotes: 1, downvotes: 2 })).toBe(-1);
  });

  test('uses the lower calculated vote score for negative threshold decisions', () => {
    const post = postSnapshot({ score: 0, upvotes: 1, downvotes: 4 });

    expect(getNegativeDecisionScore(post)).toEqual({
      score: -3,
      source: 'calculated_votes',
      calculatedVoteScore: -3,
    });

    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post,
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('uses the normal Reddit score when it is lower than calculated votes', () => {
    const post = postSnapshot({ score: -3, upvotes: 5, downvotes: 5 });

    expect(getNegativeDecisionScore(post)).toEqual({
      score: -3,
      source: 'reddit_score',
      calculatedVoteScore: 0,
    });

    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post,
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('falls back to normal score when vote counts are unavailable', () => {
    expect(getNegativeDecisionScore(postSnapshot({ score: 0 }))).toEqual({
      score: 0,
      source: 'reddit_score',
    });

    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post: postSnapshot({ score: 0 }),
        now,
      })
    ).toEqual({ type: 'reschedule' });
  });

  test('positive stop still uses normal Reddit score instead of calculated votes', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({
          negativeScoreThreshold: -3,
          positiveScoreStopThreshold: 5,
        }),
        settings: activeSettings,
        post: postSnapshot({ score: 5, upvotes: 1, downvotes: 10 }),
        now,
      })
    ).toEqual({ type: 'stop', status: 'stopped_positive' });
  });

  test('actions at the negative score threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post: postSnapshot({ score: -3 }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('does not action above the negative score threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post: postSnapshot({ score: -2 }),
        now,
      })
    ).toEqual({ type: 'reschedule' });
  });

  test('actions at a lower configured negative score threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -5 }),
        settings: activeSettings,
        post: postSnapshot({ score: -5 }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('stops at the positive score threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ positiveScoreStopThreshold: 5 }),
        settings: activeSettings,
        post: postSnapshot({ score: 5 }),
        now,
      })
    ).toEqual({ type: 'stop', status: 'stopped_positive' });
  });

  test('stops after the tracking window expires', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ trackingExpiresAt: now }),
        settings: activeSettings,
        post: postSnapshot({ score: 0 }),
        now,
      })
    ).toEqual({ type: 'stop', status: 'stopped_expired' });
  });

  test('approved posts stop without action', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost(),
        settings: activeSettings,
        post: postSnapshot({ approved: true, score: -10 }),
        now,
      })
    ).toEqual({ type: 'stop', status: 'stopped_approved' });
  });

  test.each([
    ['removed', { removed: true }],
    ['filtered', { filtered: true }],
    ['spam', { spam: true }],
    ['deleted', { deleted: true }],
    ['unavailable', { unavailable: true }],
  ] as const)('%s posts stop without action', (_label, status) => {
    const expectedStatus =
      'deleted' in status || 'unavailable' in status
        ? 'stopped_invalid'
        : 'stopped_removed';

    expect(
      decideTrackedPostCheck({
        tracking: trackedPost(),
        settings: activeSettings,
        post: postSnapshot({ ...status, score: -10 }),
        now,
      })
    ).toEqual({ type: 'stop', status: expectedStatus });
  });

  test('inactive app stops without action', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost(),
        settings: { ...activeSettings, isActive: false },
        post: postSnapshot({ score: -10 }),
        now,
      })
    ).toEqual({ type: 'stop', status: 'stopped_inactive' });
  });

  test('already-actioned posts exit without actioning again', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ status: 'actioned' }),
        settings: activeSettings,
        post: postSnapshot({ score: -10 }),
        now,
      })
    ).toEqual({ type: 'exit' });
  });
});

describe('moderator handling', () => {
  test('moderator posts are ignored by default', () => {
    expect(
      shouldTrackNewPost({
        settings: {
          ...activeSettings,
          moderatorPostHandling: MODERATOR_IGNORE,
        },
        isModeratorPost: true,
      })
    ).toBe(false);
  });

  test('moderator posts are tracked when configured to action all posts', () => {
    expect(
      shouldTrackNewPost({
        settings: {
          ...activeSettings,
          moderatorPostHandling: MODERATOR_ACTION_ALL,
        },
        isModeratorPost: true,
      })
    ).toBe(true);
  });
});

describe('tracking vote signal updates', () => {
  test('updates vote signal fields for active tracked posts', () => {
    expect(
      applyActiveTrackingVoteSignalUpdate(
        trackedPost({
          lastKnownScore: 0,
          lastKnownUpvotes: 2,
          lastKnownDownvotes: 1,
          lastCalculatedVoteScore: 1,
        }),
        {
          score: -1,
          upvotes: 1,
          downvotes: 4,
          calculatedVoteScore: -3,
        },
        now + 1_000
      )
    ).toMatchObject({
      status: 'active',
      lastKnownScore: -1,
      lastKnownUpvotes: 1,
      lastKnownDownvotes: 4,
      lastCalculatedVoteScore: -3,
      updatedAt: now + 1_000,
      negativeScoreThreshold: -3,
      positiveScoreStopThreshold: 5,
    });
  });

  test.each([
    'actioning',
    'actioned',
    'stopped_positive',
    'stopped_expired',
    'stopped_approved',
    'stopped_invalid',
    'stopped_removed',
    'stopped_inactive',
    'error',
  ] as const)('refuses to update %s tracked posts', (status) => {
    expect(
      applyActiveTrackingVoteSignalUpdate(
        trackedPost({ status }),
        {
          score: -3,
          upvotes: 1,
          downvotes: 4,
          calculatedVoteScore: -3,
        },
        now + 1_000
      )
    ).toBeNull();
  });

  test('refuses to update missing records', () => {
    expect(
      applyActiveTrackingVoteSignalUpdate(
        null,
        {
          score: -3,
          upvotes: 1,
          downvotes: 4,
          calculatedVoteScore: -3,
        },
        now + 1_000
      )
    ).toBeNull();
  });
});

describe('logging helpers', () => {
  test('formats defined context fields for command-line output', () => {
    expect(
      formatLogContext({
        postId: 't3_post',
        score: -3,
        ignored: undefined,
        isActive: true,
      })
    ).toBe(' postId=t3_post score=-3 isActive=true');
  });
});
