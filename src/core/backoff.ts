const backoffMinutesByCheckCount = [2, 3, 5] as const;

export function getNextCheckDelayMinutes(checkCount: number): number {
  if (checkCount < 0) {
    return backoffMinutesByCheckCount[0];
  }

  return backoffMinutesByCheckCount[checkCount] ?? 10;
}

export function getNextCheckRunAt(checkCount: number, now = Date.now()): Date {
  return new Date(now + getNextCheckDelayMinutes(checkCount) * 60 * 1000);
}
