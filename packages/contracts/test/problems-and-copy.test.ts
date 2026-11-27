import { describe, expect, it } from 'vitest';
import {
  PROBLEM_CODES,
  PROBLEM_STATUS,
  VERSION_ERROR_CODES,
  problemDetailsSchema,
  retryableHint,
} from '../src/problems.js';
import { CHANGE_REASONS, GAP_CODES, VALUE_FLAGS } from '../src/status.js';
import { uiCopy, type UiCopyKey } from '../src/ui-copy.js';

describe('[I8] problem codes, version error codes, and UI copy', () => {
  it('[I8] every gap code, change reason, flag, version error code, and problem code has non-empty uiCopy', () => {
    const expectedKeys: UiCopyKey[] = [
      ...GAP_CODES.map((code) => `gap.${code}` as const),
      ...CHANGE_REASONS.map((code) => `change.${code}` as const),
      ...VALUE_FLAGS.map((code) => `flag.${code}` as const),
      ...VERSION_ERROR_CODES.map((code) => `versionError.${code}` as const),
      ...PROBLEM_CODES.map((code) => `problem.${code}` as const),
    ];

    for (const key of expectedKeys) {
      expect(uiCopy[key], `missing uiCopy for ${key}`).toBeTypeOf('string');
      expect(uiCopy[key].trim().length, `empty uiCopy for ${key}`).toBeGreaterThan(0);
    }

    expect(Object.keys(uiCopy).sort()).toEqual([...expectedKeys].sort());
  });

  it('keeps EVIDENCE_HIDDEN and CONFLICTING_EVIDENCE distinct across gap.* and change.* namespaces', () => {
    expect(uiCopy['gap.EVIDENCE_HIDDEN']).toBeTruthy();
    expect(uiCopy['change.EVIDENCE_HIDDEN']).toBeTruthy();
    expect(uiCopy['gap.CONFLICTING_EVIDENCE']).toBeTruthy();
    expect(uiCopy['change.CONFLICTING_EVIDENCE']).toBeTruthy();
  });

  it('maps every VersionErrorCode to the exact spec §7.4 retryableHint boolean', () => {
    const expectedTrue = new Set([
      'STORAGE_UNAVAILABLE',
      'LLM_SCHEMA_INVALID',
      'LLM_TRUNCATED',
      'LLM_REFUSED',
      'LLM_CALL_CAP',
      'MAX_ATTEMPTS',
      'LLM_RATE_CAPPED',
      'LLM_NOT_CONFIGURED',
      'PARSE_TIMEOUT',
      'PARSE_CRASHED',
      'DOCUMENT_DELETED',
    ]);
    const expectedFalse = new Set([
      'PARSE_ENCRYPTED',
      'PARSE_MALFORMED',
      'PARSE_NO_TEXT',
      'PARSE_LIMIT_EXCEEDED',
      'INTEGRITY_MISMATCH',
      'LLM_AUTH',
      'LLM_BAD_REQUEST',
    ]);

    for (const code of VERSION_ERROR_CODES) {
      if (expectedTrue.has(code)) {
        expect(retryableHint(code), `${code} should be retryable`).toBe(true);
      } else if (expectedFalse.has(code)) {
        expect(retryableHint(code), `${code} should not be retryable`).toBe(false);
      } else {
        throw new Error(`Unexpected VersionErrorCode: ${code}`);
      }
    }
  });

  it('maps every ProblemCode to a valid HTTP status and validates RFC 9457 ProblemDetails', () => {
    for (const code of PROBLEM_CODES) {
      expect(PROBLEM_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(PROBLEM_STATUS[code]).toBeLessThan(600);
    }

    const parsed = problemDetailsSchema.parse({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'REVIEW_CONFLICT',
      detail: 'Another review was recorded first.',
      instance: '/values/01937000-0000-7000-8000-000000000001/review',
      requestId: 'req-123',
    });
    expect(parsed.code).toBe('REVIEW_CONFLICT');
  });
});
