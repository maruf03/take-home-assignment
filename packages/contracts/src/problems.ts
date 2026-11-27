import { z } from 'zod';

export const PROBLEM_CODES = [
  // 400
  'VALIDATION_FAILED',
  'INVALID_ID',
  'INVALID_CURSOR',
  'CURSOR_MISMATCH',
  'INVALID_LIMIT',
  'INVALID_SORT',
  'INVALID_FILTER',
  // 404
  'DOCUMENT_NOT_FOUND',
  'VERSION_NOT_FOUND',
  'VALUE_NOT_FOUND',
  'RUN_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  // 409
  'VERSION_NOT_REVIEWABLE',
  'REVIEW_CONFLICT',
  'NOTHING_TO_REVERT',
  'NOT_RETRYABLE',
  'VERSION_NOT_TERMINAL',
  'TEXT_NOT_AVAILABLE',
  'IDEMPOTENCY_KEY_IN_USE',
  // 410
  'DOCUMENT_DELETED',
  // 413
  'FILE_TOO_LARGE',
  // 415
  'UNSUPPORTED_MEDIA_TYPE',
  // 422
  'UNKNOWN_DOCUMENT_TYPE',
  'NO_TEMPLATE_FOR_TYPE',
  'INVALID_CORRECTION',
  'IDEMPOTENCY_KEY_REUSED',
  // 429
  'RATE_LIMITED',
  // 500
  'INTERNAL',
  // 503
  'STORAGE_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];
export const problemCodeSchema = z.enum(PROBLEM_CODES);

export const PROBLEM_STATUS: Readonly<Record<ProblemCode, number>> = Object.freeze({
  VALIDATION_FAILED: 400,
  INVALID_ID: 400,
  INVALID_CURSOR: 400,
  CURSOR_MISMATCH: 400,
  INVALID_LIMIT: 400,
  INVALID_SORT: 400,
  INVALID_FILTER: 400,
  DOCUMENT_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  VALUE_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  VERSION_NOT_REVIEWABLE: 409,
  REVIEW_CONFLICT: 409,
  NOTHING_TO_REVERT: 409,
  NOT_RETRYABLE: 409,
  VERSION_NOT_TERMINAL: 409,
  TEXT_NOT_AVAILABLE: 409,
  IDEMPOTENCY_KEY_IN_USE: 409,
  DOCUMENT_DELETED: 410,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNKNOWN_DOCUMENT_TYPE: 422,
  NO_TEMPLATE_FOR_TYPE: 422,
  INVALID_CORRECTION: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  STORAGE_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
});

export const problemFieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;

export const problemDetailsSchema = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: problemCodeSchema,
  detail: z.string(),
  instance: z.string().optional(),
  requestId: z.string(),
  errors: z.array(problemFieldErrorSchema).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const VERSION_ERROR_CODES = [
  // Parsing
  'PARSE_ENCRYPTED',
  'PARSE_MALFORMED',
  'PARSE_TIMEOUT',
  'PARSE_LIMIT_EXCEEDED',
  'PARSE_NO_TEXT',
  'PARSE_CRASHED',
  // Storage
  'STORAGE_UNAVAILABLE',
  'INTEGRITY_MISMATCH',
  // LLM
  'LLM_NOT_CONFIGURED',
  'LLM_AUTH',
  'LLM_BAD_REQUEST',
  'LLM_SCHEMA_INVALID',
  'LLM_TRUNCATED',
  'LLM_REFUSED',
  'LLM_RATE_CAPPED',
  'LLM_CALL_CAP',
  // Lifecycle
  'MAX_ATTEMPTS',
  'DOCUMENT_DELETED',
] as const;

export type VersionErrorCode = (typeof VERSION_ERROR_CODES)[number];
export const versionErrorCodeSchema = z.enum(VERSION_ERROR_CODES);

const RETRYABLE_HINT_MAP: Readonly<Record<VersionErrorCode, boolean>> = Object.freeze({
  STORAGE_UNAVAILABLE: true,
  LLM_SCHEMA_INVALID: true,
  LLM_TRUNCATED: true,
  LLM_REFUSED: true,
  LLM_CALL_CAP: true,
  MAX_ATTEMPTS: true,
  LLM_RATE_CAPPED: true,
  LLM_NOT_CONFIGURED: true,
  PARSE_TIMEOUT: true,
  PARSE_CRASHED: true,
  DOCUMENT_DELETED: true,
  PARSE_ENCRYPTED: false,
  PARSE_MALFORMED: false,
  PARSE_NO_TEXT: false,
  PARSE_LIMIT_EXCEEDED: false,
  INTEGRITY_MISMATCH: false,
  LLM_AUTH: false,
  LLM_BAD_REQUEST: false,
});

export function retryableHint(code: VersionErrorCode): boolean {
  return RETRYABLE_HINT_MAP[code];
}
