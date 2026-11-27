import type { VersionErrorCode } from '@app/contracts/problems';

export const PDF_PARSE_ERROR_CODES = [
  'PARSE_ENCRYPTED',
  'PARSE_MALFORMED',
  'PARSE_TIMEOUT',
  'PARSE_LIMIT_EXCEEDED',
  'PARSE_NO_TEXT',
  'PARSE_CRASHED',
] as const;

export type PdfParseErrorCode = (typeof PDF_PARSE_ERROR_CODES)[number] & VersionErrorCode;

const PDF_PARSE_ERROR_CODE_SET: ReadonlySet<string> = new Set(PDF_PARSE_ERROR_CODES);

export function isPdfParseErrorCode(value: unknown): value is PdfParseErrorCode {
  return typeof value === 'string' && PDF_PARSE_ERROR_CODE_SET.has(value);
}

export class PdfParseError extends Error {
  readonly code: PdfParseErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PdfParseErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PdfParseError';
    this.code = code;
    this.details = details;
  }
}

export function classifyChildError(err: unknown, overrideCode?: PdfParseErrorCode): PdfParseError {
  if (overrideCode) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: unknown }).message)
          : `PDF parsing failed (${overrideCode})`;
    return new PdfParseError(overrideCode, msg);
  }

  if (err instanceof PdfParseError) {
    return err;
  }

  const record =
    typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
  const code = record?.['code'];
  const name = typeof record?.['name'] === 'string' ? record['name'] : '';
  const message =
    typeof record?.['message'] === 'string'
      ? record['message']
      : err instanceof Error
        ? err.message
        : String(err);
  const details =
    typeof record?.['details'] === 'object' && record['details'] !== null
      ? (record['details'] as Record<string, unknown>)
      : undefined;

  if (isPdfParseErrorCode(code)) {
    return new PdfParseError(code, message, details);
  }

  if (name === 'PasswordException' || /password/i.test(message)) {
    return new PdfParseError('PARSE_ENCRYPTED', 'PDF is password-protected or encrypted');
  }

  if (
    name === 'InvalidPDFException' ||
    name === 'FormatError' ||
    name === 'MissingPDFException' ||
    name === 'UnexpectedResponseException' ||
    /invalid pdf|bad xref|corrupt|stream must have data|not a pdf|formaterror|no pdf header/i.test(
      message,
    )
  ) {
    return new PdfParseError('PARSE_MALFORMED', message || 'PDF file is malformed or corrupted');
  }

  if (name === 'AbortError') {
    return new PdfParseError('PARSE_TIMEOUT', 'PDF parsing timed out');
  }

  return new PdfParseError('PARSE_CRASHED', message || 'PDF parser child process crashed');
}
