import { logInfo } from './logging';

export type RawRedditVoteFields = {
  name: string | 'missing';
  id: string | 'missing';
  upvoteRatio: number | 'missing';
  ratioPercent: string;
  ups: number | 'missing';
  downs: number | 'missing';
  score: number | 'missing';
};

export type OpenAIParserPath =
  | 'structured_json'
  | 'structured_json_text'
  | 'salvage_wrapper_text'
  | 'salvage_json_text'
  | 'failed';

export type OpenAIExtractionSource = 'parsed_json' | 'text_scan' | 'none';

export type OpenAIRatioFetchResult = {
  ok: boolean;
  jsonReceived: boolean;
  requestedUrl: string;
  retrievedUrl: string;
  cacheBustMatched?: boolean;
  responseTextLength?: number | undefined;
  responseTextPreview?: string | undefined;
  jsonTextLength?: number | undefined;
  jsonTextPreview?: string | undefined;
  parserPath?: OpenAIParserPath;
  extractionSource?: OpenAIExtractionSource;
  openAIWrapperOk?: boolean;
  fields?: RawRedditVoteFields;
  error: string;
};

type OpenAIRedditJsonFetch = {
  ok: boolean;
  requested_url: string;
  retrieved_url: string;
  json_text: string;
  error: string;
};

type OpenAIResponsesFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

const OPENAI_RATIO_MODEL = 'gpt-5.4-nano';
const RESPONSE_PREVIEW_LENGTH = 2000;

function normalizedPostId(postId: string): string {
  return postId.startsWith('t3_') ? postId : `t3_${postId}`;
}

function cacheBustValue(now: number): string {
  return new Date(now).toISOString().replace(/:/g, '-');
}

function withRawJsonAndCacheBust(baseUrl: string, now: number): string {
  return `${baseUrl}?raw_json=1&cache_bust=${cacheBustValue(now)}`;
}

function previewText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value
    .slice(0, RESPONSE_PREVIEW_LENGTH)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function normalizePermalink(permalink: string): string | undefined {
  const trimmed = permalink.trim();
  if (!trimmed) {
    return undefined;
  }

  const pathOnly = trimmed.startsWith('https://www.reddit.com')
    ? trimmed.slice('https://www.reddit.com'.length)
    : trimmed;
  const withoutJson = pathOnly.replace(/\.json(?:\?.*)?$/, '');
  const withoutQuery = withoutJson.split('?')[0] ?? withoutJson;
  const withoutTrailingSlash = withoutQuery.replace(/\/+$/, '');
  const normalizedPath = withoutTrailingSlash.startsWith('/')
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`;
  const commentsMatch = normalizedPath.match(
    /^(\/r\/[^/]+\/comments\/[^/]+)(?:\/.*)?$/
  );
  return commentsMatch?.[1] ?? normalizedPath;
}

export function buildRedditByIdJsonUrl(postId: string, now?: number): string {
  const postIdWithPrefix = normalizedPostId(postId);
  const baseUrl = `https://www.reddit.com/by_id/${postIdWithPrefix}.json`;
  if (typeof now !== 'number') {
    return `${baseUrl}?raw_json=1`;
  }

  return withRawJsonAndCacheBust(baseUrl, now);
}

export function buildRedditPostJsonUrl(args: {
  postId: string;
  now: number;
  permalink?: string | undefined;
}): string {
  const permalink = args.permalink
    ? normalizePermalink(args.permalink)
    : undefined;
  if (permalink) {
    return withRawJsonAndCacheBust(
      `https://www.reddit.com${permalink}.json`,
      args.now
    );
  }

  return buildRedditByIdJsonUrl(args.postId, args.now);
}

export function buildRedditPostJsonRequest(args: {
  postId: string;
  now: number;
  permalink?: string | undefined;
}): {
  url: string;
  cacheBust: string | undefined;
  permalinkSource: 'canonical' | 'by_id_fallback';
} {
  const permalink = args.permalink
    ? normalizePermalink(args.permalink)
    : undefined;
  const url = permalink
    ? withRawJsonAndCacheBust(`https://www.reddit.com${permalink}.json`, args.now)
    : buildRedditByIdJsonUrl(args.postId, args.now);

  return {
    url,
    cacheBust: readCacheBust(url),
    permalinkSource: permalink ? 'canonical' : 'by_id_fallback',
  };
}

function readCacheBust(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('cache_bust') ?? undefined;
  } catch {
    return undefined;
  }
}

function hasCacheBust(url: string, cacheBust: string): boolean {
  try {
    return new URL(url).searchParams.get('cache_bust') === cacheBust;
  } catch {
    return url.includes(`cache_bust=${cacheBust}`);
  }
}

function cacheBustMatched(args: {
  requestedUrl: string;
  retrievedUrl: string;
}): boolean | undefined {
  const requestedCacheBust = readCacheBust(args.requestedUrl);
  if (!requestedCacheBust) {
    return undefined;
  }

  return hasCacheBust(args.retrievedUrl, requestedCacheBust);
}

function rejectCacheBustMismatch(
  result: OpenAIRatioFetchResult
): OpenAIRatioFetchResult {
  const matched = cacheBustMatched({
    requestedUrl: result.requestedUrl,
    retrievedUrl: result.retrievedUrl,
  });
  if (matched !== false) {
    return matched === undefined ? result : { ...result, cacheBustMatched: true };
  }

  const { fields: _fields, ...resultWithoutFields } = result;
  return {
    ...resultWithoutFields,
    ok: false,
    cacheBustMatched: false,
    error: 'OpenAI retrieved URL did not include the requested cache_bust value.',
  };
}

export function buildRedditJsonUrl(postId: string, now: number): string {
  const normalizedPostId = postId.startsWith('t3_') ? postId : `t3_${postId}`;
  return buildRedditByIdJsonUrl(normalizedPostId, now);
}

function readNumber(value: unknown): number | 'missing' {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : 'missing';
}

function readString(value: unknown): string | 'missing' {
  return typeof value === 'string' && value ? value : 'missing';
}

function readNumberText(value: string | undefined): number | 'missing' {
  if (value === undefined) {
    return 'missing';
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 'missing';
}

function ratioPercent(upvoteRatio: number | 'missing'): string {
  return typeof upvoteRatio === 'number'
    ? `${(upvoteRatio * 100).toFixed(1)}%`
    : 'missing';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readPostDataFromListing(raw: unknown): Record<string, unknown> | null {
  const listing = Array.isArray(raw) ? raw[0] : raw;
  if (!isObject(listing)) {
    return null;
  }

  const data = listing.data;
  if (!isObject(data) || !Array.isArray(data.children)) {
    return null;
  }

  const postChild = data.children.find(
    (child: unknown) => isObject(child) && child.kind === 't3'
  );
  if (!isObject(postChild) || !isObject(postChild.data)) {
    return null;
  }

  return postChild.data;
}

export function extractRawRedditVoteFields(
  jsonText: string
): RawRedditVoteFields | null {
  const raw = JSON.parse(jsonText) as unknown;
  const postData = readPostDataFromListing(raw);
  if (!postData) {
    return null;
  }

  const upvoteRatio = readNumber(postData.upvote_ratio);
  return {
    name: readString(postData.name),
    id: readString(postData.id),
    upvoteRatio,
    ratioPercent: ratioPercent(upvoteRatio),
    ups: readNumber(postData.ups),
    downs: readNumber(postData.downs),
    score: readNumber(postData.score),
  };
}

function quotePattern(): string {
  return '\\\\?"';
}

function fieldPrefixPattern(fieldName: string): string {
  const quote = quotePattern();
  return `${quote}${fieldName}${quote}\\s*:\\s*`;
}

function readNumberFromText(
  source: string,
  fieldName: string
): number | 'missing' {
  const prefix = fieldPrefixPattern(fieldName);
  const quoted = new RegExp(`${prefix}${quotePattern()}(-?\\d+(?:\\.\\d+)?)`);
  const unquoted = new RegExp(`${prefix}(-?\\d+(?:\\.\\d+)?)`);
  return readNumberText(quoted.exec(source)?.[1] ?? unquoted.exec(source)?.[1]);
}

function readStringFromText(
  source: string,
  fieldName: string
): string | 'missing' {
  const match = new RegExp(
    `${fieldPrefixPattern(fieldName)}${quotePattern()}([^"\\\\]*)${quotePattern()}`
  ).exec(source);
  return readString(match?.[1]);
}

function firstPostTextBlock(source: string): string {
  const t3Marker =
    source.indexOf('"kind": "t3"') >= 0
      ? '"kind": "t3"'
      : source.indexOf('"kind":"t3"') >= 0
        ? '"kind":"t3"'
        : source.indexOf('\\"kind\\": \\"t3\\"') >= 0
          ? '\\"kind\\": \\"t3\\"'
          : source.indexOf('\\"kind\\":\\"t3\\"') >= 0
            ? '\\"kind\\":\\"t3\\"'
            : '';

  if (!t3Marker) {
    return source;
  }

  const start = source.indexOf(t3Marker);
  const nextT1Candidates = [
    source.indexOf('"kind": "t1"', start + t3Marker.length),
    source.indexOf('"kind":"t1"', start + t3Marker.length),
    source.indexOf('\\"kind\\": \\"t1\\"', start + t3Marker.length),
    source.indexOf('\\"kind\\":\\"t1\\"', start + t3Marker.length),
  ].filter((index) => index > start);
  const end =
    nextT1Candidates.length > 0
      ? Math.min(...nextT1Candidates)
      : source.length;

  return source.slice(start, end);
}

function extractUrlFromText(
  source: string,
  fieldName: 'requested_url' | 'retrieved_url'
): string | undefined {
  const value = readStringFromText(source, fieldName);
  return value === 'missing' ? undefined : value.replace(/\\\//g, '/');
}

function salvageRawRedditVoteFieldsFromText(
  responseText: string
): RawRedditVoteFields | null {
  const postText = firstPostTextBlock(responseText);
  const upvoteRatio = readNumberFromText(postText, 'upvote_ratio');

  if (typeof upvoteRatio !== 'number') {
    return null;
  }

  return {
    name: readStringFromText(postText, 'name'),
    id: readStringFromText(postText, 'id'),
    upvoteRatio,
    ratioPercent: ratioPercent(upvoteRatio),
    ups: readNumberFromText(postText, 'ups'),
    downs: readNumberFromText(postText, 'downs'),
    score: readNumberFromText(postText, 'score'),
  };
}

function salvageOpenAIRedditJsonResponse(
  responseText: string,
  requestedUrl: string,
  fallbackError: string,
  parserPath: Extract<
    OpenAIParserPath,
    'salvage_wrapper_text' | 'salvage_json_text'
  >,
  jsonText?: string | undefined,
  retrievedUrl?: string | undefined
): OpenAIRatioFetchResult {
  const fields = salvageRawRedditVoteFieldsFromText(responseText);
  const foundAnyVoteField =
    fields !== null ||
    /\\?"(?:upvote_ratio|ups|downs|score)\\?"\s*:/.test(responseText);
  const diagnostics = {
    responseTextLength: responseText.length,
    responseTextPreview: previewText(responseText),
    jsonTextLength: jsonText?.length,
    jsonTextPreview: previewText(jsonText),
    parserPath,
    extractionSource: fields ? ('text_scan' as const) : ('none' as const),
  };

  if (!fields) {
    return {
      ok: false,
      jsonReceived: foundAnyVoteField || responseText.includes('Listing'),
      requestedUrl: extractUrlFromText(responseText, 'requested_url') ?? requestedUrl,
      retrievedUrl:
        extractUrlFromText(responseText, 'retrieved_url') ??
        retrievedUrl ??
        requestedUrl,
      ...diagnostics,
      error: fallbackError,
    };
  }

  return {
    ok: true,
    jsonReceived: true,
    requestedUrl: extractUrlFromText(responseText, 'requested_url') ?? requestedUrl,
    retrievedUrl:
      extractUrlFromText(responseText, 'retrieved_url') ??
      retrievedUrl ??
      requestedUrl,
    ...diagnostics,
    fields,
    error: '',
  };
}

function extractResponseText(responseBody: unknown): string | undefined {
  if (!isObject(responseBody)) {
    return undefined;
  }

  if (typeof responseBody.output_text === 'string') {
    return responseBody.output_text;
  }

  const output = responseBody.output;
  if (!Array.isArray(output)) {
    return undefined;
  }

  for (const outputItem of output) {
    if (!isObject(outputItem) || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (!isObject(contentItem)) {
        continue;
      }

      if (typeof contentItem.text === 'string') {
        return contentItem.text;
      }
    }
  }

  return undefined;
}

export function parseOpenAIRedditJsonResponse(
  responseBody: unknown,
  requestedUrl: string
): OpenAIRatioFetchResult {
  const responseText = extractResponseText(responseBody);
  if (!responseText) {
    return {
      ok: false,
      jsonReceived: false,
      requestedUrl,
      retrievedUrl: 'missing',
      parserPath: 'failed',
      extractionSource: 'none',
      error: 'OpenAI response did not include structured text output.',
    };
  }
  const responseDiagnostics = {
    responseTextLength: responseText.length,
    responseTextPreview: previewText(responseText),
  };

  let structured: OpenAIRedditJsonFetch;
  try {
    structured = JSON.parse(responseText) as OpenAIRedditJsonFetch;
  } catch (err: unknown) {
    return rejectCacheBustMismatch(
      salvageOpenAIRedditJsonResponse(
        responseText,
        requestedUrl,
        err instanceof Error ? err.message : String(err),
        'salvage_wrapper_text'
      )
    );
  }
  const structuredDiagnostics = {
    ...responseDiagnostics,
    jsonTextLength: structured.json_text?.length,
    jsonTextPreview: previewText(structured.json_text),
    openAIWrapperOk: structured.ok,
  };

  if (!structured.ok || !structured.json_text) {
    return rejectCacheBustMismatch({
      ok: false,
      jsonReceived: Boolean(structured.json_text),
      requestedUrl: structured.requested_url || requestedUrl,
      retrievedUrl: structured.retrieved_url || 'missing',
      ...structuredDiagnostics,
      parserPath: 'structured_json',
      extractionSource: 'none',
      error: structured.error || 'OpenAI did not retrieve Reddit JSON.',
    });
  }

  try {
    const fields = extractRawRedditVoteFields(structured.json_text);
    if (!fields) {
      return rejectCacheBustMismatch({
        ok: false,
        jsonReceived: true,
        requestedUrl: structured.requested_url || requestedUrl,
        retrievedUrl: structured.retrieved_url || 'missing',
        ...structuredDiagnostics,
        parserPath: 'structured_json_text',
        extractionSource: 'none',
        error: 'Reddit JSON did not contain a post listing.',
      });
    }

    return rejectCacheBustMismatch({
      ok: true,
      jsonReceived: true,
      requestedUrl: structured.requested_url || requestedUrl,
      retrievedUrl: structured.retrieved_url || 'missing',
      ...structuredDiagnostics,
      parserPath: 'structured_json_text',
      extractionSource: 'parsed_json',
      fields,
      error: '',
    });
  } catch (err: unknown) {
    return rejectCacheBustMismatch(
      salvageOpenAIRedditJsonResponse(
        structured.json_text,
        structured.requested_url || requestedUrl,
        err instanceof Error ? err.message : String(err),
        'salvage_json_text',
        structured.json_text,
        structured.retrieved_url
      )
    );
  }
}

export async function fetchRedditRatioViaOpenAI(args: {
  apiKey: string;
  postId: string;
  now?: number | undefined;
  permalink?: string | undefined;
  fetchImpl?: OpenAIResponsesFetch;
}): Promise<OpenAIRatioFetchResult> {
  const now = args.now ?? Date.now();
  const request = buildRedditPostJsonRequest({
    postId: args.postId,
    now,
    permalink: args.permalink,
  });
  const requestedUrl = request.url;
  const requestedCacheBust = request.cacheBust;
  const fetchImpl = args.fetchImpl ?? fetch;

  if (!args.apiKey) {
    return {
      ok: false,
      jsonReceived: false,
      requestedUrl,
      retrievedUrl: 'missing',
      error: 'Missing global setting: openaiApiKey.',
    };
  }

  const body = {
    model: OPENAI_RATIO_MODEL,
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    input: [
      {
        role: 'system',
        content:
          'You retrieve exact public JSON response bodies. Open only the exact requested URL. Do not use cached pages, search snippets, summaries, or inferred JSON. If the retrieved URL does not include the same cache_bust query value, return ok=false.',
      },
      {
        role: 'user',
        content: `Open this exact cache-busted URL and copy the full raw response body into json_text: ${requestedUrl}${
          requestedCacheBust
            ? ` The retrieved_url must include cache_bust=${requestedCacheBust}.`
            : ''
        }`,
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'reddit_json_fetch',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'ok',
            'requested_url',
            'retrieved_url',
            'json_text',
            'error',
          ],
          properties: {
            ok: { type: 'boolean' },
            requested_url: { type: 'string' },
            retrieved_url: { type: 'string' },
            json_text: { type: 'string' },
            error: { type: 'string' },
          },
        },
      },
    },
  };

  try {
    logInfo('Sending OpenAI Reddit ratio request.', {
      postId: args.postId,
      requestedUrl,
      cacheBust: requestedCacheBust,
      model: OPENAI_RATIO_MODEL,
      usesWebSearch: true,
      permalinkSource: request.permalinkSource,
      prompt: body.input[1]?.content,
    });

    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return {
        ok: false,
        jsonReceived: false,
        requestedUrl,
        retrievedUrl: 'missing',
        parserPath: 'failed',
        extractionSource: 'none',
        error: `OpenAI HTTP ${response.status} ${response.statusText}`,
      };
    }

    return parseOpenAIRedditJsonResponse(await response.json(), requestedUrl);
  } catch (err: unknown) {
    return {
      ok: false,
      jsonReceived: false,
      requestedUrl,
      retrievedUrl: 'missing',
      parserPath: 'failed',
      extractionSource: 'none',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
