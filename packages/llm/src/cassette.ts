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
  private indexPromise: Promise<Map<string, CassetteRecord>> | null = null;

  constructor(options: CassetteProviderOptions) {
    this.cassettesDir = options.cassettesDir;
    this.recordedProvider = options.recordedProvider ?? 'gemini';
  }

  estimateCostUsd(usage: LlmUsage, model: string, servedModel?: string | null): number {
    return estimateCostUsd(usage, model, servedModel);
  }

  private async loadIndex(): Promise<Map<string, CassetteRecord>> {
    if (this.indexPromise) {
      return this.indexPromise;
    }
    this.indexPromise = (async () => {
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
        const raw = await readFile(path.join(dir, file), 'utf8');
        const record = JSON.parse(raw) as CassetteRecord;
        const stem = file.slice(0, -'.json'.length);
        index.set(`stem:${stem}`, record);
        index.set(`key:${record.key}`, record);
        if (record.documentFingerprint) {
          index.set(`doc:${record.requestedModel}:${record.documentFingerprint}`, record);
          index.set(`doc-any:${record.documentFingerprint}`, record);
        }
      }

      return index;
    })();
    return this.indexPromise;
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const startMs = Date.now();
    if (req.signal?.aborted) {
      throw new LlmError('ABORTED', 'Cassette replay aborted', { transient: false });
    }

    const index = await this.loadIndex();
    const docFp = computeDocumentFingerprint(req.user);
    const computedKey = computeCassetteKey({
      provider: this.recordedProvider,
      requestedModel: req.model,
      cacheKey: req.cacheKey,
    });

    const record =
      index.get(`key:${req.cacheKey}`) ??
      index.get(`key:${computedKey}`) ??
      index.get(`stem:${req.cacheKey}`) ??
      index.get(`doc:${req.model}:${docFp}`) ??
      index.get(`doc-any:${docFp}`);

    if (!record) {
      throw new LlmError(
        'BAD_REQUEST',
        `No recorded ${this.recordedProvider} cassette matched cacheKey="${req.cacheKey}" for model="${req.model}"`,
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
