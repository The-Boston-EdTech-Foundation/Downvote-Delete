import { describe, expect, test, vi } from 'vitest';
import devvitConfig from '../devvit.json';
import {
  applyModerationAction,
  buildRemovedForDownvotesPrivateMessageBody,
  REMOVAL_PRIVATE_MESSAGE_SUBJECT,
} from '../src/core/actions';
import { resolveActionRecovery } from '../src/core/actionLifecycle';
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
  finalizationClaimKey,
  finalizeTrackedPost,
} from '../src/core/finalization';
import {
  initializationClaimKey,
  isCurrentCheckDelivery,
  scheduleActionRecovery,
  scheduleInitialPostCheck,
  schedulePostCheck,
} from '../src/core/scheduling';
import {
  fetchFirebaseRouterVoteSnapshot,
  FIREBASE_RATIO_ROUTER_URL,
  readFirebaseRouterConfigFromSettings,
  signFirebaseRouterRequest,
  type FirebaseRouterConfig,
  type FirebaseRouterFetch,
} from '../src/core/firebaseRatioRouter';
import {
  advancedTrackingMaxRatio,
  buildRatioLookup,
  evaluateRatioState,
  shouldRemoveByRatio,
  updateTrackedPostVoteState,
  type TrackedPostVoteState,
} from '../src/core/voteRatioModel';
import {
  ACTION_FILTER,
  ACTION_REMOVE,
  ACTION_REPORT,
  MODERATOR_ACTION_ALL,
  MODERATOR_IGNORE,
  normalizeSettings,
  summarizeSubredditSettingsShapes,
  type DownvoteDeleteSettings,
} from '../src/core/settings';
import {
  parseTrackedPost,
  parseTrackedPostResult,
  refreshTrackedPostActionSettings,
  serializeTrackedPost,
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

type ApplyModerationActionArgs = Parameters<typeof applyModerationAction>[0];

function mockPost(
  overrides: Partial<{
    actionCalls: string[];
    filterCalls: string[];
    lockCalls: number;
    removalNotes: unknown[];
    removeCalls: boolean[];
    failLock: boolean;
    failRemovalNote: boolean;
  }> = {}
): ApplyModerationActionArgs['post'] & {
  actionCalls: string[];
  filterCalls: string[];
  lockCalls: number;
  removalNotes: unknown[];
  removeCalls: boolean[];
} {
  const actionCalls = overrides.actionCalls ?? [];
  const filterCalls = overrides.filterCalls ?? [];
  let lockCalls = overrides.lockCalls ?? 0;
  const removalNotes = overrides.removalNotes ?? [];
  const removeCalls = overrides.removeCalls ?? [];
  const failLock = overrides.failLock ?? false;
  const failRemovalNote = overrides.failRemovalNote ?? false;
  const post = {
    actionCalls,
    filterCalls,
    get lockCalls(): number {
      return lockCalls;
    },
    removalNotes,
    removeCalls,
    async filter(options: { reason?: string; keep?: boolean }): Promise<void> {
      filterCalls.push(`${options.reason}|${options.keep}`);
    },
    async lock(): Promise<void> {
      actionCalls.push('lock');
      lockCalls += 1;
      if (failLock) {
        throw new Error('post lock unavailable');
      }
    },
    async remove(isSpam: boolean): Promise<void> {
      actionCalls.push('remove');
      removeCalls.push(isSpam);
    },
    async addRemovalNote(note: unknown): Promise<void> {
      removalNotes.push(note);
      if (failRemovalNote) {
        throw new Error('removal note unavailable');
      }
    },
  };

  return post as unknown as ApplyModerationActionArgs['post'] & {
    actionCalls: string[];
    filterCalls: string[];
    lockCalls: number;
    removalNotes: unknown[];
    removeCalls: boolean[];
  };
}

function mockRedditClient(
  args: {
    failPrivateMessage?: boolean;
    reportErrors?: string[];
  } = {}
): ApplyModerationActionArgs['redditClient'] & {
  reports: unknown[];
  privateMessages: unknown[];
  modmailConversations: unknown[];
} {
  const reports: unknown[] = [];
  const privateMessages: unknown[] = [];
  const modmailConversations: unknown[] = [];
  const client = {
    reports,
    privateMessages,
    modmailConversations,
    async report(
      post: unknown,
      reportArgs: unknown
    ): Promise<{
      json: { errors: string[] };
    }> {
      reports.push({ post, reportArgs });
      return { json: { errors: args.reportErrors ?? [] } };
    },
    async sendPrivateMessage(message: unknown): Promise<void> {
      privateMessages.push(message);

      if (args.failPrivateMessage) {
        throw new Error('private message unavailable');
      }
    },
    modMail: {
      createConversation: async (conversation: unknown): Promise<void> => {
        modmailConversations.push(conversation);
      },
    },
  };

  return client as unknown as ApplyModerationActionArgs['redditClient'] & {
    reports: unknown[];
    privateMessages: unknown[];
    modmailConversations: unknown[];
  };
}

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

describe('settings normalization', () => {
  test('presents subreddit settings in the requested order and wording', () => {
    const subredditSettings = devvitConfig.settings.subreddit;

    expect(Object.keys(subredditSettings)).toEqual([
      'isActive',
      'trackingDurationHours',
      'positiveScoreStopThreshold',
      'negativeScoreThreshold',
      'actionToTake',
      'moderatorPostHandling',
    ]);
    expect(subredditSettings.trackingDurationHours.label).toBe(
      'How long should post scores be tracked?'
    );
    expect(subredditSettings.positiveScoreStopThreshold.label).toBe(
      'At what positive score should we stop tracking posts?'
    );
    expect(subredditSettings.negativeScoreThreshold.label).toBe(
      'At what negative score should we action a post?'
    );
    expect(subredditSettings.actionToTake).toMatchObject({
      label:
        'When a post is downvoted to the negative score, what should happen?',
      defaultValue: 'remove',
      options: [
        { label: 'Report to ModQueue', value: 'report' },
        { label: 'Filter (Report and Hide)', value: 'filter' },
        { label: 'Remove the Post, Lock the Comments', value: 'remove' },
      ],
    });
    expect(subredditSettings.moderatorPostHandling.label).toBe(
      'What should happen if a moderator post is downvoted?'
    );
    expect(subredditSettings.trackingDurationHours.defaultValue).toBe('4');
    expect(subredditSettings.positiveScoreStopThreshold.defaultValue).toBe('5');
    expect(subredditSettings.negativeScoreThreshold.defaultValue).toBe('-2');
  });

  test('defaults tracking duration to 4 hours when unset', () => {
    expect(normalizeSettings({}).trackingDurationHours).toBe(4);
  });

  test.each([2, 4, 6] as const)(
    'accepts current tracking duration %s hours',
    (trackingDurationHours) => {
      expect(
        normalizeSettings({ trackingDurationHours }).trackingDurationHours
      ).toBe(trackingDurationHours);
      expect(
        normalizeSettings({
          trackingDurationHours: String(trackingDurationHours),
        }).trackingDurationHours
      ).toBe(trackingDurationHours);
    }
  );

  test('accepts Devvit single-select array values for numeric settings', () => {
    expect(
      normalizeSettings({ trackingDurationHours: ['4'] }).trackingDurationHours
    ).toBe(4);
    expect(
      normalizeSettings({
        negativeScoreThreshold: ['-1'],
      }).negativeScoreThreshold
    ).toBe(-1);
    expect(
      normalizeSettings({
        positiveScoreStopThreshold: ['3'],
      }).positiveScoreStopThreshold
    ).toBe(3);
  });

  test.each([1, 3] as const)(
    'keeps legacy tracking duration %s hours for existing installs',
    (trackingDurationHours) => {
      expect(
        normalizeSettings({ trackingDurationHours }).trackingDurationHours
      ).toBe(trackingDurationHours);
    }
  );

  test.each([5, '', 'abc'] as const)(
    'falls back to 4 hours for invalid tracking duration %s',
    (trackingDurationHours) => {
      expect(
        normalizeSettings({ trackingDurationHours }).trackingDurationHours
      ).toBe(4);
    }
  );

  test.each([-1, -2, -3, -4, -5] as const)(
    'accepts negative score threshold %s',
    (negativeScoreThreshold) => {
      expect(
        normalizeSettings({ negativeScoreThreshold }).negativeScoreThreshold
      ).toBe(negativeScoreThreshold);
      expect(
        normalizeSettings({
          negativeScoreThreshold: String(negativeScoreThreshold),
        }).negativeScoreThreshold
      ).toBe(negativeScoreThreshold);
    }
  );

  test.each([-10, 0, '', 'abc'] as const)(
    'falls back to -2 for invalid negative score threshold %s',
    (negativeScoreThreshold) => {
      expect(
        normalizeSettings({ negativeScoreThreshold }).negativeScoreThreshold
      ).toBe(-2);
    }
  );

  test('accepts Devvit single-select array values for string settings', () => {
    expect(normalizeSettings({ actionToTake: ['remove'] }).actionToTake).toBe(
      ACTION_REMOVE
    );
    expect(
      normalizeSettings({
        moderatorPostHandling: ['ignore'],
      }).moderatorPostHandling
    ).toBe(MODERATOR_IGNORE);
  });

  test('falls back to -2 for empty negative score threshold arrays', () => {
    expect(
      normalizeSettings({ negativeScoreThreshold: [] }).negativeScoreThreshold
    ).toBe(-2);
  });

  test('falls back to -2 for invalid negative score threshold arrays', () => {
    expect(
      normalizeSettings({
        negativeScoreThreshold: ['abc'],
      }).negativeScoreThreshold
    ).toBe(-2);
  });
});

describe('backoff schedule', () => {
  test('uses incremental delays for post ages around 2, 5, 10, 20, then every 20 minutes', () => {
    expect(getNextCheckDelayMinutes(0)).toBe(2);
    expect(getNextCheckDelayMinutes(1)).toBe(3);
    expect(getNextCheckDelayMinutes(2)).toBe(5);
    expect(getNextCheckDelayMinutes(3)).toBe(10);
    expect(getNextCheckDelayMinutes(4)).toBe(20);
    expect(getNextCheckDelayMinutes(20)).toBe(20);
  });

  test('uses a 5 minute delay for advanced tracking checks', () => {
    expect(getNextCheckDelayMinutes(0, 'advanced')).toBe(5);
    expect(getNextCheckDelayMinutes(20, 'advanced')).toBe(5);
  });
});

describe('tracked-post scheduling', () => {
  test('commits a run token with the scheduled job', async () => {
    const jobs: unknown[] = [];
    const writes: unknown[] = [];
    const scheduled = await schedulePostCheck({
      record: trackedPost(),
      checkCount: 1,
      runAt: new Date(now + 60_000),
      dependencies: {
        createRunToken: () => 'run-token',
        now: () => now + 1,
        schedulerClient: {
          async runJob(job: unknown): Promise<string> {
            jobs.push(job);
            return 'job-id';
          },
          async cancelJob(): Promise<void> {},
        } as never,
        redisClient: {
          async set(...args: unknown[]): Promise<string> {
            writes.push(args);
            return 'OK';
          },
        } as never,
      },
    });

    expect(jobs).toEqual([
      expect.objectContaining({
        data: {
          postId: 't3_post',
          kind: 'check',
          runToken: 'run-token',
        },
      }),
    ]);
    expect(writes).toHaveLength(1);
    expect(scheduled).toMatchObject({
      checkCount: 1,
      lastJobId: 'job-id',
      scheduledRunToken: 'run-token',
    });
  });

  test('keeps a normal check when Redis committed before throwing', async () => {
    let storedRecord: string | undefined;
    const cancelled: string[] = [];
    const scheduled = await schedulePostCheck({
      record: trackedPost(),
      checkCount: 1,
      runAt: new Date(now + 60_000),
      dependencies: {
        createRunToken: () => 'committed-token',
        now: () => now + 1,
        schedulerClient: {
          async runJob(): Promise<string> {
            return 'committed-job';
          },
          async cancelJob(jobId: string): Promise<void> {
            cancelled.push(jobId);
          },
        } as never,
        redisClient: {
          async set(_key: string, value: string): Promise<string> {
            storedRecord = value;
            throw new Error('reply timed out');
          },
          async get(): Promise<string | undefined> {
            return storedRecord;
          },
        } as never,
      },
    });

    expect(scheduled).toMatchObject({
      lastJobId: 'committed-job',
      scheduledRunToken: 'committed-token',
    });
    expect(cancelled).toEqual([]);
  });

  test('keeps an initial check when its transaction committed before throwing', async () => {
    const values = new Map<string, string>();
    const cancelled: string[] = [];
    let tokenNumber = 0;
    type InitialTransaction = {
      multi(): Promise<void>;
      set(key: string, value: string): Promise<InitialTransaction>;
      hIncrBy(): Promise<InitialTransaction>;
      exec(): Promise<unknown[]>;
    };
    const transaction: InitialTransaction = {
      async multi(): Promise<void> {},
      async set(key: string, value: string): Promise<typeof transaction> {
        values.set(key, value);
        return transaction;
      },
      async hIncrBy(): Promise<typeof transaction> {
        return transaction;
      },
      async exec(): Promise<unknown[]> {
        throw new Error('transaction reply timed out');
      },
    };
    const result = await scheduleInitialPostCheck({
      record: trackedPost(),
      runAt: new Date(now + 60_000),
      dependencies: {
        createRunToken: () => `initial-token-${++tokenNumber}`,
        now: () => now,
        schedulerClient: {
          async runJob(): Promise<string> {
            return 'initial-job';
          },
          async cancelJob(jobId: string): Promise<void> {
            cancelled.push(jobId);
          },
        } as never,
        redisClient: {
          async set(
            key: string,
            value: string,
            options?: { nx?: boolean }
          ): Promise<string | undefined> {
            if (options?.nx && values.has(key)) {
              return undefined;
            }
            values.set(key, value);
            return 'OK';
          },
          async get(key: string): Promise<string | undefined> {
            return values.get(key);
          },
          async del(key: string): Promise<void> {
            values.delete(key);
          },
          async mGet(keys: string[]): Promise<(string | null)[]> {
            return keys.map((key) => values.get(key) ?? null);
          },
          async watch(): Promise<typeof transaction> {
            return transaction;
          },
        } as never,
      },
    });

    expect(result.status).toBe('scheduled');
    expect(cancelled).toEqual([]);
  });

  test('keeps an action recovery when Redis committed before throwing', async () => {
    let storedRecord: string | undefined;
    const cancelled: string[] = [];
    const scheduled = await scheduleActionRecovery({
      record: trackedPost({
        status: 'actioning',
        actionAttemptId: 'attempt-1',
      }),
      runAt: new Date(now + 60_000),
      actionAttemptId: 'attempt-1',
      dependencies: {
        createRunToken: () => 'recovery-token',
        schedulerClient: {
          async runJob(): Promise<string> {
            return 'recovery-job';
          },
          async cancelJob(jobId: string): Promise<void> {
            cancelled.push(jobId);
          },
        } as never,
        redisClient: {
          async set(_key: string, value: string): Promise<string> {
            storedRecord = value;
            throw new Error('reply timed out');
          },
          async get(): Promise<string | undefined> {
            return storedRecord;
          },
        } as never,
      },
    });

    expect(scheduled).toMatchObject({
      actionAttemptId: 'attempt-1',
      actionRecoveryJobId: 'recovery-job',
      actionRecoveryRunToken: 'recovery-token',
    });
    expect(cancelled).toEqual([]);
  });

  test('cancels a recovery job when the stored action attempt differs', async () => {
    const cancelled: string[] = [];
    await expect(
      scheduleActionRecovery({
        record: trackedPost({
          status: 'actioning',
          actionAttemptId: 'attempt-new',
        }),
        runAt: new Date(now + 60_000),
        actionAttemptId: 'attempt-new',
        dependencies: {
          createRunToken: () => 'recovery-token',
          schedulerClient: {
            async runJob(): Promise<string> {
              return 'recovery-job';
            },
            async cancelJob(jobId: string): Promise<void> {
              cancelled.push(jobId);
            },
          } as never,
          redisClient: {
            async set(): Promise<string> {
              throw new Error('redis unavailable');
            },
            async get(): Promise<string> {
              return serializeTrackedPost(
                trackedPost({
                  status: 'actioning',
                  actionAttemptId: 'attempt-old',
                  actionRecoveryJobId: 'recovery-job',
                  actionRecoveryRunToken: 'recovery-token',
                })
              );
            },
          } as never,
        },
      })
    ).rejects.toThrow('redis unavailable');
    expect(cancelled).toEqual(['recovery-job']);
  });

  test.each([
    ['malformed record', async (): Promise<string> => '{not-json'],
    [
      'read-back failure',
      async (): Promise<string> => {
        throw new Error('read unavailable');
      },
    ],
  ])(
    'preserves a job when commit verification has a %s',
    async (_name, get) => {
      const cancelled: string[] = [];
      await expect(
        schedulePostCheck({
          record: trackedPost(),
          checkCount: 1,
          runAt: new Date(now + 60_000),
          dependencies: {
            createRunToken: () => 'unknown-token',
            schedulerClient: {
              async runJob(): Promise<string> {
                return 'unknown-job';
              },
              async cancelJob(jobId: string): Promise<void> {
                cancelled.push(jobId);
              },
            } as never,
            redisClient: {
              async set(): Promise<string> {
                throw new Error('redis unavailable');
              },
              get,
            } as never,
          },
        })
      ).rejects.toThrow('redis unavailable');
      expect(cancelled).toEqual([]);
    }
  );

  test('cancels a job when a valid read-back contains a different token', async () => {
    const cancelled: string[] = [];
    await expect(
      schedulePostCheck({
        record: trackedPost(),
        checkCount: 1,
        runAt: new Date(now + 60_000),
        dependencies: {
          createRunToken: () => 'new-token',
          schedulerClient: {
            async runJob(): Promise<string> {
              return 'new-job';
            },
            async cancelJob(jobId: string): Promise<void> {
              cancelled.push(jobId);
            },
          } as never,
          redisClient: {
            async set(): Promise<string> {
              throw new Error('redis unavailable');
            },
            async get(): Promise<string> {
              return serializeTrackedPost(
                trackedPost({
                  lastJobId: 'newer-job',
                  scheduledRunToken: 'newer-token',
                })
              );
            },
          } as never,
        },
      })
    ).rejects.toThrow('redis unavailable');
    expect(cancelled).toEqual(['new-job']);
  });

  test('cancels a job when its Redis record cannot be committed', async () => {
    const cancelled: string[] = [];
    await expect(
      schedulePostCheck({
        record: trackedPost(),
        checkCount: 1,
        runAt: new Date(now + 60_000),
        dependencies: {
          createRunToken: () => 'orphan-token',
          schedulerClient: {
            async runJob(): Promise<string> {
              return 'orphan-job';
            },
            async cancelJob(jobId: string): Promise<void> {
              cancelled.push(jobId);
            },
          } as never,
          redisClient: {
            async set(): Promise<string> {
              throw new Error('redis unavailable');
            },
            async get(): Promise<undefined> {
              return undefined;
            },
          } as never,
        },
      })
    ).rejects.toThrow('redis unavailable');
    expect(cancelled).toEqual(['orphan-job']);
  });

  test('cancels an initial job when the Redis transaction is aborted', async () => {
    const cancelled: string[] = [];
    type TestTransaction = {
      multi(): Promise<void>;
      set(): Promise<TestTransaction>;
      hIncrBy(): Promise<TestTransaction>;
      exec(): Promise<unknown[]>;
    };
    const transaction: TestTransaction = {
      async multi(): Promise<void> {},
      async set(): Promise<typeof transaction> {
        return transaction;
      },
      async hIncrBy(): Promise<typeof transaction> {
        return transaction;
      },
      async exec(): Promise<unknown[]> {
        return [];
      },
    };

    await expect(
      schedulePostCheck({
        record: trackedPost(),
        checkCount: 0,
        runAt: new Date(now + 60_000),
        incrementStarted: true,
        dependencies: {
          createRunToken: () => 'initial-token',
          schedulerClient: {
            async runJob(): Promise<string> {
              return 'initial-job';
            },
            async cancelJob(jobId: string): Promise<void> {
              cancelled.push(jobId);
            },
          } as never,
          redisClient: {
            async watch(): Promise<typeof transaction> {
              return transaction;
            },
          } as never,
        },
      })
    ).rejects.toThrow('Initial tracking transaction was not committed.');
    expect(cancelled).toEqual(['initial-job']);
  });

  test('does not mask a Redis failure when orphan cancellation also fails', async () => {
    const errorSpy = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => {});
    await expect(
      schedulePostCheck({
        record: trackedPost(),
        checkCount: 1,
        runAt: new Date(now + 60_000),
        dependencies: {
          schedulerClient: {
            async runJob(): Promise<string> {
              return 'uncancelled-job';
            },
            async cancelJob(): Promise<void> {
              throw new Error('scheduler unavailable');
            },
          } as never,
          redisClient: {
            async set(): Promise<string> {
              throw new Error('redis unavailable');
            },
            async get(): Promise<undefined> {
              return undefined;
            },
          } as never,
        },
      })
    ).rejects.toThrow('redis unavailable');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('accepts legacy jobs only for legacy records and rejects stale tokens', () => {
    expect(isCurrentCheckDelivery(trackedPost(), { postId: 't3_post' })).toBe(
      true
    );
    expect(
      isCurrentCheckDelivery(
        trackedPost({ scheduledRunToken: 'current-token' }),
        { postId: 't3_post' }
      )
    ).toBe(false);
    expect(
      isCurrentCheckDelivery(
        trackedPost({ scheduledRunToken: 'current-token' }),
        { postId: 't3_post', runToken: 'stale-token' }
      )
    ).toBe(false);
    expect(
      isCurrentCheckDelivery(
        trackedPost({ scheduledRunToken: 'current-token' }),
        { postId: 't3_post', runToken: 'current-token' }
      )
    ).toBe(true);
  });

  test('serializes duplicate initial scheduling and increments started once', async () => {
    const values = new Map<string, string>();
    const jobs: unknown[] = [];
    let startedIncrements = 0;
    type InitialTransaction = {
      multi(): Promise<void>;
      set(key: string, value: string): Promise<InitialTransaction>;
      hIncrBy(): Promise<InitialTransaction>;
      exec(): Promise<unknown[]>;
    };
    const transaction: InitialTransaction = {
      async multi(): Promise<void> {},
      async set(key: string, value: string): Promise<typeof transaction> {
        values.set(key, value);
        return transaction;
      },
      async hIncrBy(): Promise<typeof transaction> {
        startedIncrements += 1;
        return transaction;
      },
      async exec(): Promise<unknown[]> {
        return ['OK', startedIncrements];
      },
    };
    const redisClient = {
      async set(
        key: string,
        value: string,
        options?: { nx?: boolean }
      ): Promise<string | undefined> {
        if (options?.nx && values.has(key)) {
          return undefined;
        }
        values.set(key, value);
        return 'OK';
      },
      async get(key: string): Promise<string | undefined> {
        return values.get(key);
      },
      async del(key: string): Promise<void> {
        values.delete(key);
      },
      async mGet(keys: string[]): Promise<(string | null)[]> {
        return keys.map((key) => values.get(key) ?? null);
      },
      async watch(): Promise<typeof transaction> {
        return transaction;
      },
    };
    const dependencies = {
      createRunToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
      now: () => now,
      redisClient: redisClient as never,
      schedulerClient: {
        async runJob(job: unknown): Promise<string> {
          jobs.push(job);
          return `job-${jobs.length}`;
        },
        async cancelJob(): Promise<void> {},
      } as never,
    };

    const results = await Promise.all([
      scheduleInitialPostCheck({
        record: trackedPost(),
        runAt: new Date(now + 60_000),
        dependencies,
      }),
      scheduleInitialPostCheck({
        record: trackedPost(),
        runAt: new Date(now + 60_000),
        dependencies,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'already_tracking',
      'scheduled',
    ]);
    expect(jobs).toHaveLength(1);
    expect(startedIncrements).toBe(1);
    expect(values.has(initializationClaimKey('t3_post'))).toBe(false);
  });
});

describe('idempotent terminal finalization', () => {
  function finalizationRedis(options: { throwAfterCommit?: boolean } = {}) {
    const values = new Map<string, string>();
    const increments: string[] = [];
    let execCount = 0;
    type FinalizationTransaction = {
      multi(): Promise<void>;
      set(key: string, value: string): Promise<FinalizationTransaction>;
      hIncrBy(key: string, field: string): Promise<FinalizationTransaction>;
      del(...keys: string[]): Promise<FinalizationTransaction>;
      exec(): Promise<unknown[]>;
    };
    const transaction: FinalizationTransaction = {
      async multi(): Promise<void> {},
      async set(key: string, value: string): Promise<typeof transaction> {
        values.set(key, value);
        return transaction;
      },
      async hIncrBy(_key: string, field: string): Promise<typeof transaction> {
        increments.push(field);
        return transaction;
      },
      async del(...keys: string[]): Promise<typeof transaction> {
        for (const key of keys) values.delete(key);
        return transaction;
      },
      async exec(): Promise<unknown[]> {
        execCount += 1;
        if (options.throwAfterCommit) {
          throw new Error('connection closed after commit');
        }
        return ['OK', 1, 1, 1];
      },
    };
    const redisClient = {
      async set(
        key: string,
        value: string,
        setOptions?: { nx?: boolean }
      ): Promise<string | undefined> {
        if (setOptions?.nx && values.has(key)) return undefined;
        values.set(key, value);
        return 'OK';
      },
      async get(key: string): Promise<string | undefined> {
        return values.get(key);
      },
      async del(key: string): Promise<void> {
        values.delete(key);
      },
      async watch(): Promise<typeof transaction> {
        return transaction;
      },
    };
    return { values, increments, redisClient, getExecCount: () => execCount };
  }

  test('writes audit and counters only once across duplicate finalizers', async () => {
    const state = finalizationRedis();
    const args: Parameters<typeof finalizeTrackedPost>[0] = {
      record: trackedPost({
        status: 'actioning',
        actionAttemptId: 'attempt-1',
        attemptedAction: 'filter',
      }),
      status: 'actioned' as const,
      successfulAction: ACTION_FILTER,
      dependencies: {
        redisClient: state.redisClient as never,
        createClaimToken: () => 'claim-token',
        now: () => now,
      },
    };

    expect(await finalizeTrackedPost(args)).toEqual({ status: 'committed' });
    expect(await finalizeTrackedPost(args)).toEqual({
      status: 'already_finalized',
    });
    expect(state.getExecCount()).toBe(1);
    expect(state.increments).toEqual(['actioned', 'action_filter']);
    expect(state.values.has(finalizationClaimKey('t3_post'))).toBe(false);
  });

  test('recognizes a commit when the transaction response throws', async () => {
    const state = finalizationRedis({ throwAfterCommit: true });
    const result = await finalizeTrackedPost({
      record: trackedPost({ status: 'actioning' }),
      status: 'action_unknown',
      dependencies: {
        redisClient: state.redisClient as never,
        createClaimToken: () => 'claim-token',
        now: () => now,
      },
    });

    expect(result).toEqual({ status: 'already_finalized' });
    expect(state.getExecCount()).toBe(1);
    expect(state.increments).toEqual(['action_unknown']);
  });

  test('defers without writing when another finalizer owns the claim', async () => {
    const state = finalizationRedis();
    state.values.set(finalizationClaimKey('t3_post'), 'other-owner');

    expect(
      await finalizeTrackedPost({
        record: trackedPost({ status: 'actioning' }),
        status: 'action_unknown',
        dependencies: {
          redisClient: state.redisClient as never,
          createClaimToken: () => 'claim-token',
          now: () => now,
        },
      })
    ).toEqual({ status: 'retry_required', reason: 'claim_busy' });
    expect(state.getExecCount()).toBe(0);
    expect(state.increments).toEqual([]);
  });
});

describe('at-most-once action recovery', () => {
  test('preserves known successful and failed outcomes', () => {
    expect(
      resolveActionRecovery(
        trackedPost({ actionOutcome: 'succeeded', attemptedAction: 'report' })
      )
    ).toEqual({
      status: 'actioned',
      outcome: 'succeeded',
      confirmedApplied: true,
    });
    expect(
      resolveActionRecovery(
        trackedPost({ actionOutcome: 'failed', attemptedAction: 'filter' })
      )
    ).toEqual({
      status: 'action_failed',
      outcome: 'failed',
      confirmedApplied: false,
    });
  });

  test('confirms remove and filter from a refetched post without another action', () => {
    expect(
      resolveActionRecovery(trackedPost({ attemptedAction: 'remove' }), {
        removed: true,
      })
    ).toMatchObject({ status: 'actioned', confirmedApplied: true });
    expect(
      resolveActionRecovery(trackedPost({ attemptedAction: 'filter' }), {
        filtered: true,
      })
    ).toMatchObject({ status: 'actioned', confirmedApplied: true });
  });

  test('leaves unconfirmed and report attempts unknown for moderator review', () => {
    expect(
      resolveActionRecovery(trackedPost({ attemptedAction: 'remove' }), {})
    ).toMatchObject({ status: 'action_unknown', confirmedApplied: false });
    expect(
      resolveActionRecovery(trackedPost({ attemptedAction: 'report' }), {
        removed: true,
      })
    ).toMatchObject({ status: 'action_unknown', confirmedApplied: false });
  });
});

describe('Firebase ratio router client', () => {
  const config: FirebaseRouterConfig = {
    hmacSecret: 'router-secret',
  };

  function successBody(
    overrides: Partial<{
      apiVersion: string;
      postId: string;
      upvoteRatio: number | null;
      score: number | null;
      rawName: string;
      rawId: string;
    }> = {}
  ): string {
    return JSON.stringify({
      apiVersion: overrides.apiVersion ?? '1',
      ok: true,
      postId: overrides.postId ?? 't3_post',
      upvoteRatio:
        overrides.upvoteRatio === undefined ? 0.33 : overrides.upvoteRatio,
      score: overrides.score === undefined ? -1 : overrides.score,
      rawName: overrides.rawName ?? 't3_post',
      rawId: overrides.rawId ?? 'post',
    });
  }

  function mockRouterFetch(
    args: {
      ok?: boolean;
      status?: number;
      body?: string;
    } = {}
  ): {
    calls: Array<{
      url: string;
      init: Parameters<FirebaseRouterFetch>[1];
    }>;
    fetchImpl: FirebaseRouterFetch;
  } {
    const calls: Array<{
      url: string;
      init: Parameters<FirebaseRouterFetch>[1];
    }> = [];

    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: args.ok ?? true,
          status: args.status ?? 200,
          statusText: args.ok === false ? 'Too Many Requests' : 'OK',
          async text(): Promise<string> {
            return args.body ?? successBody();
          },
        };
      },
    };
  }

  test('uses the fixed Firebase endpoint and ignores stale URL settings', () => {
    expect(
      readFirebaseRouterConfigFromSettings({
        PRAW_ROUTER_URL:
          'https://api-id.execute-api.us-east-1.amazonaws.com/prod/v1/post-ratio',
        PRAW_ROUTER_HMAC_SECRET: config.hmacSecret,
      })
    ).toEqual({ hmacSecret: config.hmacSecret });
  });

  test('requires a non-blank HMAC secret', () => {
    expect(readFirebaseRouterConfigFromSettings({})).toBeNull();
    expect(
      readFirebaseRouterConfigFromSettings({
        PRAW_ROUTER_HMAC_SECRET: '   ',
      })
    ).toBeNull();
  });

  test('generates the expected deterministic HMAC signature', () => {
    expect(
      signFirebaseRouterRequest({
        timestamp: 1_700_000_000,
        body: '{"postId":"t3_post"}',
        hmacSecret: config.hmacSecret,
      })
    ).toBe('bbd4656ee2a587cd89acef08bb89fae75c5eefeb59325cb8c8ced35218e23d3a');
  });

  test('posts a signed request and parses the ratio snapshot', async () => {
    const router = mockRouterFetch();
    const result = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config,
      fetchImpl: router.fetchImpl,
      now,
    });

    expect(result).toMatchObject({
      ok: true,
      postId: 't3_post',
      source: 'firebase_router',
      endpoint: 'post_ratio',
      upvoteRatio: 0.33,
      ratioPercent: '33.0%',
      score: -1,
      rawName: 't3_post',
      rawId: 'post',
    });
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]?.url).toBe(FIREBASE_RATIO_ROUTER_URL);
    expect(router.calls[0]?.init).toMatchObject({
      method: 'POST',
      body: '{"postId":"t3_post"}',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Timestamp': '1700000000',
        'X-Request-Signature':
          'v1=bbd4656ee2a587cd89acef08bb89fae75c5eefeb59325cb8c8ced35218e23d3a',
      },
    });
  });

  test('returns structured failure when router configuration is missing', async () => {
    const result = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config: readFirebaseRouterConfigFromSettings({}),
      fetchImpl: mockRouterFetch().fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      source: 'firebase_router',
      upvoteRatio: null,
      error: 'Firebase ratio router HMAC secret is missing.',
    });
  });

  test('accepts a matching post with no reported ratio', async () => {
    const result = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockRouterFetch({
        body: successBody({ upvoteRatio: null }),
      }).fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      upvoteRatio: null,
      ratioPercent: null,
    });
  });

  test('rejects mismatched posts and invalid ratios', async () => {
    const mismatch = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockRouterFetch({
        body: successBody({
          postId: 't3_other',
          rawName: 't3_other',
          rawId: 'other',
        }),
      }).fetchImpl,
    });
    const invalidRatio = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockRouterFetch({
        body: successBody({ upvoteRatio: 1.1 }),
      }).fetchImpl,
    });

    expect(mismatch).toMatchObject({
      ok: false,
      error: 'Firebase ratio router returned a different post.',
      rawName: 't3_other',
      rawId: 'other',
    });
    expect(invalidRatio).toMatchObject({
      ok: false,
      error: 'Firebase ratio router returned an invalid success response.',
    });
  });

  test('returns non-2xx and malformed responses as score-only failures', async () => {
    const limited = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockRouterFetch({
        ok: false,
        status: 429,
        body: '{"apiVersion":"1","ok":false}',
      }).fetchImpl,
    });
    const malformed = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockRouterFetch({ body: '{"broken"' }).fetchImpl,
    });

    expect(limited).toMatchObject({
      ok: false,
      httpStatus: 429,
      upvoteRatio: null,
      error: expect.stringContaining('Firebase ratio router HTTP 429'),
    });
    expect(malformed).toMatchObject({
      ok: false,
      upvoteRatio: null,
    });
  });

  test('aborts router calls that exceed the configured timeout', async () => {
    const fetchImpl: FirebaseRouterFetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });

    const result = await fetchFirebaseRouterVoteSnapshot('t3_post', {
      config,
      fetchImpl,
      timeoutMs: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'Firebase ratio router request timed out.',
    });
  });
});

describe('vote ratio confidence model', () => {
  const lookup = buildRatioLookup(30);

  test('exports named ratio thresholds', () => {
    expect(advancedTrackingMaxRatio).toBe(0.4);
  });

  test('invalid ratio does not remove', () => {
    expect(
      shouldRemoveByRatio({
        ratio: Number.NaN,
        moderatorThreshold: -1,
        minimumTotalVotes: 12,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      reason: 'invalid_ratio',
      guaranteedSpread: null,
      updatedMinimumTotalVotes: 12,
      possibleStates: [],
    });

    expect(
      shouldRemoveByRatio({
        ratio: Number.POSITIVE_INFINITY,
        moderatorThreshold: -1,
        minimumTotalVotes: 12,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      reason: 'invalid_ratio',
    });
  });

  test('ratio <= 0.24 still respects the configured threshold', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.24,
        moderatorThreshold: -30,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      reason: 'continue_tracking',
    });

    expect(
      shouldRemoveByRatio({
        ratio: 0,
        moderatorThreshold: -1,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({ remove: true });
    expect(
      shouldRemoveByRatio({
        ratio: 0,
        moderatorThreshold: -5,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({ remove: false });
  });

  test('ratio > 0.40 never removes from ratio alone', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.41,
        moderatorThreshold: -1,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      reason: 'ratio_above_tracking_range',
    });
  });

  test('0.25 with minTotal 0 and threshold -2 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.25,
        moderatorThreshold: -2,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      reason: 'guaranteed_spread_threshold_met',
      guaranteedSpread: -2,
      updatedMinimumTotalVotes: 4,
    });
  });

  test('0.25 with minTotal 0 and threshold -3 does not remove', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.25,
        moderatorThreshold: -3,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      reason: 'continue_tracking',
      guaranteedSpread: -2,
    });
  });

  test('0.25 with minTotal 8 and threshold -4 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.25,
        moderatorThreshold: -4,
        minimumTotalVotes: 8,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      guaranteedSpread: -4,
      updatedMinimumTotalVotes: 8,
    });
  });

  test('0.33 with minTotal 0 and threshold -3 does not remove', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.33,
        moderatorThreshold: -3,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      guaranteedSpread: -1,
      updatedMinimumTotalVotes: 3,
    });
  });

  test('0.33 with minTotal 9 and threshold -3 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.33,
        moderatorThreshold: -3,
        minimumTotalVotes: 9,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      guaranteedSpread: -3,
      updatedMinimumTotalVotes: 9,
    });
  });

  test('0.33 with minTotal 15 and threshold -5 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.33,
        moderatorThreshold: -5,
        minimumTotalVotes: 15,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      guaranteedSpread: -5,
      updatedMinimumTotalVotes: 15,
    });
  });

  test('0.38 with minTotal 0 and threshold -3 does not remove', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.38,
        moderatorThreshold: -3,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      guaranteedSpread: -2,
      updatedMinimumTotalVotes: 8,
    });
  });

  test('0.38 with minTotal 13 and threshold -3 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.38,
        moderatorThreshold: -3,
        minimumTotalVotes: 13,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      guaranteedSpread: -3,
      updatedMinimumTotalVotes: 13,
    });
  });

  test('0.40 with minTotal 0 and threshold -3 does not remove', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.4,
        moderatorThreshold: -3,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      guaranteedSpread: -1,
      updatedMinimumTotalVotes: 5,
    });
  });

  test('0.40 with minTotal 15 and threshold -3 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.4,
        moderatorThreshold: -3,
        minimumTotalVotes: 15,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      guaranteedSpread: -3,
      updatedMinimumTotalVotes: 15,
    });
  });

  test('0.29 with minTotal 0 and threshold -3 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.29,
        moderatorThreshold: -3,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      guaranteedSpread: -3,
      updatedMinimumTotalVotes: 7,
    });
  });

  test('0.30 with minTotal 0 and threshold -4 removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.3,
        moderatorThreshold: -4,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      guaranteedSpread: -4,
      updatedMinimumTotalVotes: 10,
    });
  });

  test('no exact state after filtering does not remove', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.25,
        moderatorThreshold: -2,
        minimumTotalVotes: 31,
        lookup,
      })
    ).toMatchObject({
      remove: false,
      reason: 'no_possible_states_after_filter',
      guaranteedSpread: null,
      updatedMinimumTotalVotes: 31,
      possibleStates: [],
    });
  });

  test('minimumTotalVotes never decreases', () => {
    const state: TrackedPostVoteState = {
      postId: 't3_post',
      createdAt: now,
      lastCheckedAt: now,
      latestScore: 0,
      latestUpvoteRatio: null,
      minimumTotalVotes: 15,
      maximumTotalVotesCap: 30,
      guaranteedSpread: null,
      possibleStates: [],
      consecutiveNegativeChecks: 0,
      lastActionDecision: 'none',
    };

    expect(
      updateTrackedPostVoteState({
        state,
        ratio: 0.33,
        latestScore: 0,
        moderatorThreshold: -3,
        checkedAt: now + 1_000,
        lookup,
      }).minimumTotalVotes
    ).toBe(15);
  });

  test('guaranteedSpread uses maximum spread among possible states', () => {
    const evaluation = evaluateRatioState({
      ratio: 0.33,
      moderatorThreshold: -3,
      minimumTotalVotes: 9,
      lookup,
    });

    expect(evaluation.guaranteedSpread).toBe(-3);
    expect(
      Math.min(...evaluation.possibleStates.map((state) => state.spread))
    ).toBe(-10);
  });
});

describe('tracked post decisions', () => {
  test('validates and persists post lock audit fields', () => {
    const serialized = serializeTrackedPost(
      trackedPost({
        postLockStatus: 'failed',
        postLockErrorMessage: 'post lock unavailable',
      })
    );

    expect(parseTrackedPost(serialized)).toMatchObject({
      postLockStatus: 'failed',
      postLockErrorMessage: 'post lock unavailable',
    });
    expect(
      parseTrackedPostResult(
        JSON.stringify({ ...trackedPost(), postLockStatus: 'unknown' })
      )
    ).toEqual({ ok: false, error: 'invalid_postLockStatus' });
  });

  test('reads legacy modmail audit fields but omits them from new writes', () => {
    const legacyValue = JSON.stringify({
      ...trackedPost(),
      modmailStatus: 'failed',
      modmailSentAt: now,
      modmailSkippedReason: 'legacy_skip',
      modmailErrorMessage: 'legacy_error',
    });
    const legacyRecord = parseTrackedPost(legacyValue);

    expect(legacyRecord).toMatchObject({
      modmailStatus: 'failed',
      modmailSentAt: now,
      modmailSkippedReason: 'legacy_skip',
      modmailErrorMessage: 'legacy_error',
    });

    const serialized = serializeTrackedPost({
      ...legacyRecord!,
      privateMessageStatus: 'sent',
      privateMessageSentAt: now + 1,
    });

    expect(JSON.parse(serialized)).toMatchObject({
      privateMessageStatus: 'sent',
      privateMessageSentAt: now + 1,
    });
    expect(serialized).not.toContain('modmail');
  });

  test('keeps legacy router sources readable and persists new Firebase sources', () => {
    const legacyRecord = parseTrackedPost(
      serializeTrackedPost(
        trackedPost({ lastAuthenticatedRatioSource: 'praw_router' })
      )
    );
    const firebaseRecord = parseTrackedPost(
      serializeTrackedPost(
        trackedPost({ lastAuthenticatedRatioSource: 'firebase_router' })
      )
    );

    expect(legacyRecord?.lastAuthenticatedRatioSource).toBe('praw_router');
    expect(firebaseRecord?.lastAuthenticatedRatioSource).toBe(
      'firebase_router'
    );
  });

  test('validates tracked Redis records while allowing unknown future fields', () => {
    const value = JSON.stringify({ ...trackedPost(), futureField: 'allowed' });
    const result = parseTrackedPostResult(value);

    expect(result.ok).toBe(true);
    expect(parseTrackedPost(value)).toMatchObject({ postId: 't3_post' });
  });

  test.each([
    [undefined, 'record_missing'],
    ['{broken', 'invalid_json'],
    ['null', 'record_not_object'],
    ['[]', 'record_not_object'],
    ['{}', 'invalid_subredditId'],
    [JSON.stringify({ ...trackedPost(), status: 'mystery' }), 'invalid_status'],
    [
      JSON.stringify({ ...trackedPost(), actionToTake: 'ban' }),
      'invalid_actionToTake',
    ],
    [
      JSON.stringify({ ...trackedPost(), checkCount: -1 }),
      'invalid_checkCount',
    ],
    [
      JSON.stringify({ ...trackedPost(), trackingExpiresAt: null }),
      'invalid_trackingExpiresAt',
    ],
  ])('rejects invalid tracked record %s', (value, expectedError) => {
    expect(parseTrackedPostResult(value)).toEqual({
      ok: false,
      error: expectedError,
    });
    expect(parseTrackedPost(value)).toBeNull();
  });

  test('calculates vote score from upvotes and downvotes', () => {
    expect(calculateVoteScore({ upvotes: 1, downvotes: 2 })).toBe(-1);
  });

  test('keeps calculated vote score diagnostic but does not action from it', () => {
    const post = postSnapshot({ score: 0, upvotes: 1, downvotes: 4 });

    expect(getNegativeDecisionScore(post)).toEqual({
      score: 0,
      source: 'reddit_score',
      calculatedVoteScore: -3,
    });

    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post,
        now,
      })
    ).toEqual({ type: 'reschedule' });
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

  test('uses normal score for decisions even when calculated votes are lower', () => {
    expect(
      getNegativeDecisionScore(
        postSnapshot({
          score: 0,
          upvotes: 2,
          downvotes: 4,
        })
      )
    ).toEqual({
      score: 0,
      source: 'reddit_score',
      calculatedVoteScore: -2,
    });
  });

  test('positive stop still uses normal Reddit score instead of calculated votes', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({
          negativeScoreThreshold: -3,
          positiveScoreStopThreshold: 5,
        }),
        settings: activeSettings,
        post: postSnapshot({
          score: 5,
          upvotes: 1,
          downvotes: 10,
        }),
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

  test('actions at the -1 configured negative score threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -1 }),
        settings: activeSettings,
        post: postSnapshot({ score: -1 }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('actions at the -4 configured negative score threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -4 }),
        settings: activeSettings,
        post: postSnapshot({ score: -4 }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('scheduled score decisions use refreshed current settings instead of stale stored thresholds', () => {
    const staleRecord = trackedPost({ negativeScoreThreshold: -3 });
    const currentSettings: DownvoteDeleteSettings = {
      ...activeSettings,
      negativeScoreThreshold: -1,
    };
    const refreshedRecord = refreshTrackedPostActionSettings(
      staleRecord,
      currentSettings
    );

    expect(
      decideTrackedPostCheck({
        tracking: refreshedRecord,
        settings: currentSettings,
        post: postSnapshot({ score: -1 }),
        now,
      })
    ).toEqual({ type: 'action' });
    expect(refreshedRecord.negativeScoreThreshold).toBe(-1);
  });

  test('scheduled ratio decisions use refreshed current settings instead of stale stored thresholds', () => {
    const staleRecord = trackedPost({
      negativeScoreThreshold: -3,
      minimumTotalVotes: 3,
    });
    const currentSettings: DownvoteDeleteSettings = {
      ...activeSettings,
      negativeScoreThreshold: -1,
    };
    const refreshedRecord = refreshTrackedPostActionSettings(
      staleRecord,
      currentSettings
    );

    expect(
      shouldRemoveByRatio({
        ratio: 0.33,
        moderatorThreshold: refreshedRecord.negativeScoreThreshold,
        minimumTotalVotes: refreshedRecord.minimumTotalVotes ?? 0,
      })
    ).toMatchObject({
      remove: true,
      reason: 'guaranteed_spread_threshold_met',
      guaranteedSpread: -1,
      updatedMinimumTotalVotes: 3,
    });
  });

  test('refreshing current settings does not recalculate tracking expiration', () => {
    const staleRecord = trackedPost({
      trackingExpiresAt: now + 2 * 60 * 60 * 1000,
      negativeScoreThreshold: -3,
    });
    const currentSettings: DownvoteDeleteSettings = {
      ...activeSettings,
      trackingDurationHours: 6,
      negativeScoreThreshold: -1,
    };

    expect(
      refreshTrackedPostActionSettings(staleRecord, currentSettings)
    ).toMatchObject({
      negativeScoreThreshold: -1,
      trackingExpiresAt: staleRecord.trackingExpiresAt,
    });
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

  test('expired posts do not action even when score reaches threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({
          trackingExpiresAt: now,
          negativeScoreThreshold: -3,
        }),
        settings: activeSettings,
        post: postSnapshot({ score: -10 }),
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

describe('removal private message notifications', () => {
  test('builds the requested removal private message body', () => {
    const body = buildRemovedForDownvotesPrivateMessageBody({
      username: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(body).toContain('Hi u/someUser,');
    expect(body).toContain(
      'Your post was removed because it received too much negative community feedback.'
    );
    expect(body).toContain('https://reddit.com/r/mySubreddit/about/rules');
    expect(body).toContain(
      '*Removed post: https://reddit.com/r/mySubreddit/comments/abc123*'
    );
    expect(body).toBe(`Hi u/someUser,

Your post was removed because it received too much negative community feedback.

Posts may be downvoted for many reasons, including rule issues, content quality, or controversial opinions. This removal helps prevent your account from accumulating additional negative karma from the post.

Please review the [community rules](https://reddit.com/r/mySubreddit/about/rules) before posting again.


*Removed post: https://reddit.com/r/mySubreddit/comments/abc123*`);
  });

  test('sends a direct message after a successful remove action', async () => {
    const redditClient = mockRedditClient();
    const post = mockPost();

    const result = await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      authorName: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(post.removeCalls).toEqual([false]);
    expect(post.lockCalls).toBe(1);
    expect(post.actionCalls).toEqual(['lock', 'remove']);
    expect(post.removalNotes).toEqual([
      { reasonId: '', modNote: 'Removed for -3 Downvote Karma' },
    ]);
    expect(redditClient.privateMessages).toEqual([
      {
        to: 'someUser',
        subject: REMOVAL_PRIVATE_MESSAGE_SUBJECT,
        text: buildRemovedForDownvotesPrivateMessageBody({
          username: 'someUser',
          subredditName: 'mySubreddit',
          postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
        }),
      },
    ]);
    expect(redditClient.modmailConversations).toEqual([]);
    expect(result.privateMessageSentAt).toEqual(expect.any(Number));
    expect(result.actionStatus).toBe('succeeded');
    expect(result.postLockStatus).toBe('locked');
    expect(result.removalNoteStatus).toBe('added');
    expect(result.privateMessageStatus).toBe('sent');
    expect(result.privateMessageErrorMessage).toBeUndefined();
  });

  test('sends a direct message to a moderator author', async () => {
    const redditClient = mockRedditClient();

    const result = await applyModerationAction({
      redditClient,
      post: mockPost(),
      action: ACTION_REMOVE,
      threshold: -3,
      authorName: 'moderatorUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(redditClient.privateMessages).toEqual([
      expect.objectContaining({ to: 'moderatorUser' }),
    ]);
    expect(redditClient.modmailConversations).toEqual([]);
    expect(result.privateMessageStatus).toBe('sent');
  });

  test('removes and notifies when locking the post fails', async () => {
    const redditClient = mockRedditClient();
    const post = mockPost({ failLock: true });

    const result = await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      authorName: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(post.actionCalls).toEqual(['lock', 'remove']);
    expect(post.removeCalls).toEqual([false]);
    expect(post.removalNotes).toHaveLength(1);
    expect(redditClient.privateMessages).toHaveLength(1);
    expect(result).toMatchObject({
      actionStatus: 'succeeded',
      postLockStatus: 'failed',
      postLockErrorMessage: 'post lock unavailable',
      removalNoteStatus: 'added',
      privateMessageStatus: 'sent',
    });
  });

  test('uses default private message wording for ratio removal reasons', async () => {
    const redditClient = mockRedditClient();
    const post = mockPost();

    await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      reason: 'Removed for downvote ratio threshold',
      authorName: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(post.removalNotes).toEqual([
      { reasonId: '', modNote: 'Removed for downvote ratio threshold' },
    ]);
    expect(redditClient.privateMessages[0]).toMatchObject({
      text: expect.stringContaining(
        'Your post was removed because it received too much negative community feedback.'
      ),
    });
    expect(redditClient.privateMessages[0]).not.toEqual(
      expect.objectContaining({
        text: expect.stringContaining('reported upvote ratio'),
      })
    );
    expect(redditClient.privateMessages[0]).not.toEqual(
      expect.objectContaining({
        text: expect.stringContaining('estimated minimum vote spread'),
      })
    );
  });

  test('does not send a direct message for report or filter actions', async () => {
    const reportClient = mockRedditClient();
    const filterClient = mockRedditClient();
    const reportPost = mockPost();

    const reportResult = await applyModerationAction({
      redditClient: reportClient,
      post: reportPost,
      action: ACTION_REPORT,
      threshold: -3,
      authorName: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    const filteredPost = mockPost();
    const filterResult = await applyModerationAction({
      redditClient: filterClient,
      post: filteredPost,
      action: ACTION_FILTER,
      threshold: -3,
      authorName: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(reportClient.privateMessages).toEqual([]);
    expect(filterClient.privateMessages).toEqual([]);
    expect(reportPost.lockCalls).toBe(0);
    expect(filteredPost.lockCalls).toBe(0);
    expect(reportClient.modmailConversations).toEqual([]);
    expect(filterClient.modmailConversations).toEqual([]);
    expect(filteredPost.filterCalls).toEqual([
      'Filtered for -3 Downvote Karma|false',
    ]);
    expect(reportResult).toEqual({
      actionStatus: 'succeeded',
      postLockStatus: 'not_applicable',
      removalNoteStatus: 'not_applicable',
      privateMessageStatus: 'not_applicable',
    });
    expect(filterResult).toEqual({
      actionStatus: 'succeeded',
      postLockStatus: 'not_applicable',
      removalNoteStatus: 'not_applicable',
      privateMessageStatus: 'not_applicable',
    });
  });

  test('treats structured report errors as a definite action failure', async () => {
    const redditClient = mockRedditClient({
      reportErrors: ['RATELIMIT: try again later'],
    });

    const result = await applyModerationAction({
      redditClient,
      post: mockPost(),
      action: ACTION_REPORT,
      threshold: -3,
    });

    expect(redditClient.reports).toHaveLength(1);
    expect(result).toEqual({
      actionStatus: 'failed',
      actionErrorMessage: 'RATELIMIT: try again later',
      postLockStatus: 'not_applicable',
      removalNoteStatus: 'not_applicable',
      privateMessageStatus: 'not_applicable',
    });
  });

  test('missing username skips direct message without failing removal', async () => {
    const redditClient = mockRedditClient();
    const post = mockPost();

    const result = await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(post.removeCalls).toEqual([false]);
    expect(redditClient.privateMessages).toEqual([]);
    expect(result).toEqual({
      actionStatus: 'succeeded',
      postLockStatus: 'locked',
      removalNoteStatus: 'added',
      privateMessageStatus: 'skipped',
      privateMessageSkippedReason: 'missing_author_name',
    });
  });

  test('missing subreddit skips direct message without failing removal', async () => {
    const redditClient = mockRedditClient();
    const post = mockPost();

    const result = await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      authorName: 'someUser',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(post.removeCalls).toEqual([false]);
    expect(redditClient.privateMessages).toEqual([]);
    expect(result).toEqual({
      actionStatus: 'succeeded',
      postLockStatus: 'locked',
      removalNoteStatus: 'added',
      privateMessageStatus: 'skipped',
      privateMessageSkippedReason: 'missing_subreddit_name',
    });
  });

  test('missing post link skips direct message without failing removal', async () => {
    const redditClient = mockRedditClient();
    const post = mockPost();

    const result = await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      authorName: 'someUser',
      subredditName: 'mySubreddit',
    });

    expect(post.removeCalls).toEqual([false]);
    expect(redditClient.privateMessages).toEqual([]);
    expect(result).toEqual({
      actionStatus: 'succeeded',
      postLockStatus: 'locked',
      removalNoteStatus: 'added',
      privateMessageStatus: 'skipped',
      privateMessageSkippedReason: 'missing_post_link',
    });
  });

  test('direct message failure does not fail the remove action', async () => {
    const redditClient = mockRedditClient({ failPrivateMessage: true });
    const post = mockPost();

    const result = await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      authorName: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(post.removeCalls).toEqual([false]);
    expect(post.removalNotes).toEqual([
      { reasonId: '', modNote: 'Removed for -3 Downvote Karma' },
    ]);
    expect(redditClient.privateMessages).toHaveLength(1);
    expect(redditClient.modmailConversations).toEqual([]);
    expect(result.privateMessageStatus).toBe('failed');
    expect(result.privateMessageErrorMessage).toBe(
      'private message unavailable'
    );
    expect(result.privateMessageError).toBeInstanceOf(Error);
    expect(result.actionStatus).toBe('succeeded');
  });

  test('removal-note failure does not fail or repeat the remove action', async () => {
    const redditClient = mockRedditClient();
    const post = mockPost({ failRemovalNote: true });

    const result = await applyModerationAction({
      redditClient,
      post,
      action: ACTION_REMOVE,
      threshold: -3,
      authorName: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(post.removeCalls).toEqual([false]);
    expect(post.removalNotes).toHaveLength(1);
    expect(result.actionStatus).toBe('succeeded');
    expect(result.removalNoteStatus).toBe('failed');
    expect(result.removalNoteErrorMessage).toBe('removal note unavailable');
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

  test('summarizes Firebase configuration without URL or secret values', () => {
    const summary = summarizeSubredditSettingsShapes({
      PRAW_ROUTER_URL:
        'https://api-id.execute-api.us-east-1.amazonaws.com/prod/v1/post-ratio',
      PRAW_ROUTER_HMAC_SECRET: 'do-not-log-this-secret',
    });

    expect(summary).not.toHaveProperty('PRAW_ROUTER_URL');
    expect(summary.PRAW_ROUTER_HMAC_SECRET).toBe('string');
    expect(JSON.stringify(summary)).not.toContain('do-not-log-this-secret');
  });
});
