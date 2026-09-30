import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  executionLockBusy: false,
  settings: {} as Record<string, unknown>,
  getModerators: vi.fn(),
}));

vi.mock('@devvit/web/server', () => ({
  redis: {
    async get(key: string): Promise<string | undefined> {
      return mocks.values.get(key);
    },
    async set(
      key: string,
      value: string,
      options?: { nx?: boolean }
    ): Promise<string | undefined> {
      if (options?.nx && (mocks.executionLockBusy || mocks.values.has(key))) {
        return undefined;
      }
      mocks.values.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]): Promise<void> {
      keys.forEach((key) => mocks.values.delete(key));
    },
  },
  reddit: {
    getModerators: mocks.getModerators,
  },
  settings: {
    async getAll(): Promise<Record<string, unknown>> {
      return mocks.settings;
    },
  },
  scheduler: {
    async runJob(): Promise<string> {
      return 'job';
    },
    async cancelJob(): Promise<void> {},
  },
}));

import { scheduledJobs } from '../src/routes/scheduler';
import { triggers } from '../src/routes/triggers';
import {
  serializeTrackedPost,
  watchKey,
  type TrackedPost,
} from '../src/core/tracking';

const now = 1_700_000_000_000;

function activeRecord(): TrackedPost {
  return {
    subredditId: 't5_test',
    subredditName: 'test',
    postId: 't3_post',
    authorName: 'author',
    postCreatedAt: now,
    trackingStartedAt: now,
    trackingExpiresAt: now + 60 * 60 * 1000,
    checkCount: 0,
    negativeScoreThreshold: -2,
    positiveScoreStopThreshold: 5,
    actionToTake: 'remove',
    sendRemovalDirectMessage: true,
    leaveRemovalComment: true,
    moderatorPostHandling: 'ignore',
    status: 'active',
    scheduledRunToken: 'run-token',
    updatedAt: now,
  };
}

beforeEach(() => {
  mocks.values.clear();
  mocks.executionLockBusy = false;
  mocks.settings = {};
  mocks.getModerators.mockReset();
});

describe('scheduled route delivery guarantees', () => {
  test('returns a retriable response when the execution lock is busy', async () => {
    mocks.values.set(watchKey('t3_post'), serializeTrackedPost(activeRecord()));
    mocks.executionLockBusy = true;

    const response = await scheduledJobs.request('/check-watched-post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: {
          postId: 't3_post',
          kind: 'check',
          runToken: 'run-token',
        },
      }),
    });

    expect(response.status).toBe(503);
    expect(mocks.values.has(watchKey('t3_post'))).toBe(true);
  });
});

describe('post-submit route safeguards', () => {
  test('does not query moderators while the app is inactive', async () => {
    mocks.settings = { isActive: false };

    const response = await triggers.request('/on-post-submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        post: { id: 't3_post', createdAt: now / 1000, score: 1 },
        subreddit: { id: 't5_test', name: 'test' },
        author: { id: 't2_author', name: 'author' },
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getModerators).not.toHaveBeenCalled();
  });
});
