export type RawRedditVoteFields = {
  name: string | 'missing';
  id: string | 'missing';
  upvoteRatio: number | 'missing';
  ratioPercent: string;
  ups: number | 'missing';
  downs: number | 'missing';
  score: number | 'missing';
};

export type OpenAIRatioFetchResult = {
  ok: boolean;
  jsonReceived: boolean;
  requestedUrl: string;
  retrievedUrl: string;
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

export function buildRedditByIdJsonUrl(postId: string): string {
  const normalizedPostId = postId.startsWith('t3_') ? postId : `t3_${postId}`;
  return `https://www.reddit.com/by_id/${normalizedPostId}.json?raw_json=1`;
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
  fallbackError: string
): OpenAIRatioFetchResult {
  const fields = salvageRawRedditVoteFieldsFromText(responseText);
  const foundAnyVoteField =
    fields !== null ||
    /\\?"(?:upvote_ratio|ups|downs|score)\\?"\s*:/.test(responseText);

  if (!fields) {
    return {
      ok: false,
      jsonReceived: foundAnyVoteField || responseText.includes('Listing'),
      requestedUrl: extractUrlFromText(responseText, 'requested_url') ?? requestedUrl,
      retrievedUrl:
        extractUrlFromText(responseText, 'retrieved_url') ?? requestedUrl,
      error: fallbackError,
    };
  }

  return {
    ok: true,
    jsonReceived: true,
    requestedUrl: extractUrlFromText(responseText, 'requested_url') ?? requestedUrl,
    retrievedUrl: extractUrlFromText(responseText, 'retrieved_url') ?? requestedUrl,
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
      error: 'OpenAI response did not include structured text output.',
    };
  }

  let structured: OpenAIRedditJsonFetch;
  try {
    structured = JSON.parse(responseText) as OpenAIRedditJsonFetch;
  } catch (err: unknown) {
    return salvageOpenAIRedditJsonResponse(
      responseText,
      requestedUrl,
      err instanceof Error ? err.message : String(err)
    );
  }

  if (!structured.ok || !structured.json_text) {
    return {
      ok: false,
      jsonReceived: Boolean(structured.json_text),
      requestedUrl: structured.requested_url || requestedUrl,
      retrievedUrl: structured.retrieved_url || 'missing',
      error: structured.error || 'OpenAI did not retrieve Reddit JSON.',
    };
  }

  try {
    const fields = extractRawRedditVoteFields(structured.json_text);
    if (!fields) {
      return {
        ok: false,
        jsonReceived: true,
        requestedUrl: structured.requested_url || requestedUrl,
        retrievedUrl: structured.retrieved_url || 'missing',
        error: 'Reddit JSON did not contain a post listing.',
      };
    }

    return {
      ok: true,
      jsonReceived: true,
      requestedUrl: structured.requested_url || requestedUrl,
      retrievedUrl: structured.retrieved_url || 'missing',
      fields,
      error: '',
    };
  } catch (err: unknown) {
    return salvageOpenAIRedditJsonResponse(
      structured.json_text,
      structured.requested_url || requestedUrl,
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function fetchRedditRatioViaOpenAI(args: {
  apiKey: string;
  postId: string;
  fetchImpl?: OpenAIResponsesFetch;
}): Promise<OpenAIRatioFetchResult> {
  const requestedUrl = buildRedditByIdJsonUrl(args.postId);
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
    model: 'gpt-5.4-nano',
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    input: [
      {
        role: 'system',
        content:
          'You retrieve exact public JSON response bodies. Return only data that was retrieved from the requested URL. Do not summarize, transform, or infer JSON.',
      },
      {
        role: 'user',
        content: `Open this exact URL and copy the full raw response body into json_text: ${requestedUrl}`,
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
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
