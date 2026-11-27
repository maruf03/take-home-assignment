import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DateOrder, FieldType } from '@app/contracts/status';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
const GOLDEN_TEXT_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'text');
const CASSETTES_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'cassettes', 'gemini');
const HINTS_PATH = path.join(REPO_ROOT, 'packages', 'db', 'assets', 'template-hints.json');

const FIXTURE_CASES = [
  { stem: 'invoice-001', docType: 'invoice' },
  { stem: 'invoice-001.v2', docType: 'invoice' },
  { stem: 'lease-excerpt-001', docType: 'lease' },
  { stem: 'market-report-excerpt-001', docType: 'market_report' },
] as const;

interface ExpectedFieldSpec {
  field: string;
  type: FieldType;
}

interface TemplateHintsFile {
  [docType: string]: {
    displayName: string;
    instructions?: string | null;
    defaultCurrency?: string;
    dateOrder?: DateOrder;
    fields: Record<string, { label: string; description?: string | null }>;
  };
}

function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  const ci = env['CI']?.trim().toLowerCase();
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false';
}

async function resolveGeminiApiKey(): Promise<string> {
  const fromEnv = process.env['GEMINI_API_KEY']?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  // Check local repo .env (and main repo root if running inside a git worktree).
  for (const candidate of [
    path.join(REPO_ROOT, '.env'),
    path.resolve(REPO_ROOT, '..', '..', '.env'),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }
    const content = await readFile(candidate, 'utf8');
    const match = /^GEMINI_API_KEY=(.+)$/m.exec(content);
    const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (value) {
      return value;
    }
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (isCiEnvironment(process.env)) {
    console.error('Refusing to record cassettes in CI (CI environment variable is set).');
    process.exitCode = 1;
    return;
  }

  const apiKey = await resolveGeminiApiKey();
  if (!apiKey) {
    console.error('GEMINI_API_KEY is required to record Gemini cassettes.');
    process.exitCode = 1;
    return;
  }

  const model = process.env['LLM_MODEL']?.trim() || 'gemini-3.5-flash';

  const [
    { buildPrompt, buildToolSchema, parseToolOutput, PROMPT_VERSION, validateExtraction },
    { computeDocumentFingerprint, GeminiProvider, LlmError },
  ] = await Promise.all([
    import('../packages/core/dist/index.js'),
    import('../packages/llm/dist/index.js'),
  ]);

  const expectedFields = JSON.parse(
    await readFile(path.join(FIXTURES_DIR, 'expected-fields.json'), 'utf8'),
  ) as Record<string, ExpectedFieldSpec[]>;
  const hints = JSON.parse(await readFile(HINTS_PATH, 'utf8')) as TemplateHintsFile;

  const provider = new GeminiProvider({ apiKey });
  await mkdir(CASSETTES_DIR, { recursive: true });

  for (let i = 0; i < FIXTURE_CASES.length; i++) {
    const fc = FIXTURE_CASES[i]!;
    if (i > 0) {
      // Respect Gemini free-tier 5 RPM limit (~13s spacing).
      await sleep(13_000);
    }

    const text = await readFile(path.join(GOLDEN_TEXT_DIR, `${fc.stem}.txt`), 'utf8');
    const typeHint = hints[fc.docType];
    const template = {
      documentType: fc.docType,
      instructions: typeHint?.instructions ?? null,
      defaultCurrency: typeHint?.defaultCurrency ?? 'USD',
      dateOrder: (typeHint?.dateOrder ?? 'MDY') as DateOrder,
      fields: expectedFields[fc.docType]!.map((f, idx) => ({
        fieldKey: f.field,
        fieldType: f.type,
        position: idx + 1,
        label: typeHint?.fields[f.field]?.label ?? f.field,
        description: typeHint?.fields[f.field]?.description ?? null,
      })),
    };

    const prompt = buildPrompt(template, text, { hidden: [], lowVisibility: [] }, 'recordnonce');
    const schema = buildToolSchema(template);

    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await provider.extract({
          system: prompt.system,
          user: prompt.user,
          schema,
          toolName: 'record_extraction',
          model,
          maxOutputTokens: prompt.maxOutputTokens,
          cacheKey: fc.stem,
        });
        break;
      } catch (err) {
        if (err instanceof LlmError && err.transient && attempt < 3) {
          const waitMs = Math.min(60_000, (err.retryAfterMs ?? 15_000) + 1_000);
          console.log(`Transient ${err.code} on ${fc.stem}, retrying in ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }

    if (!result || result.kind !== 'ok') {
      throw new Error(`Recording failed for ${fc.stem}: kind=${result?.kind ?? 'none'}`);
    }

    const parsed = parseToolOutput(result.output, template);
    if (!parsed.ok) {
      throw new Error(`Recorded output failed schema validation for ${fc.stem}`);
    }
    const validated = validateExtraction(
      template,
      text,
      { hidden: [], lowVisibility: [] },
      parsed.data,
    );
    const valCount = validated.filter((v) => v.kind === 'value').length;
    const gapCount = validated.filter((v) => v.kind === 'gap').length;

    const cassette = {
      version: 1 as const,
      provider: 'gemini' as const,
      requestedModel: model,
      promptVersion: PROMPT_VERSION,
      key: fc.stem,
      documentFingerprint: computeDocumentFingerprint(prompt.user),
      recordedAt: new Date().toISOString(),
      providerRequestId: result.providerRequestId,
      rawText: result.rawText,
    };

    await writeFile(
      path.join(CASSETTES_DIR, `${fc.stem}.json`),
      `${JSON.stringify(cassette, null, 2)}\n`,
    );
    console.log(
      `Recorded ${fc.stem}.json (requested=${model}, served=${result.servedModel ?? 'n/a'}, values=${valCount}, gaps=${gapCount}, latencyMs=${result.latencyMs}).`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
