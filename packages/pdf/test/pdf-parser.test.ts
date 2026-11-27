import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfParseError } from '../src/errors.js';
import { PdfParserPool } from '../src/pool.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures', 'documents');
const GOLDEN_DIR = path.join(REPO_ROOT, 'fixtures-golden');
const CRAFTED_DIR = path.join(GOLDEN_DIR, 'crafted');

const FIXTURE_STEMS = [
  'invoice-001',
  'invoice-001.v2',
  'lease-excerpt-001',
  'market-report-excerpt-001',
] as const;

describe('[I9] PdfParserPool, fixture goldens, crafted PDFs, and worker resilience', () => {
  let pool: PdfParserPool;
  const watchdogKills: Array<{ pid: number; rssBytes: number }> = [];

  beforeAll(() => {
    pool = new PdfParserPool({
      maxThreads: 1,
      watchdogPollMs: 25,
      maxRssBytes: 180 * 1024 * 1024,
      onWatchdogKill: (pid, rssBytes) => {
        watchdogKills.push({ pid, rssBytes });
      },
    });
  });

  afterAll(async () => {
    await pool?.close();
  });

  it('matches committed golden text and ranges for all 4 fixture PDFs without detaching caller bytes', async () => {
    for (const stem of FIXTURE_STEMS) {
      const pdfBytes = new Uint8Array(await readFile(path.join(FIXTURES_DIR, `${stem}.pdf`)));
      const originalLength = pdfBytes.byteLength;

      const parsed = await pool.parse(pdfBytes);

      // Caller buffer must NOT be detached by pdfjs
      expect(pdfBytes.byteLength).toBe(originalLength);

      const expectedText = await readFile(path.join(GOLDEN_DIR, 'text', `${stem}.txt`), 'utf8');
      const expectedRanges = JSON.parse(
        await readFile(path.join(GOLDEN_DIR, 'ranges', `${stem}.ranges.json`), 'utf8'),
      );

      expect(parsed.text).toBe(expectedText);
      expect(parsed.textRanges).toEqual(expectedRanges.textRanges);
      expect(parsed.pageOffsets).toEqual(expectedRanges.pageOffsets);
      expect(parsed.warnings).toEqual(expectedRanges.warnings);
      expect(parsed.pageCount).toBe(expectedRanges.pageCount);
    }
  });

  it('[I9] pdf.crafted.off-page detects off-page text as hidden (OFF_PAGE)', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'off-page.pdf')));
    const parsed = await pool.parse(bytes);
    expect(parsed.warnings).toContain('HIDDEN_TEXT_PRESENT');
    expect(parsed.textRanges.hidden.length).toBeGreaterThan(0);
    expect(parsed.textRanges.hidden[0]?.[2]).toBe('OFF_PAGE');
    const [start, end] = parsed.textRanges.hidden[0]!;
    expect(parsed.text.slice(start, end)).toContain('OFFPAGE_SECRET_INJECTION');
  });

  it('[I9] pdf.crafted.low-visibility detects 1pt text in textRanges.lowVisibility', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'low-visibility.pdf')));
    const parsed = await pool.parse(bytes);
    expect(parsed.textRanges.lowVisibility.length).toBeGreaterThan(0);
    const [start, end] = parsed.textRanges.lowVisibility[0]!;
    expect(parsed.text.slice(start, end)).toContain('TINY_ONE_PT_TEXT');
  });

  it('[I9] pdf.crafted.encrypted rejects password-protected PDF with PARSE_ENCRYPTED', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'encrypted.pdf')));
    await expect(pool.parse(bytes)).rejects.toMatchObject({
      name: 'PdfParseError',
      code: 'PARSE_ENCRYPTED',
    });
  });

  it('[I9] pdf.crafted.malformed rejects corrupt PDF with PARSE_MALFORMED', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'malformed.pdf')));
    await expect(pool.parse(bytes)).rejects.toMatchObject({
      name: 'PdfParseError',
      code: 'PARSE_MALFORMED',
    });
  });

  it('[I9] pdf.crafted.too-many-pages rejects 250-page PDF with PARSE_LIMIT_EXCEEDED', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'too-many-pages.pdf')));
    await expect(pool.parse(bytes)).rejects.toMatchObject({
      name: 'PdfParseError',
      code: 'PARSE_LIMIT_EXCEEDED',
    });
  });

  it('[I9] pdf.crafted.no-text rejects blank PDF with PARSE_NO_TEXT', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'no-text.pdf')));
    await expect(pool.parse(bytes)).rejects.toMatchObject({
      name: 'PdfParseError',
      code: 'PARSE_NO_TEXT',
    });
  });

  it('[I9] pdf.crafted.rotated-and-columns flags ROTATED_TEXT and MULTI_COLUMN warnings', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'rotated-and-columns.pdf')));
    const parsed = await pool.parse(bytes);
    expect(parsed.warnings).toContain('ROTATED_TEXT');
    expect(parsed.warnings).toContain('MULTI_COLUMN');
    expect(parsed.text).toContain('ROTATED_DRAFT_STAMP');
  });

  it('[I9] pdf.crafted.flate-bomb triggers RSS watchdog and fails with PARSE_LIMIT_EXCEEDED', async () => {
    const killsBefore = watchdogKills.length;
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'flate-bomb.pdf')));
    await expect(pool.parse(bytes)).rejects.toMatchObject({
      name: 'PdfParseError',
      code: 'PARSE_LIMIT_EXCEEDED',
    });
    expect(watchdogKills.length).toBeGreaterThan(killsBefore);
  }, 15_000);

  it('[I9] pdf.crafted.timeout aborts hung parse with PARSE_TIMEOUT', async () => {
    const bytes = new Uint8Array(await readFile(path.join(CRAFTED_DIR, 'too-many-pages.pdf')));
    await expect(pool.parse(bytes, { maxPages: 1000, timeoutMs: 2 })).rejects.toMatchObject({
      name: 'PdfParseError',
      code: 'PARSE_TIMEOUT',
    });
  }, 15_000);

  it('[I9] pdf.child-killed-worker-survives recovers cleanly after crashes, watchdog kills, and timeouts', async () => {
    const bytes = new Uint8Array(await readFile(path.join(FIXTURES_DIR, 'invoice-001.pdf')));
    const parsed = await pool.parse(bytes);
    expect(parsed.text).toContain('MERIDIAN OFFICE SUPPLIES LLC');
    expect(parsed.pageCount).toBe(1);

    // Verify PdfParseError instance check
    const bad = new Uint8Array(Buffer.from('%PDF-1.7\ncorrupt', 'utf8'));
    let err: unknown;
    try {
      await pool.parse(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PdfParseError);
    expect((err as PdfParseError).code).toBe('PARSE_MALFORMED');
  });

  it('scripts/golden-update.ts refuses to run when CI is set', async () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'golden-update.ts');
    let failed = false;
    let stderr = '';
    try {
      await execFileAsync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, CI: 'true' },
      });
    } catch (err) {
      failed = true;
      stderr = (err as { stderr?: string }).stderr ?? '';
    }
    expect(failed).toBe(true);
    expect(stderr).toMatch(/refus|CI/i);
  });
});
