import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, LlmError, type ExtractionRequest } from '../src/index.js';

interface MockResponseSpec {
  status: number;
  headers?: Record<string, string>;
  body: string;
  stallBodyMs?: number;
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
    model: 'claude-sonnet-5-5',
    maxOutputTokens: 1024,
    cacheKey: 'cache-key-1',
    ...overrides,
  };
}

describe('AnthropicProvider (mock HTTP server, §5.3)', () => {
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;
  let nextResponse: MockResponseSpec = { status: 200, body: '{}' };
  let lastRequestBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      lastRequestBody = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : null;

      const spec = nextResponse;
      res.writeHead(spec.status, {
        'content-type': 'application/json',
        ...(spec.headers ?? {}),
      });
      if (spec.stallBodyMs && spec.stallBodyMs > 0) {
        res.write('{"partial":');
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, spec.stallBodyMs);
          req.once('close', () => {
            clearTimeout(t);
            resolve();
          });
        });
        if (!res.destroyed) {
          res.end('true}');
        }
        return;
      }
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
  });

  it('uses forced tool_choice + strict + cache_control, captures raw body verbatim via .asResponse(), and reads request-id header', async () => {
    const rawBody = JSON.stringify({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5-20261001',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'record_extraction',
          input: {
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
          },
        },
      ],
      usage: {
        input_tokens: 700,
        output_tokens: 210,
        cache_creation_input_tokens: 512,
        cache_read_input_tokens: 0,
      },
    });
    nextResponse = {
      status: 200,
      headers: { 'request-id': 'req_anth_999' },
      body: rawBody,
    };

    const provider = new AnthropicProvider({ apiKey: 'test-key', baseURL: baseUrl });
    const res = await provider.extract(makeReq());
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;

    expect(res.rawText).toBe(rawBody);
    expect(res.providerRequestId).toBe('req_anth_999');
    expect(res.servedModel).toBe('claude-sonnet-5-5-20261001');
    expect(res.usage).toMatchObject({
      inputTokens: 700,
      outputTokens: 210,
      cacheCreationInputTokens: 512,
    });

    const tools = lastRequestBody?.['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({
      name: 'record_extraction',
      strict: true,
      cache_control: { type: 'ephemeral' },
    });
    expect(lastRequestBody?.['tool_choice']).toEqual({ type: 'tool', name: 'record_extraction' });
  });

  it('formats Anthropic repair turn as assistant tool_use + user tool_result with is_error:true', async () => {
    nextResponse = {
      status: 200,
      headers: { 'request-id': 'req_rep_1' },
      body: JSON.stringify({
        id: 'msg_02',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_02',
            name: 'record_extraction',
            input: { fields: {}, document_flags: { suspicious_instructions: false, spans: [] } },
          },
        ],
        usage: { input_tokens: 200, output_tokens: 50 },
      }),
    };

    const provider = new AnthropicProvider({ apiKey: 'test-key', baseURL: baseUrl });
    const res = await provider.extract(
      makeReq({
        repair: {
          previousRaw: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_prev_1',
                name: 'record_extraction',
                input: { bad: true },
              },
            ],
          },
          errors: [
            { path: 'fields.vendor_name.quote', code: 'too_big', message: 'Quote too long' },
          ],
        },
      }),
    );
    expect(res.kind).toBe('ok');

    const messages = lastRequestBody?.['messages'] as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(3);
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.content).toEqual([
      { type: 'tool_use', id: 'toolu_prev_1', name: 'record_extraction', input: { bad: true } },
    ]);
    expect(messages[2]!.role).toBe('user');
    const toolResult = (messages[2]!.content as Array<Record<string, unknown>>)[0]!;
    expect(toolResult['type']).toBe('tool_result');
    expect(toolResult['tool_use_id']).toBe('toolu_prev_1');
    expect(toolResult['is_error']).toBe(true);
    expect(String(toolResult['content'])).toContain('fields.vendor_name.quote');
  });

  it('maps Anthropic stop reasons and HTTP errors (429 with/without retry-after, 529, 500, 401, 400)', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', baseURL: baseUrl });

    // max_tokens -> truncated
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        stop_reason: 'max_tokens',
        content: [],
        usage: { input_tokens: 100, output_tokens: 1024 },
      }),
    };
    expect((await provider.extract(makeReq())).kind).toBe('truncated');

    // refusal -> refused
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        id: 'msg_r',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        stop_reason: 'refusal',
        content: [],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    };
    expect((await provider.extract(makeReq())).kind).toBe('refused');

    // 429 WITH retry-after -> transient RATE_LIMITED
    nextResponse = {
      status: 429,
      headers: { 'retry-after': '12' },
      body: JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'slow down' },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      transient: true,
      retryAfterMs: 12_000,
    });

    // 429 WITHOUT retry-after -> permanent RATE_CAPPED
    nextResponse = {
      status: 429,
      body: JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'spend cap' },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'RATE_CAPPED',
      transient: false,
    });

    // 529 overloaded -> transient OVERLOADED
    nextResponse = {
      status: 529,
      body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'OVERLOADED',
      transient: true,
    });

    // 500 with x-should-retry: false -> permanent SERVER
    nextResponse = {
      status: 500,
      headers: { 'x-should-retry': 'false' },
      body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fatal' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'SERVER',
      transient: false,
    });

    // 401 -> permanent AUTH
    nextResponse = {
      status: 401,
      body: JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'bad key' },
      }),
    };
    let err: unknown;
    try {
      await provider.extract(makeReq());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: 'AUTH', transient: false });

    // 400 -> permanent BAD_REQUEST
    nextResponse = {
      status: 400,
      body: JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'too complex' },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      transient: false,
    });

    // 429 with HTTP-date retry-after and whitespace/invalid retry-after-ms falls back cleanly
    const futureHttpDate = new Date(Date.now() + 10_000).toUTCString();
    nextResponse = {
      status: 429,
      headers: { 'retry-after-ms': '   ', 'retry-after': futureHttpDate },
      body: JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'http date retry' },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      transient: true,
    });

    // 429 with valid retry-after-ms (already suffixed or numeric) -> RATE_LIMITED
    nextResponse = {
      status: 429,
      headers: { 'retry-after-ms': '1500ms' },
      body: JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'ms retry' },
      }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      transient: true,
      retryAfterMs: 1500,
    });

    // 408 -> transient TIMEOUT; 403 -> AUTH; 404 -> MODEL_NOT_FOUND; 500 (default retryable) -> transient SERVER
    nextResponse = {
      status: 408,
      body: JSON.stringify({ type: 'error', error: { message: 'timeout' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'TIMEOUT',
      transient: true,
    });
    nextResponse = {
      status: 403,
      body: JSON.stringify({ type: 'error', error: { message: 'forbidden' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'AUTH',
      transient: false,
    });
    nextResponse = {
      status: 404,
      body: JSON.stringify({ type: 'error', error: { message: 'not found' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      transient: false,
    });
    nextResponse = {
      status: 500,
      body: JSON.stringify({ type: 'error', error: { message: 'transient' } }),
    };
    await expect(provider.extract(makeReq())).rejects.toMatchObject({
      code: 'SERVER',
      transient: true,
    });

    // end_turn without tool_use -> no_output; non-strict model omits strict: true
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        id: 'msg_no',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'no tool used' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    };
    expect((await provider.extract(makeReq({ model: 'claude-3-5-sonnet-20241022' }))).kind).toBe(
      'no_output',
    );
    const nonStrictTools = lastRequestBody?.['tools'] as Array<Record<string, unknown>>;
    expect(nonStrictTools[0]?.['strict']).toBeUndefined();
  });

  it('enforces timeout and caller AbortSignal even when response stalls mid-body after HTTP 200 headers', async () => {
    // 1. Mid-body stall hits provider timeoutMs -> transient TIMEOUT
    const fastTimeoutProvider = new AnthropicProvider({
      apiKey: 'test-key',
      baseURL: baseUrl,
      timeoutMs: 80,
    });
    nextResponse = { status: 200, body: '{}', stallBodyMs: 500 };
    await expect(fastTimeoutProvider.extract(makeReq())).rejects.toMatchObject({
      code: 'TIMEOUT',
      transient: true,
    });

    // 2. Mid-body caller abort -> permanent ABORTED (never NETWORK)
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      baseURL: baseUrl,
      timeoutMs: 5_000,
    });
    const ac = new AbortController();
    nextResponse = { status: 200, body: '{}', stallBodyMs: 500 };
    setTimeout(() => ac.abort(), 30);
    await expect(provider.extract(makeReq({ signal: ac.signal }))).rejects.toMatchObject({
      code: 'ABORTED',
      transient: false,
    });
  });
});
