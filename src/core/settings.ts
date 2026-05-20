import type { SettingsValues } from '@devvit/web/server';

export const ACTION_REPORT = 'report';
export const ACTION_FILTER = 'filter';
export const ACTION_REMOVE = 'remove';

export const MODERATOR_IGNORE = 'ignore';
export const MODERATOR_ACTION_ALL = 'action_all';

export type DownvoteDeleteAction =
  | typeof ACTION_REPORT
  | typeof ACTION_FILTER
  | typeof ACTION_REMOVE;

export type ModeratorPostHandling =
  | typeof MODERATOR_IGNORE
  | typeof MODERATOR_ACTION_ALL;

export type DownvoteDeleteSettings = {
  isActive: boolean;
  trackingDurationHours: 1 | 2 | 3;
  negativeScoreThreshold: -3 | -5 | -10;
  positiveScoreStopThreshold: 3 | 5 | 10;
  actionToTake: DownvoteDeleteAction;
  moderatorPostHandling: ModeratorPostHandling;
};

export const defaultSettings: DownvoteDeleteSettings = {
  isActive: true,
  trackingDurationHours: 2,
  negativeScoreThreshold: -3,
  positiveScoreStopThreshold: 5,
  actionToTake: ACTION_REMOVE,
  moderatorPostHandling: MODERATOR_IGNORE,
};

const validTrackingDurations = [1, 2, 3] as const;
const validNegativeThresholds = [-3, -5, -10] as const;
const validPositiveThresholds = [3, 5, 10] as const;
const validActions = [ACTION_REPORT, ACTION_FILTER, ACTION_REMOVE] as const;
const validModeratorHandling = [
  MODERATOR_IGNORE,
  MODERATOR_ACTION_ALL,
] as const;

function selectNumber<T extends number>(
  value: unknown,
  validValues: readonly T[],
  fallback: T
): T {
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  return validValues.includes(normalized as T) ? (normalized as T) : fallback;
}

function selectString<T extends string>(
  value: unknown,
  validValues: readonly T[],
  fallback: T
): T {
  return typeof value === 'string' && validValues.includes(value as T)
    ? (value as T)
    : fallback;
}

export function normalizeSettings(
  values: SettingsValues
): DownvoteDeleteSettings {
  return {
    isActive:
      typeof values.isActive === 'boolean'
        ? values.isActive
        : defaultSettings.isActive,
    trackingDurationHours: selectNumber(
      values.trackingDurationHours,
      validTrackingDurations,
      defaultSettings.trackingDurationHours
    ),
    negativeScoreThreshold: selectNumber(
      values.negativeScoreThreshold,
      validNegativeThresholds,
      defaultSettings.negativeScoreThreshold
    ),
    positiveScoreStopThreshold: selectNumber(
      values.positiveScoreStopThreshold,
      validPositiveThresholds,
      defaultSettings.positiveScoreStopThreshold
    ),
    actionToTake: selectString(
      values.actionToTake,
      validActions,
      defaultSettings.actionToTake
    ),
    moderatorPostHandling: selectString(
      values.moderatorPostHandling,
      validModeratorHandling,
      defaultSettings.moderatorPostHandling
    ),
  };
}
