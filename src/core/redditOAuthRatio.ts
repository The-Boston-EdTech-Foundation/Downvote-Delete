export type RedditTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

export type RedditOAuthListingResponse = {
  kind: 'Listing';
  data: {
    children: Array<{
      kind: 't3';
      data: {
        name: string;
        id: string;
        score?: number;
        ups?: number;
        downs?: number;
        upvote_ratio?: number;
        hide_score?: boolean;
        title?: string;
        subreddit?: string;
        permalink?: string;
      };
    }>;
  };
};

export type AuthenticatedRedditVoteSnapshot = {
  ok: boolean;
  postId: string;
  source: 'authenticated_reddit_api';
  endpoint: 'oauth_by_id';
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

export type RedditOAuthConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userAgent: string;
};

export type RedditOAuthFetch = (
  url: string,
  init: {
    method?: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

type CachedRedditToken = {
  accessToken: string;
  expiresAtMs: number;
};

const DEFAULT_REDDIT_USER_AGENT = 'Downvote-Delete/1.4.1 by Alan-Foster';
const REDDIT_OAUTH_TOKEN_URL =
  'https://oauth.reddit.com/api/v1/access_token';
const REDDIT_OAUTH_BY_ID_BASE_URL = 'https://oauth.reddit.com/by_id';
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_TOKEN_EXPIRES_SECONDS = 3_600;
const ERROR_PREVIEW_LENGTH = 500;

let cachedRedditToken: CachedRedditToken | null = null;
let pendingTokenRequest: Promise<string> | null = null;

function baseSnapshot(
  postId: string
): Omit<AuthenticatedRedditVoteSnapshot, 'ok'> {
  return {
    postId,
    source: 'authenticated_reddit_api',
    endpoint: 'oauth_by_id',
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
}): AuthenticatedRedditVoteSnapshot {
  const snapshot: AuthenticatedRedditVoteSnapshot = {
    ...baseSnapshot(args.postId),
    ok: false,
    error: redactTokenLikeValues(args.error),
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

function redactTokenLikeValues(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [redacted]')
    .replace(
      /(access_token|refresh_token|client_secret|Authorization)["'\s:=]+[^"',\s}]+/gi,
      '$1=[redacted]'
    );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function readAccessTokenResponse(raw: unknown): RedditTokenResponse | null {
  if (!isObject(raw) || typeof raw.access_token !== 'string') {
    return null;
  }

  const response: RedditTokenResponse = {
    access_token: raw.access_token,
  };

  if (typeof raw.token_type === 'string') {
    response.token_type = raw.token_type;
  }

  if (typeof raw.expires_in === 'number') {
    response.expires_in = raw.expires_in;
  }

  if (typeof raw.scope === 'string') {
    response.scope = raw.scope;
  }

  return response;
}

function readPostData(
  raw: unknown
): RedditOAuthListingResponse['data']['children'][number]['data'] | null {
  if (!isObject(raw) || !isObject(raw.data) || !Array.isArray(raw.data.children)) {
    return null;
  }

  const child = raw.data.children[0];
  if (!isObject(child) || child.kind !== 't3' || !isObject(child.data)) {
    return null;
  }

  const data = child.data;
  if (typeof data.name !== 'string' || typeof data.id !== 'string') {
    return null;
  }

  const postData: RedditOAuthListingResponse['data']['children'][number]['data'] = {
    name: data.name,
    id: data.id,
  };

  const score = readNumber(data.score);
  const ups = readNumber(data.ups);
  const downs = readNumber(data.downs);
  const upvoteRatio = readNumber(data.upvote_ratio);
  const hideScore = readBoolean(data.hide_score);

  if (score !== null) {
    postData.score = score;
  }

  if (ups !== null) {
    postData.ups = ups;
  }

  if (downs !== null) {
    postData.downs = downs;
  }

  if (upvoteRatio !== null) {
    postData.upvote_ratio = upvoteRatio;
  }

  if (hideScore !== null) {
    postData.hide_score = hideScore;
  }

  if (typeof data.title === 'string') {
    postData.title = data.title;
  }

  if (typeof data.subreddit === 'string') {
    postData.subreddit = data.subreddit;
  }

  if (typeof data.permalink === 'string') {
    postData.permalink = data.permalink;
  }

  return postData;
}

export function readRedditOAuthConfigFromSettings(
  settingsValues: Record<string, unknown>
): RedditOAuthConfig | null {
  const clientId = readString(settingsValues.REDDIT_CLIENT_ID);
  const clientSecret = readString(settingsValues.REDDIT_CLIENT_SECRET);
  const refreshToken = readString(settingsValues.REDDIT_REFRESH_TOKEN);
  const userAgent =
    readString(settingsValues.REDDIT_USER_AGENT) || DEFAULT_REDDIT_USER_AGENT;

  if (!clientId || !clientSecret || !refreshToken || !userAgent) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    userAgent,
  };
}

async function requestRedditAccessToken(args: {
  config: RedditOAuthConfig;
  fetchImpl: RedditOAuthFetch;
  now: number;
}): Promise<string> {
  const response = await args.fetchImpl(REDDIT_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${encodeBasicAuth(
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
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Reddit token HTTP ${response.status} ${response.statusText ?? ''} ${previewText(text)}`.trim()
    );
  }

  const tokenResponse = readAccessTokenResponse(parseJson(text));
  if (!tokenResponse?.access_token) {
    throw new Error('Reddit token response did not include access_token.');
  }

  const expiresInMs =
    (tokenResponse.expires_in ?? DEFAULT_TOKEN_EXPIRES_SECONDS) * 1_000;
  cachedRedditToken = {
    accessToken: tokenResponse.access_token,
    expiresAtMs: args.now + expiresInMs - TOKEN_REFRESH_BUFFER_MS,
  };

  return tokenResponse.access_token;
}

async function getRedditAccessToken(args: {
  config: RedditOAuthConfig;
  fetchImpl: RedditOAuthFetch;
  now: number;
}): Promise<string> {
  if (
    cachedRedditToken &&
    cachedRedditToken.expiresAtMs > args.now + TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedRedditToken.accessToken;
  }

  pendingTokenRequest ??= requestRedditAccessToken(args).finally(() => {
    pendingTokenRequest = null;
  });

  return pendingTokenRequest;
}

export async function fetchAuthenticatedRedditVoteSnapshot(
  postId: string,
  options: {
    config?: RedditOAuthConfig | null;
    fetchImpl?: RedditOAuthFetch;
    now?: number;
  } = {}
): Promise<AuthenticatedRedditVoteSnapshot> {
  const config =
    options.config === undefined
      ? readRedditOAuthConfigFromSettings({})
      : options.config;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();

  if (!config) {
    return failureSnapshot({
      postId,
      error: 'Missing required Reddit OAuth credentials.',
    });
  }

  try {
    const accessToken = await getRedditAccessToken({ config, fetchImpl, now });
    const response = await fetchImpl(
      `${REDDIT_OAUTH_BY_ID_BASE_URL}/${postId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': config.userAgent,
        },
      }
    );
    const text = await response.text();

    if (!response.ok) {
      return failureSnapshot({
        postId,
        httpStatus: response.status,
        error:
          `Reddit OAuth HTTP ${response.status} ${response.statusText ?? ''} ${previewText(text)}`.trim(),
      });
    }

    const post = readPostData(parseJson(text));
    if (!post) {
      return failureSnapshot({
        postId,
        error: 'No post returned from Reddit OAuth by_id response.',
      });
    }

    if (post.name !== postId) {
      return {
        ...failureSnapshot({
          postId,
          error: 'Wrong post returned from Reddit OAuth by_id response.',
        }),
        rawName: post.name,
        rawId: post.id,
      };
    }

    const upvoteRatio = readNumber(post.upvote_ratio);
    return {
      ...baseSnapshot(postId),
      ok: true,
      score: readNumber(post.score),
      upvoteRatio,
      ratioPercent:
        upvoteRatio === null ? null : `${(upvoteRatio * 100).toFixed(1)}%`,
      hideScore: readBoolean(post.hide_score),
      ups: readNumber(post.ups),
      downs: readNumber(post.downs),
      rawName: post.name,
      rawId: post.id,
    };
  } catch (err: unknown) {
    return failureSnapshot({
      postId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function resetRedditOAuthTokenCacheForTests(): void {
  cachedRedditToken = null;
  pendingTokenRequest = null;
}
