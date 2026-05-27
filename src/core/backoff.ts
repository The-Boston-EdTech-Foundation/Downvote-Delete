export type TrackingCadence = 'normal' | 'advanced';

const backoffMinutesByCheckCount = [2, 3, 5, 10] as const;

export function getNextCheckDelayMinutes(
  checkCount: number,
  cadence: TrackingCadence = 'normal'
): number {
  if (cadence === 'advanced') {
    return 5;
  }

  if (checkCount < 0) {
    return backoffMinutesByCheckCount[0];
  }

  return backoffMinutesByCheckCount[checkCount] ?? 20;
}

export function getNextCheckRunAt(
  checkCount: number,
  now = Date.now(),
  cadence: TrackingCadence = 'normal'
): Date {
  return new Date(
    now + getNextCheckDelayMinutes(checkCount, cadence) * 60 * 1000
  );
}
