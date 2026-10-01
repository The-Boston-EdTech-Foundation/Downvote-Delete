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
  const snapshotConfirmsApplied =
    (record.attemptedAction === 'remove' &&
      Boolean(snapshot?.removed || snapshot?.spam)) ||
    (record.attemptedAction === 'filter' &&
      Boolean(snapshot?.filtered || snapshot?.removed));

  // Older in-flight removals persisted thrown API calls as failures. A fresh
  // Reddit snapshot is authoritative because the response may have been lost
  // after the removal was applied.
  const compatibleFailedRemoval =
    record.actionOutcome === 'failed' &&
    record.attemptedAction === 'remove' &&
    record.actionPhase === 'removal_attempted' &&
    snapshotConfirmsApplied;
  if (record.actionOutcome === 'failed' && !compatibleFailedRemoval) {
    return {
      status: 'action_failed',
      outcome: 'failed',
      confirmedApplied: false,
    };
  }

  const confirmedApplied =
    record.actionOutcome === 'succeeded' || snapshotConfirmsApplied;

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
