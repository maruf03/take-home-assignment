import { StorageError } from '@app/storage';
import { describe, expect, it } from 'vitest';
import { buildNextLink } from '../../src/common/paginated.interceptor.js';
import {
  MAX_TITLE_LENGTH,
  MAX_UPLOAD_BYTES,
  PdfFilePipe,
  sanitizeFilename,
  titleFromFilename,
} from '../../src/common/pdf-file.pipe.js';
import { buildProblemBody, mapExceptionToProblem, ProblemError } from '../../src/common/problem.js';
import { resolveRequestId } from '../../src/common/request-id.js';
import { loadApiConfig } from '../../src/config.js';

describe('API common unit tests', () => {
  it('PdfFilePipe validates presence, size, %PDF- header, and %%EOF tail', () => {
    const pipe = new PdfFilePipe();
    expect(() => pipe.transform(undefined)).toThrowError(ProblemError);

    const validBuf = Buffer.from('%PDF-1.7\nhello world\n%%EOF\n', 'latin1');
    const parsed = pipe.transform({
      buffer: validBuf,
      size: validBuf.length,
      originalname: 'invoice.pdf',
    });
    expect(parsed.sizeBytes).toBe(validBuf.length);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.originalFilename).toBe('invoice.pdf');

    // Oversized -> 413 FILE_TOO_LARGE
    try {
      pipe.transform({
        buffer: validBuf,
        size: MAX_UPLOAD_BYTES + 1,
        originalname: 'huge.pdf',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemError);
      expect((err as ProblemError).code).toBe('FILE_TOO_LARGE');
      expect((err as ProblemError).status).toBe(413);
    }

    // Wrong magic header -> 415 UNSUPPORTED_MEDIA_TYPE
    const badBuf = Buffer.from('NOT-A-PDF\n%%EOF', 'latin1');
    try {
      pipe.transform({ buffer: badBuf, size: badBuf.length, originalname: 'fake.pdf' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemError);
      expect((err as ProblemError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect((err as ProblemError).status).toBe(415);
    }

    // Missing %%EOF -> 415 UNSUPPORTED_MEDIA_TYPE
    const noEofBuf = Buffer.from('%PDF-1.7\ntruncated', 'latin1');
    try {
      pipe.transform({ buffer: noEofBuf, size: noEofBuf.length, originalname: 'trunc.pdf' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemError);
      expect((err as ProblemError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('sanitizeFilename strips paths/controls, preserves UTF-8 NFC within 255 bytes, and titleFromFilename stays <= 200 UTF-16 units on grapheme boundaries', () => {
    expect(sanitizeFilename('../../etc/\x00passwd.pdf')).toBe('passwd.pdf');
    expect(sanitizeFilename('')).toBe('document.pdf');
    expect(sanitizeFilename('résumé.pdf')).toBe('résumé.pdf');
    // NFD e + combining acute -> NFC é
    expect(sanitizeFilename('re\u0301sume\u0301.pdf')).toBe('résumé.pdf');

    const longName = `${'a'.repeat(251)}.pdf`;
    expect(longName).toHaveLength(255);
    const sanitized = sanitizeFilename(longName);
    expect(sanitized).toHaveLength(255);
    const title = titleFromFilename(sanitized);
    expect(title).toHaveLength(MAX_TITLE_LENGTH);
    expect(title).toBe('a'.repeat(200));

    // 200 multi-byte UTF-8 chars (400 bytes) must fit Postgres octet_length <= 255
    const utf8Long = sanitizeFilename(`${'é'.repeat(200)}.pdf`);
    expect(Buffer.byteLength(utf8Long, 'utf8')).toBeLessThanOrEqual(255);

    // 100 ZWJ family emoji must fit UTF-16 <= 200 without splitting a grapheme
    const emojiTitle = titleFromFilename(`${'👨‍👩‍👧‍👦'.repeat(100)}.pdf`);
    expect(emojiTitle.length).toBeLessThanOrEqual(200);
    expect(emojiTitle.length % '👨‍👩‍👧‍👦'.length).toBe(0);
  });

  it('mapExceptionToProblem distinguishes StorageError NOT_FOUND (500) vs STORAGE_UNAVAILABLE (503) and maps 415 body errors', () => {
    const missingBlob = mapExceptionToProblem(
      new StorageError('NOT_FOUND', 'missing object', { transient: false }),
    );
    expect(missingBlob.status).toBe(500);
    expect(missingBlob.code).toBe('INTERNAL');
    expect(missingBlob.unexpected).toBe(true);

    const outage = mapExceptionToProblem(
      new StorageError('STORAGE_UNAVAILABLE', 'timeout', { transient: true }),
    );
    expect(outage.status).toBe(503);
    expect(outage.code).toBe('STORAGE_UNAVAILABLE');
    expect(outage.unexpected).toBe(false);

    const badCharset = mapExceptionToProblem({ status: 415, type: 'encoding.unsupported' });
    expect(badCharset.status).toBe(415);
    expect(badCharset.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('mapExceptionToProblem never leaks stacks on 500 and emits errors[] only on 400/422', () => {
    const boom = mapExceptionToProblem(new Error('secret db detail'));
    expect(boom.status).toBe(500);
    expect(boom.code).toBe('INTERNAL');
    expect(boom.detail).toBe('Internal server error');
    expect(boom.unexpected).toBe(true);

    const conflict = buildProblemBody(
      {
        status: 409,
        code: 'REVIEW_CONFLICT',
        detail: 'stale',
        errors: [{ path: 'expectedCurrentReviewId', message: 'should be stripped on 409' }],
        unexpected: false,
      },
      '/values/1/review',
      'req-1',
    );
    expect(conflict.errors).toBeUndefined();

    const invalid = buildProblemBody(
      {
        status: 422,
        code: 'INVALID_CORRECTION',
        detail: 'bad decimal',
        errors: [{ path: 'correctedValue', message: 'bad decimal' }],
        unexpected: false,
      },
      '/values/1/review',
      'req-2',
    );
    expect(invalid.errors).toEqual([{ path: 'correctedValue', message: 'bad decimal' }]);
  });

  it('resolveRequestId validates inbound header and buildNextLink preserves existing query params', () => {
    expect(resolveRequestId('req_123.abc-9')).toBe('req_123.abc-9');
    expect(resolveRequestId('bad header with spaces!')).toMatch(/^[0-9a-f-]{36}$/i);

    const link = buildNextLink('/documents?type=invoice&limit=5', 'cur123');
    expect(link).toBe('</documents?type=invoice&limit=5&cursor=cur123>; rel="next"');
  });

  it('loadApiConfig never exposes LLM provider keys even when present in env', () => {
    const cfg = loadApiConfig({
      APP_ENV: 'test',
      GEMINI_API_KEY: 'super-secret-gemini-key',
      ANTHROPIC_API_KEY: 'super-secret-anthropic-key',
    });
    expect('GEMINI_API_KEY' in cfg).toBe(false);
    expect('ANTHROPIC_API_KEY' in cfg).toBe(false);
    expect(JSON.stringify(cfg)).not.toContain('super-secret');
  });
});
