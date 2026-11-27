import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildPrompt,
  buildToolSchema,
  classifyChange,
  parseToolOutput,
  validateExtraction,
  type BaselineFieldSnapshot,
  type ExtractionTemplateSpec,
  type ValidatedFieldResult,
} from '@app/core';
import { describe, expect, it } from 'vitest';
import {
  CassetteProvider,
  createProvider,
  estimateCostUsd,
  FakeIpcLlmProvider,
  FakeLlmProvider,
  LlmError,
  resolveLimiterConfig,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GOLDEN_TEXT_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'text');
const CASSETTES_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'cassettes');

describe('[I8] createProvider security boundary, limiter config, pricing, fake & fake-ipc', () => {
  it('[I8] sec.cassette-provider-refused-outside-test refuses fake, fake-ipc, and cassette providers unless APP_ENV=test', () => {
    for (const provider of ['fake', 'fake-ipc', 'cassette'] as const) {
      for (const appEnv of ['development', 'production'] as const) {
        expect(() => createProvider({ appEnv, provider })).toThrow(LlmError);
        expect(() => createProvider({ appEnv, provider })).toThrow(/APP_ENV=test/);
      }
    }

    // Missing API keys throw permanent NOT_CONFIGURED
    expect(() =>
      createProvider({ appEnv: 'development', provider: 'gemini', geminiApiKey: '' }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED', transient: false }));
    expect(() =>
      createProvider({ appEnv: 'development', provider: 'anthropic', anthropicApiKey: '' }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED', transient: false }));

    // Allowed under APP_ENV=test
    expect(createProvider({ appEnv: 'test', provider: 'fake' }).name).toBe('fake');
    expect(
      createProvider({ appEnv: 'test', provider: 'cassette', cassettesDir: CASSETTES_DIR }).name,
    ).toBe('cassette');
  });

  it('always returns integer BullMQ limiter settings (never fractional) with fast defaults for test providers', () => {
    const geminiLim = resolveLimiterConfig('gemini');
    expect(Number.isInteger(geminiLim.max)).toBe(true);
    expect(Number.isInteger(geminiLim.duration)).toBe(true);
    expect(geminiLim).toEqual({ max: 1, duration: 12_000 });

    const fakeLim = resolveLimiterConfig('fake');
    expect(fakeLim).toEqual({ max: 100, duration: 1_000 });

    const cassetteLim = resolveLimiterConfig('cassette');
    expect(cassetteLim).toEqual({ max: 100, duration: 1_000 });

    // Fractional overrides are clamped to positive integers
    const clamped = resolveLimiterConfig('gemini', { max: 0.5, duration: 5000.9 });
    expect(clamped).toEqual({ max: 1, duration: 5000 });
  });

  it('estimates USD cost keyed on requested model with fallback to served model', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'gemini-3.5-flash',
      'gemini-3.6-flash',
    );
    expect(cost).toBeGreaterThan(0);

    const anthCost = estimateCostUsd(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 1000,
        cacheReadInputTokens: 2000,
      },
      'claude-sonnet-5-5',
    );
    expect(anthCost).toBeGreaterThan(0);
  });

  it('FakeLlmProvider and FakeIpcLlmProvider execute scripted scenarios cleanly', async () => {
    const fake = new FakeLlmProvider({
      script: [
        {
          kind: 'ok',
          output: { fields: {}, document_flags: { suspicious_instructions: false, spans: [] } },
        },
        new LlmError('RATE_LIMITED', '429 test', { transient: true, retryAfterMs: 1000 }),
      ],
    });
    const req = {
      system: 'sys',
      user: 'usr',
      schema: {},
      toolName: 'record_extraction',
      model: 'gemini-3.5-flash',
      maxOutputTokens: 512,
      cacheKey: 'k1',
    };
    expect((await fake.extract(req)).kind).toBe('ok');
    await expect(fake.extract(req)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      transient: true,
    });

    // FakeIpcLlmProvider talks to a local HTTP control server
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'result',
          result: {
            kind: 'ok',
            output: { fields: {}, document_flags: { suspicious_instructions: false, spans: [] } },
            rawText: '{}',
            raw: {},
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'STOP',
            latencyMs: 1,
            model: 'gemini-3.5-flash',
            servedModel: 'fake-ipc',
            providerRequestId: 'ipc-1',
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = server.address() as AddressInfo;
      const ipc = new FakeIpcLlmProvider({ endpoint: `http://127.0.0.1:${addr.port}` });
      const res = await ipc.extract(req);
      expect(res.kind).toBe('ok');
      expect(res.providerRequestId).toBe('ipc-1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('CassetteProvider replay through real Gemini adapter mapping', () => {
  it('replays all 4 committed Gemini cassettes through parseGeminiRawResponse and validates with @app/core', async () => {
    const expectedFields = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'fixtures', 'expected-fields.json'), 'utf8'),
    ) as Record<
      string,
      Array<{ field: string; type: 'string' | 'date' | 'money' | 'number' | 'percent' }>
    >;
    const hints = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, 'packages', 'db', 'assets', 'template-hints.json'),
        'utf8',
      ),
    ) as Record<
      string,
      {
        instructions?: string | null;
        defaultCurrency?: string;
        dateOrder?: 'MDY' | 'DMY' | 'YMD';
        fields: Record<string, { label: string; description?: string | null }>;
      }
    >;

    const fixtureCases = [
      { stem: 'invoice-001', docType: 'invoice' },
      { stem: 'invoice-001.v2', docType: 'invoice' },
      { stem: 'lease-excerpt-001', docType: 'lease' },
      { stem: 'market-report-excerpt-001', docType: 'market_report' },
    ] as const;

    const cassetteProvider = new CassetteProvider({
      cassettesDir: CASSETTES_DIR,
      recordedProvider: 'gemini',
    });

    const validatedByStem = new Map<string, ValidatedFieldResult[]>();

    for (const fc of fixtureCases) {
      const text = await readFile(path.join(GOLDEN_TEXT_DIR, `${fc.stem}.txt`), 'utf8');
      const typeHint = hints[fc.docType];
      const template: ExtractionTemplateSpec = {
        documentType: fc.docType,
        instructions: typeHint?.instructions ?? null,
        defaultCurrency: typeHint?.defaultCurrency ?? 'USD',
        dateOrder: typeHint?.dateOrder ?? 'MDY',
        fields: expectedFields[fc.docType]!.map((f, idx) => ({
          fieldKey: f.field,
          fieldType: f.type,
          position: idx + 1,
          label: typeHint?.fields[f.field]?.label ?? f.field,
          description: typeHint?.fields[f.field]?.description ?? null,
        })),
      };

      const prompt = buildPrompt(template, text, { hidden: [], lowVisibility: [] }, 'replaynonce');
      const schema = buildToolSchema(template);
      const res = await cassetteProvider.extract({
        system: prompt.system,
        user: prompt.user,
        schema,
        toolName: 'record_extraction',
        model: 'gemini-3.5-flash',
        maxOutputTokens: prompt.maxOutputTokens,
        cacheKey: fc.stem,
      });

      expect(res.kind, `cassette ${fc.stem} replay kind`).toBe('ok');
      if (res.kind !== 'ok') continue;

      const parsed = parseToolOutput(res.output, template);
      expect(parsed.ok, `cassette ${fc.stem} zod parse`).toBe(true);
      if (!parsed.ok) continue;

      const validated = validateExtraction(
        template,
        text,
        { hidden: [], lowVisibility: [] },
        parsed.data,
      );
      validatedByStem.set(fc.stem, validated);

      if (fc.docType === 'market_report') {
        expect(validated.find((v) => v.fieldKey === 'median_household_income')?.kind).toBe('gap');
        expect(validated.filter((v) => v.kind === 'value')).toHaveLength(5);
      } else {
        expect(
          validated.every((v) => v.kind === 'value'),
          `cassette ${fc.stem} all values`,
        ).toBe(true);
      }

      // Also verify nonce-independent documentFingerprint matching when cacheKey does not match stem
      const altPrompt = buildPrompt(
        template,
        text,
        { hidden: [], lowVisibility: [] },
        'differentnonce999',
      );
      const altRes = await cassetteProvider.extract({
        system: altPrompt.system,
        user: altPrompt.user,
        schema,
        toolName: 'record_extraction',
        model: 'gemini-3.5-flash',
        maxOutputTokens: altPrompt.maxOutputTokens,
        cacheKey: 'unrecognized-runtime-cache-key',
      });
      expect(altRes.kind, `cassette ${fc.stem} fingerprint match`).toBe('ok');
      expect(altRes.rawText).toBe(res.rawText);
    }

    // Verify invoice v1 -> v2 carryover on the real recorded Gemini cassettes:
    // vendor_name, invoice_number, invoice_date unchanged; due_date, total_amount changed.
    const v1 = validatedByStem.get('invoice-001')!;
    const v2 = validatedByStem.get('invoice-001.v2')!;
    const v1Text = await readFile(path.join(GOLDEN_TEXT_DIR, 'invoice-001.txt'), 'utf8');
    const v2Text = await readFile(path.join(GOLDEN_TEXT_DIR, 'invoice-001.v2.txt'), 'utf8');
    const carryoverCtx = {
      baselineParser: 'pdfjs-v1',
      nextParser: 'pdfjs-v1',
      baselineText: v1Text,
      nextText: v2Text,
      nextRanges: { hidden: [], lowVisibility: [] },
      dateOrder: 'MDY' as const,
    };

    const toBaseline = (item: ValidatedFieldResult): BaselineFieldSnapshot => ({
      id: `v1-${item.fieldKey}`,
      fieldKey: item.fieldKey,
      fieldType: item.fieldType,
      kind: item.kind,
      value: item.kind === 'value' ? item.value : null,
      canonicalEvidence: item.kind === 'value' ? item.canonicalEvidence : null,
      flags: item.flags,
    });

    for (const unchangedKey of ['vendor_name', 'invoice_number', 'issue_date'] as const) {
      const oldField = v1.find((item) => item.fieldKey === unchangedKey)!;
      const newField = v2.find((item) => item.fieldKey === unchangedKey)!;
      const classification = classifyChange(toBaseline(oldField), newField, carryoverCtx);
      expect(classification.changeKind, `carryover ${unchangedKey}`).toBe('same');
    }
    for (const changedKey of ['due_date', 'total_amount'] as const) {
      const oldField = v1.find((item) => item.fieldKey === changedKey)!;
      const newField = v2.find((item) => item.fieldKey === changedKey)!;
      const classification = classifyChange(toBaseline(oldField), newField, carryoverCtx);
      expect(classification.changeKind, `carryover ${changedKey}`).toBe('changed');
      expect(classification.changeReason, `carryover reason ${changedKey}`).toBe('VALUE_CHANGED');
    }
  });

  it('record-cassettes.ts refuses to run when CI=true', async () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'record-cassettes.ts');
    await expect(
      execFileAsync(process.execPath, [scriptPath], {
        env: { ...process.env, CI: 'true' },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });
});
