const LOG_PREFIX = '[Downvote Delete]';

export type LogContext = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  if (value instanceof Error) {
    return value.message;
  }

  return JSON.stringify(value);
}

export function formatLogContext(context: LogContext = {}): string {
  const parts = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function logInfo(message: string, context?: LogContext): void {
  console.info(`${LOG_PREFIX} ${message}${formatLogContext(context)}`);
}

export function logWarn(message: string, context?: LogContext): void {
  console.warn(`${LOG_PREFIX} ${message}${formatLogContext(context)}`);
}

export function logError(
  message: string,
  context?: LogContext,
  err?: unknown
): void {
  const formattedMessage = `${LOG_PREFIX} ${message}${formatLogContext(context)}`;

  if (err === undefined) {
    console.error(formattedMessage);
    return;
  }

  console.error(formattedMessage, err);
}
