import { createHmac } from 'node:crypto';

export type PrawRouterConfig = {
  url: string;
  hmacSecret: string;
};

export type PrawRouterVoteSnapshot = {
  ok: boolean;
  postId: string;
  source: 'praw_router';
  endpoint: 'post_ratio';
  score: number | null;
  upvoteRatio: number | null;
  ratioPercent: string | null;
  hideScore: boolean | null;
  ups: number | null;
  downs: number | null;
  rawName: string | null;
  rawId: string | null;
  error?: string;
  httpStatus?: number;
};

export type PrawRouterFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

type PrawRouterSuccessResponse = {
  apiVersion: '1';
  ok: true;
  postId: string;
  upvoteRatio: number | null;
  score: number | null;
  rawName: string;
  rawId: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const ERROR_PREVIEW_LENGTH = 500;

function baseSnapshot(postId: string): Omit<PrawRouterVoteSnapshot, 'ok'> {
  return {
    postId,
    source: 'praw_router',
    endpoint: 'post_ratio',
    score: null,
    upvoteRatio: null,
    ratioPercent: null,
    hideScore: null,
    ups: null,
    downs: null,
    rawName: null,
    rawId: null,
  };
}

function failureSnapshot(args: {
  postId: string;
  error: string;
  httpStatus?: number;
}): PrawRouterVoteSnapshot {
  const snapshot: PrawRouterVoteSnapshot = {
    ...baseSnapshot(args.postId),
    ok: false,
    error: previewText(args.error),
  };

  if (typeof args.httpStatus === 'number') {
    snapshot.httpStatus = args.httpStatus;
  }

  return snapshot;
}

function previewText(value: string): string {
  return value
    .slice(0, ERROR_PREVIEW_LENGTH)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function isValidRouterUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function readSuccessResponse(raw: unknown): PrawRouterSuccessResponse | null {
  if (
    !isObject(raw) ||
    raw.apiVersion !== '1' ||
    raw.ok !== true ||
    typeof raw.postId !== 'string' ||
    typeof raw.rawName !== 'string' ||
    typeof raw.rawId !== 'string'
  ) {
    return null;
  }

  const upvoteRatio = readNullableNumber(raw.upvoteRatio);
  const score = readNullableNumber(raw.score);
  if (
    upvoteRatio === undefined ||
    score === undefined ||
    (upvoteRatio !== null && (upvoteRatio < 0 || upvoteRatio > 1))
  ) {
    return null;
  }

  return {
    apiVersion: '1',
    ok: true,
    postId: raw.postId,
    upvoteRatio,
    score,
    rawName: raw.rawName,
    rawId: raw.rawId,
  };
}

export function readPrawRouterConfigFromSettings(
  settingsValues: Record<string, unknown>
): PrawRouterConfig | null {
  const url = readString(settingsValues.PRAW_ROUTER_URL);
  const hmacSecret = readString(settingsValues.PRAW_ROUTER_HMAC_SECRET);

  if (!url || !hmacSecret || !isValidRouterUrl(url)) {
    return null;
  }

  return { url, hmacSecret };
}

export function signPrawRouterRequest(args: {
  timestamp: number;
  body: string;
  hmacSecret: string;
}): string {
  return createHmac('sha256', args.hmacSecret)
    .update(`${args.timestamp}.${args.body}`, 'utf8')
    .digest('hex');
}

export async function fetchPrawRouterVoteSnapshot(
  postId: string,
  options: {
    config?: PrawRouterConfig | null;
    fetchImpl?: PrawRouterFetch;
    now?: number;
    timeoutMs?: number;
  } = {}
): Promise<PrawRouterVoteSnapshot> {
  const config =
    options.config === undefined
      ? readPrawRouterConfigFromSettings({})
      : options.config;
  if (!config) {
    return failureSnapshot({
      postId,
      error: 'Missing or invalid PRAW router configuration.',
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timestamp = Math.floor((options.now ?? Date.now()) / 1_000);
  const body = JSON.stringify({ postId });
  const signature = signPrawRouterRequest({
    timestamp,
    body,
    hmacSecret: config.hmacSecret,
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Timestamp': String(timestamp),
        'X-Request-Signature': `v1=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      return failureSnapshot({
        postId,
        httpStatus: response.status,
        error:
          `PRAW router HTTP ${response.status} ${response.statusText ?? ''} ${previewText(text)}`.trim(),
      });
    }

    const parsed = readSuccessResponse(JSON.parse(text) as unknown);
    if (!parsed) {
      return failureSnapshot({
        postId,
        error: 'PRAW router returned an invalid success response.',
      });
    }

    if (
      parsed.postId !== postId ||
      parsed.rawName !== postId ||
      `t3_${parsed.rawId}` !== postId
    ) {
      return {
        ...failureSnapshot({
          postId,
          error: 'PRAW router returned a different post.',
        }),
        rawName: parsed.rawName,
        rawId: parsed.rawId,
      };
    }

    return {
      ...baseSnapshot(postId),
      ok: true,
      score: parsed.score,
      upvoteRatio: parsed.upvoteRatio,
      ratioPercent:
        parsed.upvoteRatio === null
          ? null
          : `${(parsed.upvoteRatio * 100).toFixed(1)}%`,
      rawName: parsed.rawName,
      rawId: parsed.rawId,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'PRAW router request timed out.'
        : err instanceof Error
          ? err.message
          : String(err);
    return failureSnapshot({ postId, error: message });
  } finally {
    clearTimeout(timeout);
  }
}
