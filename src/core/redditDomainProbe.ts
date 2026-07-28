import type { RedditOAuthConfig } from './redditOAuthRatio';

export type RedditProbeTarget = {
  label: string;
  url: string;
  method: 'GET' | 'POST';
  auth: 'none' | 'basic' | 'bearer';
  body?: string;
};

export type RedditProbeResult = {
  label: string;
  host: string;
  url: string;
  method: 'GET' | 'POST';
  allowed: boolean;
  blocked: boolean;
  httpStatus: number | null;
  contentType: string | null;
  responseTextPreview: string | null;
  parsedUpvoteRatio: number | null;
  parsedScore: number | null;
  parsedName: string | null;
  error: string | null;
};

export type RedditProbeReport = {
  postId: string;
  shortId: string;
  subreddit: string;
  tokenAvailable: boolean;
  results: RedditProbeResult[];
};

type ProbeFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const PROBE_POST_ID = 't3_1tqgga7';
const PROBE_SHORT_ID = '1tqgga7';
const PROBE_SUBREDDIT = 'HestiaListens';
const PROBE_RESPONSE_PREVIEW_LENGTH = 300;
const DEFAULT_USER_AGENT = 'Downvote-Delete/1.4.1 by Alan-Foster';

const unauthenticatedUrls = [
  'https://www.reddit.com/r/HestiaListens/comments/1tqgga7.json',
  'https://old.reddit.com/r/HestiaListens/comments/1tqgga7.json',
  'https://new.reddit.com/r/HestiaListens/comments/1tqgga7.json',
  'https://sh.reddit.com/r/HestiaListens/comments/1tqgga7.json',
  'https://np.reddit.com/r/HestiaListens/comments/1tqgga7.json',
  'https://i.reddit.com/r/HestiaListens/comments/1tqgga7.json',
  'https://amp.reddit.com/r/HestiaListens/comments/1tqgga7.json',
  'https://www.reddit.com/by_id/t3_1tqgga7.json',
  'https://old.reddit.com/by_id/t3_1tqgga7.json',
  'https://new.reddit.com/by_id/t3_1tqgga7.json',
  'https://sh.reddit.com/by_id/t3_1tqgga7.json',
];

const tokenUrls = [
  'https://www.reddit.com/api/v1/access_token',
  'https://ssl.reddit.com/api/v1/access_token',
  'https://old.reddit.com/api/v1/access_token',
];

const oauthUrls = [
  'https://oauth.reddit.com/by_id/t3_1tqgga7',
  'https://oauth.reddit.com/api/info?id=t3_1tqgga7',
  'https://oauth.reddit.com/r/HestiaListens/comments/1tqgga7',
  'https://oauth.reddit.com/comments/1tqgga7',
  'https://oauth.reddit.com/r/HestiaListens/new?limit=100',
  'https://oauth.reddit.com/r/HestiaListens/hot?limit=100',
  'https://oauth.reddit.com/r/HestiaListens/rising?limit=100',
  'https://oauth.reddit.com/r/HestiaListens/controversial?limit=100',
  'https://oauth.reddit.com/user/ModBotGPT/submitted?limit=100',
  'https://oauth.reddit.com/r/HestiaListens/search?q=1tqgga7&restrict_sr=1&type=link',
  'https://oauth.reddit.com/search?q=1tqgga7&type=link',
];

const oauthishUrls = [
  'https://www.reddit.com/api/info?id=t3_1tqgga7',
  'https://old.reddit.com/api/info?id=t3_1tqgga7',
  'https://ssl.reddit.com/api/info?id=t3_1tqgga7',
];

function basicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

export function sanitizeProbeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [redacted]')
    .replace(
      /(access_token|refresh_token|client_secret|authorization)["'\s:=]+[^"',\s}]+/gi,
      '$1=[redacted]'
    )
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

export function previewProbeText(value: string): string {
  return sanitizeProbeText(value).slice(0, PROBE_RESPONSE_PREVIEW_LENGTH);
}

type ParsedVoteFields = {
  parsedUpvoteRatio: number | null;
  parsedScore: number | null;
  parsedName: string | null;
};

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fieldsFromObject(value: Record<string, unknown>): ParsedVoteFields {
  return {
    parsedUpvoteRatio: readNumber(value.upvote_ratio),
    parsedScore: readNumber(value.score),
    parsedName: typeof value.name === 'string' ? value.name : null,
  };
}

function scoreCandidate(candidate: ParsedVoteFields): number {
  return (
    (candidate.parsedName === PROBE_POST_ID ? 4 : 0) +
    (candidate.parsedUpvoteRatio !== null ? 2 : 0) +
    (candidate.parsedScore !== null ? 1 : 0)
  );
}

function scanForVoteFields(value: unknown): ParsedVoteFields | null {
  let best: ParsedVoteFields | null = null;
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }

    if (!isObject(candidate)) {
      return;
    }

    const fields = fieldsFromObject(candidate);
    if (
      fields.parsedName !== null ||
      fields.parsedUpvoteRatio !== null ||
      fields.parsedScore !== null
    ) {
      if (!best || scoreCandidate(fields) > scoreCandidate(best)) {
        best = fields;
      }
    }

    for (const item of Object.values(candidate)) {
      visit(item);
    }
  };

  visit(value);
  return best;
}

export function parseProbeVoteFields(text: string): ParsedVoteFields {
  try {
    return (
      scanForVoteFields(JSON.parse(text) as unknown) ?? {
        parsedUpvoteRatio: null,
        parsedScore: null,
        parsedName: null,
      }
    );
  } catch {
    return {
      parsedUpvoteRatio: null,
      parsedScore: null,
      parsedName: null,
    };
  }
}

export function buildRedditProbeTargets(args: {
  config: RedditOAuthConfig | null;
  accessToken: string | null;
}): RedditProbeTarget[] {
  const targets: RedditProbeTarget[] = unauthenticatedUrls.map((url) => ({
    label: `unauthenticated:${new URL(url).host}${new URL(url).pathname}`,
    url,
    method: 'GET',
    auth: 'none',
  }));

  if (args.config) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: args.config.refreshToken,
    }).toString();

    for (const url of tokenUrls) {
      targets.push({
        label: `token:${new URL(url).host}`,
        url,
        method: 'POST',
        auth: 'basic',
        body,
      });
    }
  }

  if (args.accessToken) {
    for (const url of oauthUrls) {
      targets.push({
        label: `oauth:${new URL(url).host}${new URL(url).pathname}`,
        url,
        method: 'GET',
        auth: 'bearer',
      });
    }

    for (const url of oauthishUrls) {
      targets.push({
        label: `oauthish:${new URL(url).host}${new URL(url).pathname}`,
        url,
        method: 'GET',
        auth: 'bearer',
      });
    }
  }

  return targets;
}

async function probeTarget(args: {
  target: RedditProbeTarget;
  config: RedditOAuthConfig | null;
  accessToken: string | null;
  fetchImpl: ProbeFetch;
}): Promise<RedditProbeResult> {
  const headers: Record<string, string> = {
    'User-Agent': args.config?.userAgent ?? DEFAULT_USER_AGENT,
  };

  if (args.target.auth === 'basic' && args.config) {
    headers.Authorization = `Basic ${basicAuth(
      args.config.clientId,
      args.config.clientSecret
    )}`;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (args.target.auth === 'bearer' && args.accessToken) {
    headers.Authorization = `Bearer ${args.accessToken}`;
  }

  try {
    const init: {
      method: 'GET' | 'POST';
      headers: Record<string, string>;
      body?: string;
    } = {
      method: args.target.method,
      headers,
    };

    if (args.target.body) {
      init.body = args.target.body;
    }

    const response = await args.fetchImpl(args.target.url, init);
    const text = await response.text();
    const parsed = parseProbeVoteFields(text);

    return {
      label: args.target.label,
      host: new URL(args.target.url).host,
      url: args.target.url,
      method: args.target.method,
      allowed: true,
      blocked: false,
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      responseTextPreview: previewProbeText(text),
      parsedUpvoteRatio: parsed.parsedUpvoteRatio,
      parsedScore: parsed.parsedScore,
      parsedName: parsed.parsedName,
      error: null,
    };
  } catch (err: unknown) {
    return {
      label: args.target.label,
      host: new URL(args.target.url).host,
      url: args.target.url,
      method: args.target.method,
      allowed: false,
      blocked: true,
      httpStatus: null,
      contentType: null,
      responseTextPreview: null,
      parsedUpvoteRatio: null,
      parsedScore: null,
      parsedName: null,
      error: sanitizeProbeText(err instanceof Error ? err.message : String(err)),
    };
  }
}

function readAccessToken(text: string): string | null {
  try {
    const raw = JSON.parse(text) as unknown;
    return isObject(raw) && typeof raw.access_token === 'string'
      ? raw.access_token
      : null;
  } catch {
    return null;
  }
}

async function fetchFirstAccessToken(args: {
  config: RedditOAuthConfig | null;
  fetchImpl: ProbeFetch;
}): Promise<string | null> {
  if (!args.config) {
    return null;
  }

  for (const url of tokenUrls) {
    try {
      const response = await args.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth(
            args.config.clientId,
            args.config.clientSecret
          )}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': args.config.userAgent,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: args.config.refreshToken,
        }).toString(),
      });
      const accessToken = response.ok ? readAccessToken(await response.text()) : null;
      if (accessToken) {
        return accessToken;
      }
    } catch {
      // Individual token endpoint failures are captured again in probe results.
    }
  }

  return null;
}

export async function runRedditDomainProbe(args: {
  config: RedditOAuthConfig | null;
  fetchImpl?: ProbeFetch;
}): Promise<RedditProbeReport> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const accessToken = await fetchFirstAccessToken({
    config: args.config,
    fetchImpl,
  });
  const targets = buildRedditProbeTargets({
    config: args.config,
    accessToken,
  });
  const results: RedditProbeResult[] = [];

  for (const target of targets) {
    results.push(
      await probeTarget({
        target,
        config: args.config,
        accessToken,
        fetchImpl,
      })
    );
  }

  return {
    postId: PROBE_POST_ID,
    shortId: PROBE_SHORT_ID,
    subreddit: PROBE_SUBREDDIT,
    tokenAvailable: accessToken !== null,
    results,
  };
}
