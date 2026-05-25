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
  estimateScoreFromUpvoteRatio,
  getNegativeDecisionScore,
  shouldTrackNewPost,
  type PostSnapshot,
} from '../src/core/decision';
import { formatLogContext } from '../src/core/logging';
import { enrichSnapshotWithStoredVotes } from '../src/routes/scheduler';
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
  applyActiveTrackingVoteSignalUpdate,
  isFreshTimestamp,
  shouldUseStoredExactVoteCounts,
  shouldUseStoredRatioSignals,
  STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS,
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
    'falls back to -3 for invalid negative score threshold %s',
    (negativeScoreThreshold) => {
      expect(
        normalizeSettings({ negativeScoreThreshold }).negativeScoreThreshold
      ).toBe(-3);
    }
  );
});

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

  test('estimates a negative score from low upvote ratio and known upvotes', () => {
    expect(
      estimateScoreFromUpvoteRatio({ upvotes: 1, upvoteRatio: 0.25 })
    ).toBe(-2);
    expect(
      estimateScoreFromUpvoteRatio({ upvotes: 2, upvoteRatio: 0.25 })
    ).toBe(-4);
    expect(
      estimateScoreFromUpvoteRatio({ upvotes: 8, upvoteRatio: 0.42 })
    ).toBe(-3);
    expect(
      estimateScoreFromUpvoteRatio({ upvotes: 4, upvoteRatio: 0.34 })
    ).toBe(-4);
    expect(
      estimateScoreFromUpvoteRatio({ upvotes: 1, upvoteRatio: 0.34 })
    ).toBe(-1);
  });

  test('does not estimate a ratio score without a useful negative ratio signal', () => {
    expect(estimateScoreFromUpvoteRatio({ upvotes: 1 })).toBeUndefined();
    expect(
      estimateScoreFromUpvoteRatio({ upvotes: 1, upvoteRatio: 0.5 })
    ).toBeUndefined();
    expect(
      estimateScoreFromUpvoteRatio({ upvoteRatio: 0.25 })
    ).toBeUndefined();
    expect(
      estimateScoreFromUpvoteRatio({ upvotes: 0, upvoteRatio: 0.25 })
    ).toBeUndefined();
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

  test('uses the ratio estimate for negative threshold decisions when it is lowest', () => {
    const post = postSnapshot({ score: 0, upvotes: 2, upvoteRatio: 0.25 });

    expect(getNegativeDecisionScore(post)).toEqual({
      score: -4,
      source: 'upvote_ratio_estimate',
      ratioEstimatedScore: -4,
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

  test('uses single-upvote ratio cutoff when upvotes are missing', () => {
    expect(
      getNegativeDecisionScore(
        postSnapshot({ score: 0, upvoteRatio: 0.2 }),
        { negativeScoreThreshold: -3 }
      )
    ).toEqual({
      score: -3,
      source: 'single_upvote_ratio_cutoff',
      ratioEstimatedScore: -3,
    });
  });

  test('uses zero-upvote ratio cutoff when upvotes are explicitly zero', () => {
    expect(
      getNegativeDecisionScore(
        postSnapshot({ score: 0, upvotes: 0, upvoteRatio: 0.25 }),
        { negativeScoreThreshold: -3 }
      )
    ).toEqual({
      score: -1,
      source: 'zero_upvote_ratio_cutoff',
      ratioEstimatedScore: -1,
    });
  });

  test('does not action from zero-upvote ratio cutoff below threshold -1', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -2 }),
        settings: activeSettings,
        post: postSnapshot({ score: 0, upvotes: 0, upvoteRatio: 0.25 }),
        now,
      })
    ).toEqual({ type: 'reschedule' });
  });

  test('uses exact downvotes when upvotes are explicitly zero', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post: postSnapshot({
          score: 0,
          upvotes: 0,
          downvotes: 3,
          upvoteRatio: 0,
        }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('does not use single-upvote ratio cutoff above the configured threshold ratio', () => {
    expect(
      getNegativeDecisionScore(
        postSnapshot({ score: 0, upvoteRatio: 0.21 }),
        { negativeScoreThreshold: -3 }
      )
    ).toEqual({
      score: 0,
      source: 'reddit_score',
    });
  });

  test.each([
    [-1, 0.333],
    [-2, 0.25],
    [-5, 0.142],
  ] as const)(
    'uses single-upvote ratio cutoff for threshold %s',
    (negativeScoreThreshold, upvoteRatio) => {
      expect(
        getNegativeDecisionScore(
          postSnapshot({ score: 0, upvoteRatio }),
          { negativeScoreThreshold }
        )
      ).toEqual({
        score: negativeScoreThreshold,
        source: 'single_upvote_ratio_cutoff',
        ratioEstimatedScore: negativeScoreThreshold,
      });
    }
  );

  test('actions from the single-upvote ratio cutoff at the negative threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post: postSnapshot({ score: 0, upvoteRatio: 0.2 }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('actions from the zero-upvote ratio cutoff at the negative threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -1 }),
        settings: activeSettings,
        post: postSnapshot({ score: 0, upvotes: 0, upvoteRatio: 0.25 }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('uses exact vote counts when they are lower than the ratio estimate', () => {
    expect(
      getNegativeDecisionScore(
        postSnapshot({
          score: 0,
          upvotes: 8,
          downvotes: 11,
          upvoteRatio: 0.49,
        }),
        { negativeScoreThreshold: -3 }
      )
    ).toEqual({
      score: -3,
      source: 'calculated_votes',
      calculatedVoteScore: -3,
      ratioEstimatedScore: 0,
    });
  });

  test('ignores cached calculated vote scores without raw vote counts', () => {
    expect(
      getNegativeDecisionScore(
        postSnapshot({ score: 0, calculatedVoteScore: -3 }),
        { negativeScoreThreshold: -3 }
      )
    ).toEqual({
      score: 0,
      source: 'reddit_score',
    });
  });

  test('actions when an explicit ratio estimate reaches the negative threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post: postSnapshot({
          score: 0,
          ratioEstimatedScore: -3,
        }),
        now,
      })
    ).toEqual({ type: 'action' });
  });

  test('does not action from ratio estimate when it stays above the threshold', () => {
    expect(
      decideTrackedPostCheck({
        tracking: trackedPost({ negativeScoreThreshold: -3 }),
        settings: activeSettings,
        post: postSnapshot({
          score: 0,
          ratioEstimatedScore: -2,
        }),
        now,
      })
    ).toEqual({ type: 'reschedule' });
  });

  test('uses the lowest available negative signal', () => {
    expect(
      getNegativeDecisionScore(
        postSnapshot({
          score: 0,
          upvotes: 2,
          downvotes: 4,
          upvoteRatio: 0.25,
        })
      )
    ).toEqual({
      score: -4,
      source: 'upvote_ratio_estimate',
      calculatedVoteScore: -2,
      ratioEstimatedScore: -4,
    });
  });

  test('positive stop still uses normal Reddit score instead of calculated votes or ratio estimates', () => {
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
          upvoteRatio: 0.25,
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
  test('validates vote signal timestamps against age and future values', () => {
    expect(
      isFreshTimestamp({
        timestamp: now - 1_000,
        maxAgeMs: STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS,
        now,
      })
    ).toBe(true);
    expect(
      isFreshTimestamp({
        timestamp: now + 1_000,
        maxAgeMs: STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS,
        now,
      })
    ).toBe(false);
    expect(
      isFreshTimestamp({
        timestamp: now - STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS - 1,
        maxAgeMs: STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS,
        now,
      })
    ).toBe(false);
  });

  test('uses recent stored exact vote counts when no current post data exists', () => {
    expect(
      shouldUseStoredExactVoteCounts({
        record: trackedPost({
          lastKnownUpvotes: 1,
          lastKnownDownvotes: 4,
          lastExactVoteCountsAt:
            now - STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS + 1_000,
        }),
        hasCurrentPostDataSignals: false,
        now,
      })
    ).toBe(true);
  });

  test('does not use stale stored exact vote counts', () => {
    expect(
      shouldUseStoredExactVoteCounts({
        record: trackedPost({
          lastKnownUpvotes: 1,
          lastKnownDownvotes: 4,
          lastExactVoteCountsAt:
            now - STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS - 1_000,
        }),
        hasCurrentPostDataSignals: false,
        now,
      })
    ).toBe(false);
  });

  test('does not use future stored exact vote counts', () => {
    expect(
      shouldUseStoredExactVoteCounts({
        record: trackedPost({
          lastKnownUpvotes: 1,
          lastKnownDownvotes: 4,
          lastExactVoteCountsAt: now + 1_000,
        }),
        hasCurrentPostDataSignals: false,
        now,
      })
    ).toBe(false);
  });

  test('does not use stored exact vote counts when current post data exists', () => {
    expect(
      shouldUseStoredExactVoteCounts({
        record: trackedPost({
          lastKnownUpvotes: 1,
          lastKnownDownvotes: 4,
          lastExactVoteCountsAt: now,
        }),
        hasCurrentPostDataSignals: true,
        now,
      })
    ).toBe(false);
  });

  test('uses stored ratio signals only when the stored pair is fresh', () => {
    expect(
      shouldUseStoredRatioSignals({
        record: trackedPost({
          lastKnownPostDataUps: 1,
          lastKnownUpvoteRatio: 0.25,
          lastRatioSignalsAt: now - 1_000,
        }),
        hasCurrentPostDataSignals: false,
        now,
      })
    ).toBe(true);
    expect(
      shouldUseStoredRatioSignals({
        record: trackedPost({
          lastKnownPostDataUps: 1,
          lastKnownUpvoteRatio: 0.25,
          lastRatioSignalsAt:
            now - STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS - 1_000,
        }),
        hasCurrentPostDataSignals: false,
        now,
      })
    ).toBe(false);
    expect(
      shouldUseStoredRatioSignals({
        record: trackedPost({
          lastKnownPostDataUps: 1,
          lastKnownUpvoteRatio: 0.25,
          lastRatioSignalsAt: now,
        }),
        hasCurrentPostDataSignals: true,
        now,
      })
    ).toBe(false);
  });

  test('does not mix current ratio signals with stored ratio signals', () => {
    const record = trackedPost({
      lastKnownPostDataUps: 8,
      lastKnownUpvoteRatio: 0.25,
      lastRatioSignalsAt: now,
    });

    expect(
      enrichSnapshotWithStoredVotes(
        postSnapshot({ score: 0 }),
        record,
        { upvoteRatio: 0.2 },
        now
      )
    ).toEqual(postSnapshot({ score: 0 }));

    expect(
      enrichSnapshotWithStoredVotes(
        postSnapshot({ score: 0 }),
        record,
        { ups: 1 },
        now
      )
    ).toEqual(postSnapshot({ score: 0 }));
  });

  test('uses current ratio pairs and fresh stored ratio pairs', () => {
    const record = trackedPost({
      lastKnownPostDataUps: 8,
      lastKnownUpvoteRatio: 0.25,
      lastRatioSignalsAt: now,
    });

    expect(
      enrichSnapshotWithStoredVotes(
        postSnapshot({ score: 0 }),
        record,
        { ups: 1, upvoteRatio: 0.2 },
        now
      )
    ).toEqual(postSnapshot({ score: 0, postDataUps: 1, upvoteRatio: 0.2 }));

    expect(
      enrichSnapshotWithStoredVotes(postSnapshot({ score: 0 }), record, {}, now)
    ).toEqual(postSnapshot({ score: 0, postDataUps: 8, upvoteRatio: 0.25 }));
  });

  test('ignores stale stored ratio pairs', () => {
    expect(
      enrichSnapshotWithStoredVotes(
        postSnapshot({ score: 0 }),
        trackedPost({
          lastKnownPostDataUps: 8,
          lastKnownUpvoteRatio: 0.25,
          lastRatioSignalsAt:
            now - STORED_EXACT_VOTE_COUNTS_MAX_AGE_MS - 1_000,
        }),
        {},
        now
      )
    ).toEqual(postSnapshot({ score: 0 }));
  });

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
          upvoteRatio: 0.25,
          postDataUps: 1,
          calculatedVoteScore: -3,
        },
        now + 1_000
      )
    ).toMatchObject({
      status: 'active',
      lastKnownScore: -1,
      lastKnownScoreAt: now + 1_000,
      lastKnownUpvotes: 1,
      lastKnownDownvotes: 4,
      lastExactVoteCountsAt: now + 1_000,
      lastKnownUpvoteRatio: 0.25,
      lastKnownPostDataUps: 1,
      lastRatioSignalsAt: now + 1_000,
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
      'https://www.reddit.com/r/mySubreddit/about/rules'
    );
    expect(body).toContain(
      '*Removed post: https://reddit.com/r/mySubreddit/comments/abc123*'
    );
    expect(body).toBe(`Hi u/someUser,

Your post was removed because it received too much negative community feedback.

Posts may be downvoted for many reasons, including rule issues, content quality, or controversial opinions. This removal helps prevent your account from accumulating additional negative karma from the post.

Please review the [community rules](https://www.reddit.com/r/mySubreddit/about/rules) before posting again.


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
