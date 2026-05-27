export const confidenceModelMaxVotes = 30;

export type VoteState = {
  upvotes: number;
  downvotes: number;
  total: number;
  spread: number;
  ratio: number;
};

export type RatioEvaluation = {
  possibleStates: VoteState[];
  updatedMinimumTotalVotes: number;
  guaranteedSpread: number | null;
  canAction: boolean;
};

export type RatioDecisionReason =
  | 'severe_downvote_ratio'
  | 'ratio_above_tracking_range'
  | 'guaranteed_spread_threshold_met'
  | 'continue_tracking'
  | 'no_possible_states_after_filter';

export type RatioDecision = {
  remove: boolean;
  reason: RatioDecisionReason;
  updatedMinimumTotalVotes: number;
  guaranteedSpread: number | null;
  possibleStates: VoteState[];
};

export type TrackedPostVoteState = {
  postId: string;
  createdAt: number;
  lastCheckedAt: number;
  latestScore: number;
  latestUpvoteRatio: number | null;
  minimumTotalVotes: number;
  maximumTotalVotesCap: number;
  guaranteedSpread: number | null;
  possibleStates: VoteState[];
  enteredAdvancedTrackingAt?: number;
  consecutiveNegativeChecks: number;
  lastActionDecision: 'none' | 'watch' | 'remove';
};

export function roundRatioToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildRatioLookup(
  maxTotalVotes: number
): Map<number, VoteState[]> {
  const lookup = new Map<number, VoteState[]>();

  for (let total = 1; total <= maxTotalVotes; total += 1) {
    for (let upvotes = 0; upvotes <= total; upvotes += 1) {
      const downvotes = total - upvotes;
      const ratio = roundRatioToTwoDecimals(upvotes / total);
      const spread = upvotes - downvotes;
      const state: VoteState = {
        upvotes,
        downvotes,
        total,
        spread,
        ratio,
      };
      const existing = lookup.get(ratio) ?? [];
      existing.push(state);
      lookup.set(ratio, existing);
    }
  }

  for (const states of lookup.values()) {
    states.sort((a, b) => {
      if (a.total !== b.total) {
        return a.total - b.total;
      }

      return a.spread - b.spread;
    });
  }

  return lookup;
}

export const defaultRatioLookup = buildRatioLookup(confidenceModelMaxVotes);

export function getPossibleVoteStates(
  ratio: number,
  lookup: Map<number, VoteState[]> = defaultRatioLookup
): VoteState[] {
  return lookup.get(roundRatioToTwoDecimals(ratio)) ?? [];
}

export function evaluateRatioState(params: {
  ratio: number;
  moderatorThreshold: number;
  minimumTotalVotes: number;
  lookup?: Map<number, VoteState[]>;
}): RatioEvaluation {
  const lookup = params.lookup ?? defaultRatioLookup;
  const rawStates = getPossibleVoteStates(params.ratio, lookup);
  const possibleStates = rawStates.filter(
    (state) => state.total >= params.minimumTotalVotes
  );

  if (possibleStates.length === 0) {
    return {
      possibleStates: [],
      updatedMinimumTotalVotes: params.minimumTotalVotes,
      guaranteedSpread: null,
      canAction: false,
    };
  }

  const minCurrentTotal = Math.min(
    ...possibleStates.map((state) => state.total)
  );
  const updatedMinimumTotalVotes = Math.max(
    params.minimumTotalVotes,
    minCurrentTotal
  );
  const guaranteedSpread = Math.max(
    ...possibleStates.map((state) => state.spread)
  );

  return {
    possibleStates,
    updatedMinimumTotalVotes,
    guaranteedSpread,
    canAction: guaranteedSpread <= params.moderatorThreshold,
  };
}

export function shouldRemoveByRatio(params: {
  ratio: number;
  moderatorThreshold: number;
  minimumTotalVotes: number;
  lookup?: Map<number, VoteState[]>;
}): RatioDecision {
  const ratio = roundRatioToTwoDecimals(params.ratio);

  if (ratio <= 0.24) {
    return {
      remove: true,
      reason: 'severe_downvote_ratio',
      updatedMinimumTotalVotes: params.minimumTotalVotes,
      guaranteedSpread: null,
      possibleStates: [],
    };
  }

  if (ratio > 0.4) {
    return {
      remove: false,
      reason: 'ratio_above_tracking_range',
      updatedMinimumTotalVotes: params.minimumTotalVotes,
      guaranteedSpread: null,
      possibleStates: [],
    };
  }

  const evaluation = evaluateRatioState({
    ratio,
    moderatorThreshold: params.moderatorThreshold,
    minimumTotalVotes: params.minimumTotalVotes,
    lookup: params.lookup ?? defaultRatioLookup,
  });

  if (evaluation.possibleStates.length === 0) {
    return {
      remove: false,
      reason: 'no_possible_states_after_filter',
      updatedMinimumTotalVotes: evaluation.updatedMinimumTotalVotes,
      guaranteedSpread: evaluation.guaranteedSpread,
      possibleStates: [],
    };
  }

  return {
    remove: evaluation.canAction,
    reason: evaluation.canAction
      ? 'guaranteed_spread_threshold_met'
      : 'continue_tracking',
    updatedMinimumTotalVotes: evaluation.updatedMinimumTotalVotes,
    guaranteedSpread: evaluation.guaranteedSpread,
    possibleStates: evaluation.possibleStates,
  };
}

export function updateTrackedPostVoteState(params: {
  state: TrackedPostVoteState;
  ratio: number;
  latestScore: number;
  moderatorThreshold: number;
  checkedAt: number;
  lookup?: Map<number, VoteState[]>;
}): TrackedPostVoteState {
  const decision = shouldRemoveByRatio({
    ratio: params.ratio,
    moderatorThreshold: params.moderatorThreshold,
    minimumTotalVotes: params.state.minimumTotalVotes,
    lookup: params.lookup ?? defaultRatioLookup,
  });
  const normalizedRatio = roundRatioToTwoDecimals(params.ratio);
  const negativeCheck =
    normalizedRatio <= 0.4 && decision.reason !== 'ratio_above_tracking_range';

  return {
    ...params.state,
    lastCheckedAt: params.checkedAt,
    latestScore: params.latestScore,
    latestUpvoteRatio: normalizedRatio,
    minimumTotalVotes: decision.updatedMinimumTotalVotes,
    guaranteedSpread: decision.guaranteedSpread,
    possibleStates: decision.possibleStates,
    consecutiveNegativeChecks: negativeCheck
      ? params.state.consecutiveNegativeChecks + 1
      : 0,
    lastActionDecision: decision.remove
      ? 'remove'
      : negativeCheck
        ? 'watch'
        : 'none',
  };
}
