import { describe, expect, test } from 'vitest';
import { getNextCheckDelayMinutes } from '../src/core/backoff';
import {
  decideTrackedPostCheck,
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
import type { TrackedPost } from '../src/core/tracking';

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
  test('uses the configured early delays and then 10 minutes', () => {
    expect(getNextCheckDelayMinutes(0)).toBe(2);
    expect(getNextCheckDelayMinutes(1)).toBe(5);
    expect(getNextCheckDelayMinutes(2)).toBe(10);
    expect(getNextCheckDelayMinutes(3)).toBe(20);
    expect(getNextCheckDelayMinutes(4)).toBe(10);
    expect(getNextCheckDelayMinutes(20)).toBe(10);
  });
});

describe('tracked post decisions', () => {
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
