import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  executionLockBusy: false,
  settings: {} as Record<string, unknown>,
  getModerators: vi.fn(),
  scheduledJobs: [] as unknown[],
  failSetWhen: undefined as
    | ((key: string, value: string) => boolean)
    | undefined,
  comments: [] as Array<{
    id: string;
    authorName: string;
    body: string;
    createdAt: Date;
    distinguish(sticky?: boolean): Promise<void>;
  }>,
  directMessages: 0,
  postRemoved: true,
  postLocked: true,
  unlocks: 0,
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
      const forcedExecutionContention =
        mocks.executionLockBusy &&
        key.includes(':check-lock:') &&
        !key.endsWith(':successor-claim');
      if (options?.nx && (forcedExecutionContention || mocks.values.has(key))) {
        return undefined;
      }
      if (mocks.failSetWhen?.(key, value)) {
        throw new Error('injected redis write failure');
      }
      mocks.values.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]): Promise<void> {
      keys.forEach((key) => mocks.values.delete(key));
    },
    async watch(): Promise<{
      multi(): Promise<void>;
      set(key: string, value: string): Promise<void>;
      expire(): Promise<void>;
      hIncrBy(): Promise<void>;
      del(key: string): Promise<void>;
      exec(): Promise<string[]>;
    }> {
      const operations: Array<() => void> = [];
      return {
        async multi(): Promise<void> {},
        async set(key: string, value: string): Promise<void> {
          operations.push(() => mocks.values.set(key, value));
        },
        async expire(): Promise<void> {},
        async hIncrBy(): Promise<void> {},
        async del(key: string): Promise<void> {
          operations.push(() => mocks.values.delete(key));
        },
        async exec(): Promise<string[]> {
          operations.forEach((operation) => operation());
          return ['OK'];
        },
      };
    },
  },
  reddit: {
    getModerators: mocks.getModerators,
    async getPostById(): Promise<Record<string, unknown>> {
      return {
        id: 't3_post',
        permalink: '/r/test/comments/post',
        score: -3,
        approved: false,
        removed: mocks.postRemoved,
        spam: false,
        locked: mocks.postLocked,
        removedByCategory: mocks.postRemoved ? 'moderator' : undefined,
        isApproved: () => false,
        isRemoved: () => mocks.postRemoved,
        isSpam: () => false,
        async addRemovalNote(): Promise<void> {},
        async unlock(): Promise<void> {
          mocks.unlocks += 1;
          mocks.postLocked = false;
        },
        async addComment({ text }: { text: string }): Promise<unknown> {
          const comment = {
            id: 't1_notice',
            authorName: 'downvote-delete-app',
            body: text,
            createdAt: new Date(now),
            async distinguish(): Promise<void> {},
          };
          mocks.comments.push(comment);
          return comment;
        },
      };
    },
    async getCurrentUsername(): Promise<string> {
      return 'downvote-delete-app';
    },
    getComments(): { all(): Promise<typeof mocks.comments> } {
      return {
        async all() {
          return mocks.comments;
        },
      };
    },
    async getCommentById(): Promise<(typeof mocks.comments)[number]> {
      const comment = mocks.comments[0];
      if (!comment) throw new Error('comment missing');
      return comment;
    },
    async sendPrivateMessage(): Promise<void> {
      mocks.directMessages += 1;
    },
  },
  settings: {
    async getAll(): Promise<Record<string, unknown>> {
      return mocks.settings;
    },
  },
  scheduler: {
    async runJob(job: unknown): Promise<string> {
      mocks.scheduledJobs.push(job);
      return `job-${mocks.scheduledJobs.length}`;
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
  mocks.scheduledJobs.length = 0;
  mocks.failSetWhen = undefined;
  mocks.comments.length = 0;
  mocks.directMessages = 0;
  mocks.postRemoved = true;
  mocks.postLocked = true;
  mocks.unlocks = 0;
});

describe('scheduled route delivery guarantees', () => {
  test('schedules exactly one durable successor when the execution lock is busy', async () => {
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

    expect(response.status).toBe(200);
    expect(mocks.values.has(watchKey('t3_post'))).toBe(true);
    expect(mocks.scheduledJobs).toHaveLength(1);
    expect(mocks.scheduledJobs[0]).toMatchObject({
      name: 'checkWatchedPost',
      data: {
        postId: 't3_post',
        kind: 'check',
        runToken: 'run-token',
      },
    });

    const duplicateResponse = await scheduledJobs.request(
      '/check-watched-post',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: {
            postId: 't3_post',
            kind: 'check',
            runToken: 'run-token',
          },
        }),
      }
    );

    expect(duplicateResponse.status).toBe(200);
    expect(mocks.scheduledJobs).toHaveLength(1);
  });

  test('keeps recovery actioning after an intermediate failure and completes on redelivery', async () => {
    const recoveryRecord: TrackedPost = {
      ...activeRecord(),
      status: 'actioning',
      attemptedAction: 'remove',
      actionAttemptId: 'attempt-1',
      actionRecoveryJobId: 'recovery-job',
      actionRecoveryRunToken: 'recovery-token',
      actionOutcome: 'unknown',
      actionPhase: 'removal_attempted',
      postLockStatus: 'locked',
      postWasLockedBeforeAction: false,
      removalNoteStatus: 'added',
      removalCommentStatus: 'pending',
      privateMessageStatus: 'pending',
    };
    mocks.values.set(watchKey('t3_post'), serializeTrackedPost(recoveryRecord));
    let failOnce = true;
    mocks.failSetWhen = (key, value) => {
      if (
        failOnce &&
        key === watchKey('t3_post') &&
        value.includes('"removalCommentStatus":"added"')
      ) {
        failOnce = false;
        return true;
      }
      return false;
    };
    const request = () =>
      scheduledJobs.request('/check-watched-post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: {
            postId: 't3_post',
            kind: 'action_recovery',
            runToken: 'recovery-token',
            actionAttemptId: 'attempt-1',
          },
        }),
      });

    const firstResponse = await request();
    expect(firstResponse.status).toBe(500);
    const interrupted = JSON.parse(
      mocks.values.get(watchKey('t3_post')) ?? '{}'
    ) as TrackedPost;
    expect(interrupted.status).toBe('actioning');
    expect(interrupted.removalCommentStatus).toBe('attempting');

    mocks.values.delete('downvote-delete:check-lock:t3_post:recovery-token');
    mocks.failSetWhen = undefined;
    const secondResponse = await request();

    expect(secondResponse.status).toBe(200);
    expect(mocks.comments).toHaveLength(1);
    expect(mocks.directMessages).toBe(1);
    expect(mocks.unlocks).toBe(0);
    expect(mocks.values.has(watchKey('t3_post'))).toBe(false);
    expect(
      JSON.parse(mocks.values.get('downvote-delete:audit:t3_post') ?? '{}')
    ).toMatchObject({
      status: 'actioned',
      removalCommentStatus: 'reconciled',
      removalCommentId: 't1_notice',
      removalCommentAddedAt: expect.any(Number),
      privateMessageStatus: 'sent',
      privateMessageSentAt: expect.any(Number),
    });
  });

  test('compensates an ambiguous unremoved post without notifying', async () => {
    mocks.postRemoved = false;
    mocks.postLocked = true;
    const recoveryRecord: TrackedPost = {
      ...activeRecord(),
      status: 'actioning',
      attemptedAction: 'remove',
      actionAttemptId: 'attempt-unremoved',
      actionRecoveryJobId: 'recovery-job-unremoved',
      actionRecoveryRunToken: 'recovery-token-unremoved',
      actionOutcome: 'unknown',
      actionPhase: 'removal_attempted',
      postLockStatus: 'locked',
      postWasLockedBeforeAction: false,
      removalNoteStatus: 'pending',
      removalCommentStatus: 'pending',
      privateMessageStatus: 'pending',
    };
    mocks.values.set(watchKey('t3_post'), serializeTrackedPost(recoveryRecord));

    const response = await scheduledJobs.request('/check-watched-post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: {
          postId: 't3_post',
          kind: 'action_recovery',
          runToken: 'recovery-token-unremoved',
          actionAttemptId: 'attempt-unremoved',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.unlocks).toBe(1);
    expect(mocks.comments).toHaveLength(0);
    expect(mocks.directMessages).toBe(0);
    expect(
      JSON.parse(mocks.values.get('downvote-delete:audit:t3_post') ?? '{}')
    ).toMatchObject({
      status: 'action_unknown',
      actionOutcome: 'unknown',
      postUnlockStatus: 'unlocked',
      recoveryReason: 'confirmed_unremoved',
    });
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
