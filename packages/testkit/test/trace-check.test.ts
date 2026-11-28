import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TRACE_CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'trace-check.ts');
const MATRIX_PATH = path.join(REPO_ROOT, 'docs', 'reference', 'traceability.md');

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-check-test-'));
  tempDirs.push(dir);
  return dir;
}

async function runTraceCheck(
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const res = await execFileAsync(process.execPath, [TRACE_CHECK_SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('scripts/trace-check.ts CLI', () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes when all Core IDs in docs/reference/traceability.md have passing JUnit testcases and writes GITHUB_STEP_SUMMARY', async () => {
    const dir = await makeTempDir();
    const matrixMd = await readFile(MATRIX_PATH, 'utf8');
    const coreIds = matrixMd
      .split(/\r?\n/)
      .map((line) => /^\|\s*((?:R|I)\d+)\s*\|\s*([^|]+)\|/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null && !/\*\*\(Extended\b/i.test(m[2]!))
      .map((m) => m[1]!);

    expect(coreIds.length).toBe(22);

    const xml = `<testsuites><testsuite name="core">${coreIds
      .map((id) => `<testcase classname="suite" name="[${id}] passes cleanly" />`)
      .join('')}</testsuite></testsuites>`;
    await writeFile(path.join(dir, 'junit.xml'), xml, 'utf8');
    const summaryFile = path.join(dir, 'summary.md');

    const res = await runTraceCheck(['--junit', dir], { GITHUB_STEP_SUMMARY: summaryFile });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('| R1 | Core | PASS | 1 | 0 | 0 |');
    expect(res.stdout).toContain('| I2 | Extended | EXTENDED | 0 | 0 | 0 |');
    expect(res.stdout).toContain('| I12 | Core | PASS | 1 | 0 | 0 |');

    const writtenSummary = await readFile(summaryFile, 'utf8');
    expect(writtenSummary).toContain('## Traceability Check');
  });

  it('fails on missing Core ID, failing matrix test, or skipped (quarantined) matrix test', async () => {
    const dir = await makeTempDir();
    const customMatrix = [
      '| ID | Requirement or invariant | Tests | Tier |',
      '|---|---|---|---|',
      '| R1 | Upload | t1 | int |',
      '| R2 | Restart | t2 | chaos |',
      '| R3 | FLUSHALL | t3 | chaos |',
    ].join('\n');
    const matrixFile = path.join(dir, 'matrix.md');
    await writeFile(matrixFile, customMatrix, 'utf8');

    const xml = `<testsuite name="s">
      <testcase classname="c" name="[R1] ok" />
      <testcase classname="c" name="[R1] quarantined"><skipped /></testcase>
      <testcase classname="c" name="[R2] fails"><failure message="boom">stack</failure></testcase>
    </testsuite>`;
    await writeFile(path.join(dir, 'results.xml'), xml, 'utf8');

    const res = await runTraceCheck(['--matrix', matrixFile, '--junit', dir]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('| R1 | Core | FAIL | 1 | 0 | 1 |');
    expect(res.stdout).toContain('| R2 | Core | FAIL | 0 | 1 | 0 |');
    expect(res.stdout).toContain('| R3 | Core | MISSING | 0 | 0 | 0 |');
  });

  it('fails when zero JUnit XML files exist in the target directory', async () => {
    const dir = await makeTempDir();
    const res = await runTraceCheck(['--junit', dir]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/no xml files/i);
  });

  it('ignores <failure>/<error>/<skipped>/</testcase> inside CDATA, <system-out>, <system-err>, and <flakyFailure>', async () => {
    const dir = await makeTempDir();
    const customMatrix = [
      '| ID | Requirement or invariant | Tests | Tier |',
      '|---|---|---|---|',
      '| R1 | Upload | t1 | e2e |',
      '| R2 | Restart | t2 | e2e |',
    ].join('\n');
    const matrixFile = path.join(dir, 'matrix.md');
    await writeFile(matrixFile, customMatrix, 'utf8');

    const xml = `<testsuite name="pw">
      <testcase classname="e2e" data-name="ignored" name="[R1] passes with XML in stdout">
        <system-out><![CDATA[Rendered <failure>fake</failure><skipped /></testcase>]]></system-out>
        <system-err><![CDATA[<error message="not a real error" />]]></system-err>
      </testcase>
      <testcase classname="e2e" name="[R2] passes after retry">
        <flakyFailure message="transient"><stackTrace><![CDATA[<failure/>]]></stackTrace></flakyFailure>
      </testcase>
    </testsuite>`;
    await writeFile(path.join(dir, 'pw.xml'), xml, 'utf8');

    const res = await runTraceCheck(['--matrix', matrixFile, '--junit', dir]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('| R1 | Core | PASS | 1 | 0 | 0 |');
    expect(res.stdout).toContain('| R2 | Core | PASS | 1 | 0 | 0 |');
  });

  it('fails fast on missing explicit --junit path or unknown CLI flag', async () => {
    const dir = await makeTempDir();
    const customMatrix = [
      '| ID | Requirement or invariant | Tests | Tier |',
      '|---|---|---|---|',
      '| R1 | Upload | t1 | e2e |',
    ].join('\n');
    const matrixFile = path.join(dir, 'matrix.md');
    await writeFile(matrixFile, customMatrix, 'utf8');
    await writeFile(
      path.join(dir, 'ok.xml'),
      '<testsuite><testcase classname="s" name="[R1] ok" /></testsuite>',
      'utf8',
    );

    const missingRes = await runTraceCheck([
      '--matrix',
      matrixFile,
      '--junit',
      path.join(dir, 'ok.xml'),
      '--junit',
      path.join(dir, 'does-not-exist.xml'),
    ]);
    expect(missingRes.code).toBe(1);
    expect(missingRes.stderr).toMatch(/does-not-exist\.xml/i);

    const unknownRes = await runTraceCheck(['--bogus']);
    expect(unknownRes.code).toBe(1);
    expect(unknownRes.stderr).toMatch(/unknown argument/i);
  });
});
