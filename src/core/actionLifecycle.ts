import type { PostSnapshot } from './decision';
import type { TrackedPost } from './tracking';

export type ActionRecoveryResolution = {
  status: 'actioned' | 'action_failed' | 'action_unknown';
  outcome: 'succeeded' | 'failed' | 'unknown';
  confirmedApplied: boolean;
};

export function resolveActionRecovery(
  record: TrackedPost,
  snapshot?: Partial<Pick<PostSnapshot, 'removed' | 'filtered' | 'spam'>>
): ActionRecoveryResolution {
  if (record.actionOutcome === 'failed') {
    return {
      status: 'action_failed',
      outcome: 'failed',
      confirmedApplied: false,
    };
  }

  const confirmedApplied =
    record.actionOutcome === 'succeeded' ||
    (record.attemptedAction === 'remove' &&
      Boolean(snapshot?.removed || snapshot?.spam)) ||
    (record.attemptedAction === 'filter' &&
      Boolean(snapshot?.filtered || snapshot?.removed));

  return confirmedApplied
    ? {
        status: 'actioned',
        outcome: 'succeeded',
        confirmedApplied: true,
      }
    : {
        status: 'action_unknown',
        outcome: 'unknown',
        confirmedApplied: false,
      };
}
