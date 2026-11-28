import {
  problemDetailsSchema,
  type ProblemCode,
  type ProblemDetails,
  type ProblemFieldError,
} from '@app/contracts/problems';
import type { z } from 'zod';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string;
  readonly errors?: ProblemFieldError[];
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(problem: ProblemDetails, retryAfterSeconds?: number) {
    super(problem.detail);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.title = problem.title;
    this.detail = problem.detail;
    this.requestId = problem.requestId;
    if (problem.errors) this.errors = problem.errors;
    if (problem.details) this.details = problem.details;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ContractMismatchError extends Error {
  readonly path: string;
  readonly issues: string;

  constructor(path: string, issues: string) {
    super(`Unexpected response from server for ${path}: ${issues}`);
    this.name = 'ContractMismatchError';
    this.path = path;
    this.issues = issues;
  }
}

function buildUrl(path: string): string {
  const normalizedBase = API_BASE.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : undefined;
}

function fallbackCodeForStatus(status: number): ProblemCode {
  switch (status) {
    case 413:
      return 'FILE_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'DATABASE_UNAVAILABLE';
    default:
      return 'INTERNAL';
  }
}

async function throwProblemError(res: Response): Promise<never> {
  const retryAfter = parseRetryAfter(res);
  const fallbackStatus = res.status >= 400 ? res.status : 500;
  const fallbackCode = fallbackCodeForStatus(res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(
      {
        type: 'about:blank',
        title: res.statusText || 'Request failed',
        status: fallbackStatus,
        code: fallbackCode,
        detail: res.statusText || 'Request failed',
        requestId: res.headers.get('x-request-id') ?? 'unknown',
      },
      retryAfter,
    );
  }
  const parsed = problemDetailsSchema.safeParse(json);
  if (parsed.success) {
    throw new ApiError(parsed.data, retryAfter);
  }
  throw new ApiError(
    {
      type: 'about:blank',
      title: res.statusText || 'Request failed',
      status: fallbackStatus,
      code: fallbackCode,
      detail: 'Unexpected error response from server',
      requestId: res.headers.get('x-request-id') ?? 'unknown',
    },
    retryAfter,
  );
}

async function parseJsonWithSchema<TSchema extends z.ZodType>(
  res: Response,
  path: string,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ContractMismatchError(path, 'Response body was not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ContractMismatchError(path, summary);
  }
  return parsed.data;
}

export function fileDownloadUrl(documentId: string, versionNumber: number): string {
  return buildUrl(`/documents/${encodeURIComponent(documentId)}/versions/${versionNumber}/file`);
}

export const api = {
  async get<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    signal?: AbortSignal,
  ): Promise<z.output<TSchema>> {
    const res = await fetch(buildUrl(path), {
      method: 'GET',
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      await throwProblemError(res);
    }
    return parseJsonWithSchema(res, path, schema);
  },

  async getText(path: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(buildUrl(path), {
      method: 'GET',
      cache: 'no-cache',
      headers: { Accept: 'text/plain' },
      signal,
    });
    if (!res.ok) {
      await throwProblemError(res);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('text/plain')) {
      throw new ContractMismatchError(
        path,
        `Expected text/plain response, got ${contentType || 'missing content-type'}`,
      );
    }
    return res.text();
  },

  async post<TSchema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: TSchema,
    signal?: AbortSignal,
  ): Promise<z.output<TSchema>> {
    const res = await fetch(buildUrl(path), {
      method: 'POST',
      cache: 'no-cache',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      await throwProblemError(res);
    }
    return parseJsonWithSchema(res, path, schema);
  },

  async postMultipart<TSchema extends z.ZodType>(
    path: string,
    formData: FormData,
    schema: TSchema,
    signal?: AbortSignal,
  ): Promise<z.output<TSchema>> {
    const res = await fetch(buildUrl(path), {
      method: 'POST',
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
      body: formData,
      signal,
    });
    if (!res.ok) {
      await throwProblemError(res);
    }
    return parseJsonWithSchema(res, path, schema);
  },
};
