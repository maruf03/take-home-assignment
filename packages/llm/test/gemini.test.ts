import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeminiProvider, LlmError, type ExtractionRequest } from '../src/index.js';

interface MockResponseSpec {
  status: number;
  headers?: Record<string, string>;
  body: string;
  delayBeforeHeadersMs?: number;
}

const SAMPLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'document_flags'],
  properties: {
    fields: {
      type: 'object',
      additionalProperties: false,
      required: ['vendor_name'],
      properties: {
        vendor_name: {
          type: 'object',
          additionalProperties: false,
          required: ['found', 'value', 'quote', 'line', 'not_found_reason'],
          properties: {
            found: { type: 'boolean' },
            value: { type: 'string' },
            quote: { type: 'string' },
            line: { type: 'integer' },
            not_found_reason: { type: 'string' },
          },
        },
      },
    },
    document_flags: {
      type: 'object',
      additionalProperties: false,
      required: ['suspicious_instructions', 'spans'],
      properties: {
        suspicious_instructions: { type: 'boolean' },
        spans: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

function makeReq(overrides: Partial<ExtractionRequest> = {}): ExtractionRequest {
  return {
    system: 'Extract fields strictly.',
    user: 'Document text here',
    schema: SAMPLE_SCHEMA,
    toolName: 'record_extraction',
    model: 'gemini-3.5-flash',
    maxOutputTokens: 1024,
    cacheKey: 'cache-key-1',
    ...overrides,
  };
}

describe('GeminiProvider (mock HTTP server, §15.4 & §15.5)', () => {
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;
  let nextResponse: MockResponseSpec = { status: 200, body: '{}' };
  let lastRequestBody: Record<string, unknown> | null = null;
  let lastRequestUrl = '';

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      lastRequestUrl = req.url ?? '';
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      lastRequestBody = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : null;

      const spec = nextResponse;
      if (spec.delayBeforeHeadersMs && spec.delayBeforeHeadersMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, spec.delayBeforeHeadersMs);
          req.once('close', () => {
            clearTimeout(t);
            resolve();
          });
        });
        if (res.destroyed || req.destroyed) {
          return;
        }
      }

      res.writeHead(spec.status, {
        'content-type': 'application/json',
        ...(spec.headers ?? {}),
      });
      res.end(spec.body);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    lastRequestBody = null;
    lastRequestUrl = '';
  });

  it('sends responseJsonSchema + thinkingBudget:0, captures raw body verbatim, and maps responseId & served modelVersion', async () => {
    const rawBody = JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                text: JSON.stringify({
                  fields: {
                    vendor_name: {
                      found: true,
                      value: 'MERIDIAN OFFICE SUPPLIES LLC',
                      quote: 'MERIDIAN OFFICE SUPPLIES LLC',
                      line: 1,
                      not_found_reason: '',
                    },
                  },
                  document_flags: { suspicious_instructions: false, spans: [] },
                }),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 604,
        candidatesTokenCount: 280,
        totalTokenCount: 884,
      },
      modelVersion: 'gemini-3.6-flash',
      responseId: 'resp-gemini-001',
    });
    nextResponse = { status: 200, body: rawBody };

    const provider = new GeminiProvider({ apiKey: 'test-key', baseUrl });
    expect(provider.capabilities.constrainedSchema).toBe(true);

    const res = await provider.extract(makeReq());
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;

    expect(res.rawText).toBe(rawBody);
    expect(res.model).toBe('gemini-3.5-flash');
    expect(res.servedModel).toBe('gemini-3.6-flash');
    expect(res.providerRequestId).toBe('resp-gemini-001');
    expect(res.usage).toMatchObject({ inputTokens: 604, outputTokens: 280 });
    expect(lastRequestUrl).toContain('gemini-3.5-flash');

    const genCfg = lastRequestBody?.['generationConfig'] as Record<string, unknown>;
    expect(genCfg['responseMimeType']).toBe('application/json');
    expect(genCfg['responseJsonSchema']).toEqual(SAMPLE_SCHEMA);
    expect(genCfg['temperature']).toBe(0);
    expect(genCfg['thinkingConfig']).toEqual({ thinkingBudget: 0 });
  });

  it('formats Gemini repair turn as user -> model -> user keeping responseJsonSchema', async () => {
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: '{"fields":{},"document_flags":{"suspicious_instructions":false,"spans":[]}}',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        modelVersion: 'gemini-3.6-flash',
        responseId: 'resp-repair-1',
      }),
    };

    const provider = new GeminiProvider({ apiKey: 'test-key', baseUrl });
    const res = await provider.extract(
      makeReq({
        repair: {
          previousRaw: {
            candidates: [{ content: { role: 'model', parts: [{ text: '{bad' }] } }],
          },
          errors: [
            { path: 'fields.vendor_name.line', code: 'invalid_type', message: 'Expected integer' },
          ],
        },
      }),
    );
    expect(res.kind).toBe('ok');

    const contents = lastRequestBody?.['contents'] as Array<{
      role: string;
      parts: Array<{ text: string }>;
    }>;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[1]!.parts[0]!.text).toBe('{bad');
    expect(contents[2]!.parts[0]!.text).toContain('fields.vendor_name.line');
    expect(contents[2]!.parts[0]!.text).toContain('invalid_type');
  });

  it('maps Gemini finishReason MAX_TOKENS -> truncated, SAFETY -> refused, non-JSON -> schema_invalid, empty -> no_output', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key', baseUrl });

    nextResponse = {
      status: 200,
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"partial":' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 100 },
      }),
    };
    expect((await provider.extract(makeReq())).kind).toBe('truncated');

    nextResponse = {
      status: 200,
      body: JSON.stringify({
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 0 },
      }),
    };
    expect((await provider.extract(makeReq())).kind).toBe('refused');

    nextResponse = {
      status: 200,
      body: JSON.stringify({
        candidates: [
          { content: { parts: [{ text: 'not valid json {{{' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
      }),
    };
    expect((await provider.extract(makeReq())).kind).toBe('schema_invalid');

    nextResponse = {
      status: 200,
      body: JSON.stringify({
        candidates: [],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 0 },
      }),
    };
    expect((await provider.extract(makeReq())).kind).toBe('no_output');
  });

  it('maps Gemini HTTP errors accurately (429 retryDelay -> transient, 429 daily/no-delay -> RATE_CAPPED, 503 -> transient, 400 -> BAD_REQUEST, 403 -> AUTH)', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key', baseUrl });

    // 429 PerMinute with RetryInfo.retryDelay -> transient RATE_LIMITED with retryAfterMs
    nextResponse = {
      status: 429,
      body: JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded. Please retry in 39.5s.',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
                  quotaValue: '5',
                },
              ],
            },
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '39s',
            },
          ],
        },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      transient: true,
      retryAfterMs: 39_000,
    });

    // 429 PerDay / daily quota -> permanent RATE_CAPPED
    nextResponse = {
      status: 429,
      body: JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Daily quota exhausted',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
            },
          ],
        },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'RATE_CAPPED',
      transient: false,
    });

    // 429 without RetryInfo -> permanent RATE_CAPPED
    nextResponse = {
      status: 429,
      body: JSON.stringify({
        error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota cap' },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'RATE_CAPPED',
      transient: false,
    });

    // 503 -> transient OVERLOADED
    nextResponse = {
      status: 503,
      body: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'OVERLOADED',
      transient: true,
    });

    // 400 -> permanent BAD_REQUEST
    nextResponse = {
      status: 400,
      body: JSON.stringify({
        error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad schema' },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      transient: false,
    });

    // 403 -> permanent AUTH
    nextResponse = {
      status: 403,
      body: JSON.stringify({
        error: { code: 403, status: 'PERMISSION_DENIED', message: 'bad key' },
      }),
    };
    let caught: unknown;
    try {
      await provider.extract(makeReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmError);
    expect(caught).toMatchObject({ code: 'AUTH', transient: false });

    // 401 -> permanent AUTH
    nextResponse = {
      status: 401,
      body: JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'no key' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'AUTH',
      transient: false,
    });

    // 404 -> permanent MODEL_NOT_FOUND
    nextResponse = {
      status: 404,
      body: JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'bad model' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      transient: false,
    });

    // 408 and 504 -> transient TIMEOUT
    nextResponse = { status: 408, body: 'Request timeout' };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'TIMEOUT',
      transient: true,
      status: 408,
    });
    nextResponse = { status: 504, body: 'Gateway timeout' };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'TIMEOUT',
      transient: true,
      status: 504,
    });

    // 499 (server-side cancellation, caller did not abort) -> transient NETWORK
    nextResponse = { status: 499, body: 'Client closed request' };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'NETWORK',
      transient: true,
      status: 499,
    });

    // 500 -> transient SERVER
    nextResponse = { status: 500, body: 'Internal server error' };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'SERVER',
      transient: true,
      status: 500,
    });
  });

  it('classifies internal timeout as transient TIMEOUT (never ABORTED), caller abort as ABORTED, promptFeedback.blockReason as refused, and ignores thought parts', async () => {
    // 1. Internal timeoutMs -> transient TIMEOUT (NOT permanent ABORTED)
    const fastTimeoutProvider = new GeminiProvider({ apiKey: 'test-key', baseUrl, timeoutMs: 80 });
    nextResponse = { status: 200, body: '{}', delayBeforeHeadersMs: 500 };
    await expect(fastTimeoutProvider.extract(makeReq())).rejects.toMatchObject({
      code: 'TIMEOUT',
      transient: true,
    });

    // 2. Caller AbortSignal -> permanent ABORTED
    const provider = new GeminiProvider({ apiKey: 'test-key', baseUrl, timeoutMs: 5_000 });
    const ac = new AbortController();
    nextResponse = { status: 200, body: '{}', delayBeforeHeadersMs: 500 };
    setTimeout(() => ac.abort(), 30);
    await expect(provider.extract(makeReq({ signal: ac.signal }))).rejects.toMatchObject({
      code: 'ABORTED',
      transient: false,
    });

    // 3. promptFeedback.blockReason -> kind: 'refused' with stopReason preserved
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 0 },
      }),
    };
    const blocked = await provider.extract(makeReq());
    expect(blocked.kind).toBe('refused');
    expect(blocked.stopReason).toBe('PROHIBITED_CONTENT');

    // 4. thought: true parts are ignored when parsing structured JSON
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Let me think step by step...' },
                {
                  text: JSON.stringify({
                    fields: {
                      vendor_name: {
                        found: true,
                        value: 'Acme',
                        quote: 'Acme',
                        line: 1,
                        not_found_reason: '',
                      },
                    },
                    document_flags: { suspicious_instructions: false, spans: [] },
                  }),
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
      }),
    };
    const withThought = await provider.extract(makeReq());
    expect(withThought.kind).toBe('ok');
  });
});
