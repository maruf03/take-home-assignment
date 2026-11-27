import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAnthropicRawResponse } from './anthropic.js';
import { LlmError } from './errors.js';
import { parseGeminiRawResponse } from './gemini.js';
import { estimateCostUsd } from './pricing.js';
import type {
  ExtractionRequest,
  ExtractionResult,
  LlmCapabilities,
  LlmProvider,
  LlmUsage,
} from './provider.js';

export type RecordedProviderName = 'gemini' | 'anthropic';

export interface CassetteRecord {
  readonly version: 1;
  readonly provider: RecordedProviderName;
  readonly requestedModel: string;
  readonly promptVersion: string;
  readonly key: string;
  readonly documentFingerprint: string;
  readonly recordedAt: string;
  readonly providerRequestId: string | null;
  readonly rawText: string;
}

export interface CassetteProviderOptions {
  readonly cassettesDir: string;
  readonly recordedProvider?: RecordedProviderName;
  readonly expectedPromptVersion?: string;
}

/**
 * Strips the random `<document-{nonce} ...>` / `</document-{nonce}>` wrapper so cassette matching
 * works deterministically across prompt runs with fresh nonces.
 */
export function computeDocumentFingerprint(userPrompt: string): string {
  const normalized = userPrompt
    .replace(/<document-[a-z0-9_-]+([^>]*)>/gi, '<document$1>')
    .replace(/<\/document-[a-z0-9_-]+>/gi, '</document>');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Deterministic cassette key keyed on the **requested** model (never `served_model`, spec §15.5).
 */
export function computeCassetteKey(input: {
  provider: RecordedProviderName;
  requestedModel: string;
  cacheKey: string;
}): string {
  return createHash('sha256')
    .update(`${input.provider}:${input.requestedModel}:${input.cacheKey}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

/**
 * Replays recorded provider raw HTTP bodies through the real provider adapter's parse/mapping
 * function (APP_ENV=test only, spec §5.3 & Core Task 6).
 */
export class CassetteProvider implements LlmProvider {
  readonly name = 'cassette';
  readonly capabilities: LlmCapabilities = Object.freeze({
    constrainedSchema: true,
    promptCaching: false,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
  });

  private readonly cassettesDir: string;
  private readonly recordedProvider: RecordedProviderName;
  private readonly expectedPromptVersion?: string;
  private indexPromise: Promise<Map<string, CassetteRecord>> | null = null;

  constructor(options: CassetteProviderOptions) {
    this.cassettesDir = options.cassettesDir;
    this.recordedProvider = options.recordedProvider ?? 'gemini';
    this.expectedPromptVersion = options.expectedPromptVersion;
  }

  estimateCostUsd(usage: LlmUsage, model: string, servedModel?: string | null): number {
    return estimateCostUsd(usage, model, servedModel);
  }

  private async loadIndex(): Promise<Map<string, CassetteRecord>> {
    if (this.indexPromise) {
      return this.indexPromise;
    }
    const pending = (async () => {
      const dir = path.join(this.cassettesDir, this.recordedProvider);
      const index = new Map<string, CassetteRecord>();
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        throw new LlmError(
          'BAD_REQUEST',
          `Cassette directory not readable at "${dir}": ${err instanceof Error ? err.message : String(err)}`,
          { transient: false, cause: err },
        );
      }

      for (const file of entries.sort()) {
        if (!file.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(dir, file);
        let record: CassetteRecord;
        try {
          const raw = await readFile(filePath, 'utf8');
          record = JSON.parse(raw) as CassetteRecord;
        } catch (err) {
          throw new LlmError(
            'BAD_REQUEST',
            `Invalid cassette JSON at "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
            { transient: false, cause: err },
          );
        }
        const stem = file.slice(0, -'.json'.length);
        const modelScope = record.requestedModel;
        index.set(`stem:${modelScope}:${stem}`, record);
        index.set(`key:${modelScope}:${record.key}`, record);
        if (record.documentFingerprint) {
          index.set(`doc:${modelScope}:${record.documentFingerprint}`, record);
        }
      }

      return index;
    })();
    this.indexPromise = pending;
    try {
      return await pending;
    } catch (err) {
      this.indexPromise = null;
      throw err;
    }
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const startMs = Date.now();
    if (req.signal?.aborted) {
      throw new LlmError('ABORTED', 'Cassette replay aborted', { transient: false });
    }

    const index = await this.loadIndex();
    if (req.signal?.aborted) {
      throw new LlmError('ABORTED', 'Cassette replay aborted', { transient: false });
    }

    const docFp = computeDocumentFingerprint(req.user);
    const computedKey = computeCassetteKey({
      provider: this.recordedProvider,
      requestedModel: req.model,
      cacheKey: req.cacheKey,
    });

    const record =
      index.get(`key:${req.model}:${req.cacheKey}`) ??
      index.get(`key:${req.model}:${computedKey}`) ??
      index.get(`stem:${req.model}:${req.cacheKey}`) ??
      index.get(`doc:${req.model}:${docFp}`);

    if (!record) {
      throw new LlmError(
        'BAD_REQUEST',
        `No recorded ${this.recordedProvider} cassette matched cacheKey="${req.cacheKey}" for model="${req.model}"`,
        { transient: false },
      );
    }

    const expectedVersion = req.promptVersion ?? this.expectedPromptVersion;
    if (expectedVersion && record.promptVersion !== expectedVersion) {
      throw new LlmError(
        'BAD_REQUEST',
        `Cassette "${record.key}" promptVersion="${record.promptVersion}" does not match expected "${expectedVersion}"`,
        { transient: false },
      );
    }

    const latencyMs = Date.now() - startMs;
    if (record.provider === 'anthropic') {
      return parseAnthropicRawResponse(
        record.rawText,
        record.providerRequestId,
        req.model,
        req.toolName,
        latencyMs,
      );
    }
    return parseGeminiRawResponse(record.rawText, req.model, latencyMs);
  }
}
