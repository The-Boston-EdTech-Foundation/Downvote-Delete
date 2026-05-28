import { describe, expect, test } from 'vitest';
import {
  applyModerationAction,
  buildRemovedForDownvotesModmailBody,
  REMOVAL_MODMAIL_SUBJECT,
} from '../src/core/actions';
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
  fetchAuthenticatedRedditVoteSnapshot,
  readRedditOAuthConfigFromSettings,
  resetRedditOAuthTokenCacheForTests,
  type RedditOAuthConfig,
  type RedditOAuthFetch,
} from '../src/core/redditOAuthRatio';
import {
  advancedTrackingMaxRatio,
  buildRatioLookup,
  evaluateRatioState,
  severeDownvoteRatioThreshold,
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
  type DownvoteDeleteSettings,
} from '../src/core/settings';
import {
  refreshTrackedPostActionSettings,
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

function mockPost(overrides: Partial<{
  filterCalls: string[];
  removalNotes: unknown[];
  removeCalls: boolean[];
}> = {}): ApplyModerationActionArgs['post'] & {
  filterCalls: string[];
  removalNotes: unknown[];
  removeCalls: boolean[];
} {
  const filterCalls = overrides.filterCalls ?? [];
  const removalNotes = overrides.removalNotes ?? [];
  const removeCalls = overrides.removeCalls ?? [];
  const post = {
    filterCalls,
    removalNotes,
    removeCalls,
    async filter(reason: string, keep: boolean): Promise<void> {
      filterCalls.push(`${reason}|${keep}`);
    },
    async remove(isSpam: boolean): Promise<void> {
      removeCalls.push(isSpam);
    },
    async addRemovalNote(note: unknown): Promise<void> {
      removalNotes.push(note);
    },
  };

  return post as unknown as ApplyModerationActionArgs['post'] & {
    filterCalls: string[];
    removalNotes: unknown[];
    removeCalls: boolean[];
  };
}

function mockRedditClient(args: {
  failModmail?: boolean;
} = {}): ApplyModerationActionArgs['redditClient'] & {
  reports: unknown[];
  modmailConversations: unknown[];
} {
  const reports: unknown[] = [];
  const modmailConversations: unknown[] = [];
  const client = {
    reports,
    modmailConversations,
    async report(post: unknown, reportArgs: unknown): Promise<void> {
      reports.push({ post, reportArgs });
    },
    modMail: {
      createConversation: async (conversation: unknown): Promise<void> => {
        modmailConversations.push(conversation);

        if (args.failModmail) {
          throw new Error('modmail unavailable');
        }
      },
    },
  };

  return client as unknown as ApplyModerationActionArgs['redditClient'] & {
    reports: unknown[];
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

describe('authenticated Reddit ratio fetch', () => {
  const config: RedditOAuthConfig = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    userAgent: 'Downvote-Delete/1.4.1 by Alan-Foster',
  };

  function listing(args: {
    name?: string;
    upvoteRatio?: number;
    score?: number;
    hideScore?: boolean;
  } = {}): string {
    return JSON.stringify({
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't3',
            data: {
              name: args.name ?? 't3_post',
              id: (args.name ?? 't3_post').replace(/^t3_/, ''),
              score: args.score ?? 0,
              upvote_ratio: args.upvoteRatio,
              ups: 1,
              downs: 2,
              hide_score: args.hideScore ?? false,
            },
          },
        ],
      },
    });
  }

  function mockOAuthFetch(args: {
    tokenOk?: boolean;
    listingOk?: boolean;
    listingStatus?: number;
    listingBody?: string;
  } = {}): {
    calls: string[];
    fetchImpl: RedditOAuthFetch;
  } {
    const calls: string[] = [];
    return {
      calls,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('/api/v1/access_token')) {
          return {
            ok: args.tokenOk ?? true,
            status: args.tokenOk === false ? 401 : 200,
            statusText: args.tokenOk === false ? 'Unauthorized' : 'OK',
            async text(): Promise<string> {
              return args.tokenOk === false
                ? '{"error":"invalid_grant"}'
                : '{"access_token":"access-token","expires_in":3600}';
            },
          };
        }

        return {
          ok: args.listingOk ?? true,
          status: args.listingStatus ?? 200,
          statusText: args.listingOk === false ? 'Too Many Requests' : 'OK',
          async text(): Promise<string> {
            return args.listingBody ?? listing({ upvoteRatio: 0.33 });
          },
        };
      },
    };
  }

  test('reads configured Reddit OAuth settings', () => {
    expect(
      readRedditOAuthConfigFromSettings({
        REDDIT_CLIENT_ID: 'configured-client',
        REDDIT_CLIENT_SECRET: 'configured-secret',
        REDDIT_REFRESH_TOKEN: 'configured-refresh',
        REDDIT_USER_AGENT: 'configured-agent',
      })
    ).toEqual({
      clientId: 'configured-client',
      clientSecret: 'configured-secret',
      refreshToken: 'configured-refresh',
      userAgent: 'configured-agent',
    });
  });

  test('returns null when required Reddit OAuth secrets are missing', () => {
    expect(readRedditOAuthConfigFromSettings({})).toBeNull();
    expect(
      readRedditOAuthConfigFromSettings({
        REDDIT_CLIENT_ID: 'configured-client',
        REDDIT_CLIENT_SECRET: 'configured-secret',
      })
    ).toBeNull();
  });

  test('uses default user agent when setting is missing', () => {
    expect(
      readRedditOAuthConfigFromSettings({
        REDDIT_CLIENT_ID: 'configured-client',
        REDDIT_CLIENT_SECRET: 'configured-secret',
        REDDIT_REFRESH_TOKEN: 'configured-refresh',
      })
    ).toEqual({
      clientId: 'configured-client',
      clientSecret: 'configured-secret',
      refreshToken: 'configured-refresh',
      userAgent: 'Downvote-Delete/1.4.1 by Alan-Foster',
    });
  });

  test('returns structured failure when credentials are missing', async () => {
    resetRedditOAuthTokenCacheForTests();
    const result = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config: readRedditOAuthConfigFromSettings({}),
      fetchImpl: mockOAuthFetch().fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      source: 'authenticated_reddit_api',
      upvoteRatio: null,
      error: 'Missing required Reddit OAuth credentials.',
    });
  });

  test('fetches and reuses an access token for matching post snapshots', async () => {
    resetRedditOAuthTokenCacheForTests();
    const oauth = mockOAuthFetch({
      listingBody: listing({ upvoteRatio: 0.25, hideScore: true }),
    });

    const first = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config,
      fetchImpl: oauth.fetchImpl,
      now,
    });
    const second = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config,
      fetchImpl: oauth.fetchImpl,
      now: now + 1_000,
    });

    expect(first).toMatchObject({
      ok: true,
      postId: 't3_post',
      source: 'authenticated_reddit_api',
      endpoint: 'oauth_by_id',
      upvoteRatio: 0.25,
      ratioPercent: '25.0%',
      hideScore: true,
      rawName: 't3_post',
      rawId: 'post',
      ups: 1,
      downs: 2,
      score: 0,
    });
    expect(second.ok).toBe(true);
    expect(
      oauth.calls.filter((url) => url.includes('/api/v1/access_token'))
    ).toHaveLength(1);
    expect(oauth.calls).toContain(
      'https://oauth.reddit.com/api/v1/access_token'
    );
    expect(oauth.calls.filter((url) => url.includes('/by_id/t3_post'))).toEqual(
      ['https://oauth.reddit.com/by_id/t3_post', 'https://oauth.reddit.com/by_id/t3_post']
    );
    expect(new Set(oauth.calls.map((url) => new URL(url).hostname))).toEqual(
      new Set(['oauth.reddit.com'])
    );
  });

  test('returns auth failure without exposing request credentials', async () => {
    resetRedditOAuthTokenCacheForTests();
    const result = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockOAuthFetch({ tokenOk: false }).fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      upvoteRatio: null,
      error: expect.stringContaining('Reddit token HTTP 401'),
    });
    expect(result.error).not.toContain(config.clientSecret);
    expect(result.error).not.toContain(config.refreshToken);
  });

  test('treats matching post with missing ratio as non-actionable success', async () => {
    resetRedditOAuthTokenCacheForTests();
    const result = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockOAuthFetch({ listingBody: listing() }).fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      upvoteRatio: null,
      ratioPercent: null,
      rawName: 't3_post',
    });
  });

  test('discards wrong post responses', async () => {
    resetRedditOAuthTokenCacheForTests();
    const result = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockOAuthFetch({
        listingBody: listing({ name: 't3_other', upvoteRatio: 0.1 }),
      }).fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      upvoteRatio: null,
      rawName: 't3_other',
      rawId: 'other',
      error: 'Wrong post returned from Reddit OAuth by_id response.',
    });
  });

  test('returns HTTP 429 as a structured score-only fallback', async () => {
    resetRedditOAuthTokenCacheForTests();
    const result = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockOAuthFetch({
        listingOk: false,
        listingStatus: 429,
        listingBody: '{"message":"rate limited"}',
      }).fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      upvoteRatio: null,
      error: expect.stringContaining('Reddit OAuth HTTP 429'),
    });
  });

  test('returns malformed OAuth JSON as a structured failure', async () => {
    resetRedditOAuthTokenCacheForTests();
    const result = await fetchAuthenticatedRedditVoteSnapshot('t3_post', {
      config,
      fetchImpl: mockOAuthFetch({ listingBody: '{"broken"' }).fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      upvoteRatio: null,
    });
    expect(result.error).toEqual(expect.any(String));
  });
});

describe('vote ratio confidence model', () => {
  const lookup = buildRatioLookup(30);

  test('exports named ratio thresholds', () => {
    expect(severeDownvoteRatioThreshold).toBe(0.24);
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

  test('ratio <= 0.24 always removes', () => {
    expect(
      shouldRemoveByRatio({
        ratio: 0.24,
        moderatorThreshold: -30,
        minimumTotalVotes: 0,
        lookup,
      })
    ).toMatchObject({
      remove: true,
      reason: 'severe_downvote_ratio',
    });
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
    expect(Math.min(...evaluation.possibleStates.map((state) => state.spread))).toBe(
      -10
    );
  });
});

describe('tracked post decisions', () => {
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

describe('removal modmail notifications', () => {
  test('builds the requested removal modmail body', () => {
    const body = buildRemovedForDownvotesModmailBody({
      username: 'someUser',
      subredditName: 'mySubreddit',
      postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
    });

    expect(body).toContain('Hi u/someUser,');
    expect(body).toContain(
      'Your post was removed because it received too much negative community feedback.'
    );
    expect(body).toContain(
      'https://reddit.com/r/mySubreddit/about/rules'
    );
    expect(body).toContain(
      '*Removed post: https://reddit.com/r/mySubreddit/comments/abc123*'
    );
    expect(body).toBe(`Hi u/someUser,

Your post was removed because it received too much negative community feedback.

Posts may be downvoted for many reasons, including rule issues, content quality, or controversial opinions. This removal helps prevent your account from accumulating additional negative karma from the post.

Please review the [community rules](https://reddit.com/r/mySubreddit/about/rules) before posting again.


*Removed post: https://reddit.com/r/mySubreddit/comments/abc123*`);
  });

  test('sends modmail after a successful remove action', async () => {
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
    expect(post.removalNotes).toEqual([
      { reasonId: '', modNote: 'Removed for -3 Downvote Karma' },
    ]);
    expect(redditClient.modmailConversations).toEqual([
      {
        subredditName: 'mySubreddit',
        subject: REMOVAL_MODMAIL_SUBJECT,
        body: buildRemovedForDownvotesModmailBody({
          username: 'someUser',
          subredditName: 'mySubreddit',
          postLink: 'https://reddit.com/r/mySubreddit/comments/abc123',
        }),
        to: 'u/someUser',
        isAuthorHidden: true,
      },
    ]);
    expect(result.modmailSentAt).toEqual(expect.any(Number));
    expect(result.modmailStatus).toBe('sent');
    expect(result.modmailErrorMessage).toBeUndefined();
  });

  test('uses default modmail wording for ratio removal reasons', async () => {
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
    expect(redditClient.modmailConversations[0]).toMatchObject({
      body: expect.stringContaining(
        'Your post was removed because it received too much negative community feedback.'
      ),
    });
    expect(redditClient.modmailConversations[0]).not.toEqual(
      expect.objectContaining({
        body: expect.stringContaining('reported upvote ratio'),
      })
    );
    expect(redditClient.modmailConversations[0]).not.toEqual(
      expect.objectContaining({
        body: expect.stringContaining('estimated minimum vote spread'),
      })
    );
  });

  test('does not send modmail for report or filter actions', async () => {
    const reportClient = mockRedditClient();
    const filterClient = mockRedditClient();

    const reportResult = await applyModerationAction({
      redditClient: reportClient,
      post: mockPost(),
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

    expect(reportClient.modmailConversations).toEqual([]);
    expect(filterClient.modmailConversations).toEqual([]);
    expect(filteredPost.filterCalls).toEqual([
      'Filtered for -3 Downvote Karma|false',
    ]);
    expect(reportResult).toEqual({ modmailStatus: 'not_applicable' });
    expect(filterResult).toEqual({ modmailStatus: 'not_applicable' });
  });

  test('missing username skips modmail without failing removal', async () => {
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
    expect(redditClient.modmailConversations).toEqual([]);
    expect(result).toEqual({
      modmailStatus: 'skipped',
      modmailSkippedReason: 'missing_author_name',
    });
  });

  test('missing subreddit skips modmail without failing removal', async () => {
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
    expect(redditClient.modmailConversations).toEqual([]);
    expect(result).toEqual({
      modmailStatus: 'skipped',
      modmailSkippedReason: 'missing_subreddit_name',
    });
  });

  test('missing post link skips modmail without failing removal', async () => {
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
    expect(redditClient.modmailConversations).toEqual([]);
    expect(result).toEqual({
      modmailStatus: 'skipped',
      modmailSkippedReason: 'missing_post_link',
    });
  });

  test('modmail failure does not fail the remove action', async () => {
    const redditClient = mockRedditClient({ failModmail: true });
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
    expect(redditClient.modmailConversations).toHaveLength(1);
    expect(result.modmailStatus).toBe('failed');
    expect(result.modmailErrorMessage).toBe('modmail unavailable');
    expect(result.modmailError).toBeInstanceOf(Error);
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
