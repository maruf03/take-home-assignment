import { appendFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface MatrixRequirement {
  readonly id: string;
  readonly description: string;
  readonly tier: string;
  readonly extendedOnly: boolean;
}

export type TestCaseOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

export interface ParsedTestCase {
  readonly name: string;
  readonly classname: string;
  readonly ids: readonly string[];
  readonly outcome: TestCaseOutcome;
}

export interface RequirementReportRow {
  readonly id: string;
  readonly extendedOnly: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly status: 'PASS' | 'FAIL' | 'MISSING' | 'EXTENDED';
}

export interface TraceabilityEvaluation {
  readonly ok: boolean;
  readonly rows: readonly RequirementReportRow[];
  readonly reasons: readonly string[];
}

const REQ_ID_TAG_REGEX = /\[((?:R|I)\d+)\]/g;
const MATRIX_ROW_REGEX = /^\|\s*((?:R|I)\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/;

/**
 * Parses `docs/reference/traceability.md` markdown table rows into requirement entries.
 * Rows whose requirement title carries `**(Extended` are marked `extendedOnly: true`.
 */
export function parseTraceabilityMatrix(markdown: string): MatrixRequirement[] {
  const rows: MatrixRequirement[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const match = MATRIX_ROW_REGEX.exec(rawLine.trim());
    if (!match) continue;
    const id = match[1]!.trim();
    const description = match[2]!.trim();
    const tier = match[4]!.trim();
    const extendedOnly = /\*\*\(Extended\b/i.test(description);
    rows.push({ id, description, tier, extendedOnly });
  }
  return rows;
}

/**
 * Removes XML regions that may legitimately contain arbitrary text resembling outcome tags:
 * comments, CDATA, stdout/stderr, properties, and Playwright retry bookkeeping elements.
 */
function stripNonOutcomeXml(xml: string): string {
  return xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<system-out\b[\s\S]*?<\/system-out>/g, '')
    .replace(/<system-err\b[\s\S]*?<\/system-err>/g, '')
    .replace(/<properties\b[\s\S]*?<\/properties>/g, '')
    .replace(/<flakyFailure\b[\s\S]*?<\/flakyFailure>/g, '')
    .replace(/<flakyError\b[\s\S]*?<\/flakyError>/g, '')
    .replace(/<rerunFailure\b[\s\S]*?<\/rerunFailure>/g, '')
    .replace(/<rerunError\b[\s\S]*?<\/rerunError>/g, '');
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function readAttr(attrs: string, attrName: string): string {
  const doubleRe = new RegExp(`(?<![\\w-])${attrName}\\s*=\\s*"([^"]*)"`);
  const m1 = doubleRe.exec(attrs);
  if (m1?.[1] !== undefined) return decodeXmlEntities(m1[1]);
  const singleRe = new RegExp(`(?<![\\w-])${attrName}\\s*=\\s*'([^']*)'`);
  const m2 = singleRe.exec(attrs);
  if (m2?.[1] !== undefined) return decodeXmlEntities(m2[1]);
  return '';
}

function extractIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(REQ_ID_TAG_REGEX)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/**
 * Parses JUnit XML output (Vitest & Playwright) into test cases with extracted `[R#]` / `[I#]` IDs.
 */
export function parseJunitXml(xml: string): ParsedTestCase[] {
  const results: ParsedTestCase[] = [];
  const tagRegex = /<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of stripNonOutcomeXml(xml).matchAll(tagRegex)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const name = readAttr(attrs, 'name');
    const classname = readAttr(attrs, 'classname');
    const ids = extractIds(`${classname} ${name}`);

    let outcome: TestCaseOutcome = 'passed';
    if (/<failure\b/i.test(inner)) {
      outcome = 'failed';
    } else if (/<error\b/i.test(inner)) {
      outcome = 'errored';
    } else if (/<skipped\b/i.test(inner)) {
      outcome = 'skipped';
    }

    results.push({ name, classname, ids, outcome });
  }
  return results;
}

/**
 * Evaluates traceability coverage against parsed JUnit test cases:
 * - Every required requirement must have >= 1 passing test.
 * - Matrix tests can NEVER be quarantined: any failed, errored, or skipped test tagged with a
 *   matrix ID fails the check even if another test for the same ID passed.
 */
export function evaluateTraceability(
  matrix: readonly MatrixRequirement[],
  testCases: readonly ParsedTestCase[],
  options: { readonly includeExtended?: boolean; readonly xmlFileCount?: number } = {},
): TraceabilityEvaluation {
  const includeExtended = options.includeExtended ?? false;
  const reasons: string[] = [];

  if (matrix.length === 0) {
    reasons.push('No requirement rows found in traceability matrix.');
  }
  if (options.xmlFileCount !== undefined && options.xmlFileCount === 0) {
    reasons.push('No JUnit XML files found.');
  }

  const stats = new Map<string, { passed: number; failed: number; skipped: number }>();
  for (const req of matrix) {
    stats.set(req.id, { passed: 0, failed: 0, skipped: 0 });
  }

  for (const tc of testCases) {
    for (const id of tc.ids) {
      const bucket = stats.get(id);
      if (!bucket) continue;
      if (tc.outcome === 'passed') {
        bucket.passed += 1;
      } else if (tc.outcome === 'skipped') {
        bucket.skipped += 1;
      } else {
        bucket.failed += 1;
      }
    }
  }

  const rows: RequirementReportRow[] = [];
  for (const req of matrix) {
    const bucket = stats.get(req.id)!;
    const isRequired = includeExtended || !req.extendedOnly;

    let status: RequirementReportRow['status'];
    if (!isRequired && bucket.passed === 0 && bucket.failed === 0 && bucket.skipped === 0) {
      status = 'EXTENDED';
    } else if (bucket.failed > 0 || bucket.skipped > 0) {
      status = 'FAIL';
      reasons.push(
        `Requirement ${req.id} has non-passing matrix tests (failed=${bucket.failed}, skipped=${bucket.skipped}).`,
      );
    } else if (bucket.passed === 0) {
      status = 'MISSING';
      reasons.push(`Requirement ${req.id} has zero passing tests.`);
    } else {
      status = 'PASS';
    }

    rows.push({
      id: req.id,
      extendedOnly: req.extendedOnly,
      passed: bucket.passed,
      failed: bucket.failed,
      skipped: bucket.skipped,
      status,
    });
  }

  return {
    ok: reasons.length === 0,
    rows,
    reasons,
  };
}

export function formatMarkdownSummary(evaluation: TraceabilityEvaluation): string {
  const lines = [
    '## Traceability Check',
    '',
    '| ID | Tier | Status | Passed | Failed | Skipped |',
    '|---|---|---|---:|---:|---:|',
  ];
  for (const row of evaluation.rows) {
    lines.push(
      `| ${row.id} | ${row.extendedOnly ? 'Extended' : 'Core'} | ${row.status} | ${row.passed} | ${row.failed} | ${row.skipped} |`,
    );
  }
  if (evaluation.reasons.length > 0) {
    lines.push('', '### Failures');
    for (const reason of evaluation.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function collectXmlFiles(inputPath: string): Promise<string[]> {
  let info;
  try {
    info = await stat(inputPath);
  } catch {
    return [];
  }
  if (info.isFile()) {
    return inputPath.endsWith('.xml') ? [inputPath] : [];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const entries = await readdir(inputPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => collectXmlFiles(path.join(inputPath, entry.name))),
  );
  return nested.flat();
}

async function runCli(argv: readonly string[]): Promise<number> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  let matrixPath = path.join(repoRoot, 'docs', 'reference', 'traceability.md');
  let includeExtended = false;
  const junitInputs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--matrix' || arg === '--junit') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`trace-check: missing value for ${arg}\n`);
        return 1;
      }
      if (arg === '--matrix') matrixPath = path.resolve(value);
      else junitInputs.push(path.resolve(value));
      i += 1;
    } else if (arg === '--include-extended') {
      includeExtended = true;
    } else {
      process.stderr.write(`trace-check: unknown argument "${arg}"\n`);
      return 1;
    }
  }

  const explicitJunit = junitInputs.length > 0;
  if (!explicitJunit) {
    junitInputs.push(path.join(repoRoot, 'test-results'));
  } else {
    for (const input of junitInputs) {
      const files = await collectXmlFiles(input);
      if (files.length === 0) {
        process.stderr.write(`trace-check: --junit path has no XML files: ${input}\n`);
        return 1;
      }
    }
  }

  const matrixMd = await readFile(matrixPath, 'utf8');
  const matrix = parseTraceabilityMatrix(matrixMd);

  const xmlFiles = [
    ...new Set((await Promise.all(junitInputs.map(collectXmlFiles))).flat()),
  ].sort();
  const allCases: ParsedTestCase[] = [];
  for (const file of xmlFiles) {
    const xml = await readFile(file, 'utf8');
    allCases.push(...parseJunitXml(xml));
  }

  const evaluation = evaluateTraceability(matrix, allCases, {
    includeExtended,
    xmlFileCount: xmlFiles.length,
  });

  const summary = formatMarkdownSummary(evaluation);
  process.stdout.write(summary);

  const stepSummaryPath = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummaryPath) {
    await appendFile(stepSummaryPath, summary, 'utf8');
  }

  return evaluation.ok ? 0 : 1;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `trace-check failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
