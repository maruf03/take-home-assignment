import {
  PROBLEM_STATUS,
  type ProblemCode,
  type ProblemDetails,
  type ProblemFieldError,
} from '@app/contracts/problems';
import { DbRepoError } from '@app/db';
import { StorageError } from '@app/storage';
import { HttpException } from '@nestjs/common';

export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly errors?: ProblemFieldError[];
  readonly details?: Record<string, unknown>;

  constructor(
    code: ProblemCode,
    detail: string,
    extra: { errors?: ProblemFieldError[]; details?: Record<string, unknown> } = {},
  ) {
    super(detail);
    this.name = 'ProblemError';
    this.code = code;
    this.status = PROBLEM_STATUS[code];
    if (extra.errors) this.errors = extra.errors;
    if (extra.details) this.details = extra.details;
  }
}

export interface MappedProblem {
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail: string;
  readonly errors?: ProblemFieldError[];
  readonly details?: Record<string, unknown>;
  /** True when the failure is unexpected and must be logged loudly. */
  readonly unexpected: boolean;
}

const TRANSIENT_DB_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);

function isTransientDbError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string') {
    if (TRANSIENT_DB_CODES.has(e.code)) return true;
    // 08xxx connection exceptions, 57P0x operator intervention, 53300 too_many_connections
    if (/^(08|57P0|53300)/.test(e.code)) return true;
  }
  return (
    typeof e.message === 'string' &&
    /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error/i.test(
      e.message,
    )
  );
}

const HTTP_STATUS_TO_CODE: Readonly<Record<number, ProblemCode>> = {
  400: 'VALIDATION_FAILED',
  404: 'ROUTE_NOT_FOUND',
  413: 'FILE_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

export function mapExceptionToProblem(exception: unknown): MappedProblem {
  if (exception instanceof ProblemError) {
    return {
      status: exception.status,
      code: exception.code,
      detail: exception.message,
      ...(exception.errors ? { errors: exception.errors } : {}),
      ...(exception.details ? { details: exception.details } : {}),
      unexpected: exception.code === 'INTERNAL',
    };
  }
  if (exception instanceof DbRepoError) {
    return {
      status: exception.status,
      code: exception.code,
      detail: exception.message,
      ...(exception.details ? { details: exception.details } : {}),
      unexpected: exception.code === 'INTERNAL',
    };
  }
  if (exception instanceof StorageError) {
    return {
      status: PROBLEM_STATUS.STORAGE_UNAVAILABLE,
      code: 'STORAGE_UNAVAILABLE',
      detail: 'Object storage is unavailable',
      unexpected: false,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = HTTP_STATUS_TO_CODE[status];
    if (code) {
      return {
        status: PROBLEM_STATUS[code],
        code,
        detail: code === 'ROUTE_NOT_FOUND' ? 'Route not found' : exception.message,
        unexpected: false,
      };
    }
  }
  const multerError = exception as { name?: unknown; code?: unknown } | null;
  if (
    typeof multerError === 'object' &&
    multerError !== null &&
    multerError.name === 'MulterError' &&
    typeof multerError.code === 'string'
  ) {
    if (multerError.code === 'LIMIT_FILE_SIZE') {
      return {
        status: 413,
        code: 'FILE_TOO_LARGE',
        detail: 'PDF exceeds the 10 MB upload limit',
        unexpected: false,
      };
    }
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'Invalid multipart upload',
      unexpected: false,
    };
  }
  const bodyError = exception as { status?: unknown; type?: unknown } | null;
  if (
    typeof bodyError === 'object' &&
    bodyError !== null &&
    bodyError.status === 413 &&
    typeof bodyError.type === 'string'
  ) {
    return {
      status: 413,
      code: 'FILE_TOO_LARGE',
      detail: 'Request body is too large',
      unexpected: false,
    };
  }
  if (
    typeof bodyError === 'object' &&
    bodyError !== null &&
    bodyError.status === 400 &&
    typeof bodyError.type === 'string'
  ) {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'Request body is malformed',
      unexpected: false,
    };
  }
  if (isTransientDbError(exception)) {
    return {
      status: PROBLEM_STATUS.DATABASE_UNAVAILABLE,
      code: 'DATABASE_UNAVAILABLE',
      detail: 'Database is unavailable',
      unexpected: false,
    };
  }
  // DB constraint hits (SQLSTATE 23xxx) and everything else are 500 INTERNAL, logged loudly.
  return {
    status: 500,
    code: 'INTERNAL',
    detail: 'Internal server error',
    unexpected: true,
  };
}

const TITLE_OVERRIDES: Partial<Record<ProblemCode, string>> = {
  INTERNAL: 'Internal Server Error',
};

export function problemTitle(code: ProblemCode): string {
  const override = TITLE_OVERRIDES[code];
  if (override) return override;
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function buildProblemBody(
  mapped: MappedProblem,
  instance: string,
  requestId: string,
): ProblemDetails {
  const includeErrors =
    (mapped.status === 400 || mapped.status === 422) &&
    mapped.errors !== undefined &&
    mapped.errors.length > 0;
  return {
    type: 'about:blank',
    title: problemTitle(mapped.code),
    status: mapped.status,
    code: mapped.code,
    detail: mapped.detail,
    instance,
    requestId,
    ...(includeErrors ? { errors: mapped.errors } : {}),
    ...(mapped.details ? { details: mapped.details } : {}),
  };
}
