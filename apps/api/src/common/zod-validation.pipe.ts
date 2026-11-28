import type { ProblemCode, ProblemFieldError } from '@app/contracts/problems';
import { type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ProblemError } from './problem.js';

const MAX_ECHO_LENGTH = 100;

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p) => String(p)).join('.');
}

function safeMessage(message: string): string {
  return message.length > MAX_ECHO_LENGTH ? `${message.slice(0, MAX_ECHO_LENGTH)}…` : message;
}

interface IssueLike {
  readonly code: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly keys?: readonly string[];
}

function queryProblemCode(issues: readonly IssueLike[]): ProblemCode {
  const touched = new Set<string>();
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys ?? []) touched.add(key);
    } else if (issue.path.length > 0) {
      touched.add(String(issue.path[0]));
    }
  }
  if (touched.has('limit')) return 'INVALID_LIMIT';
  if (touched.has('sort')) return 'INVALID_SORT';
  if (touched.has('cursor')) return 'INVALID_CURSOR';
  return touched.size > 0 ? 'INVALID_FILTER' : 'VALIDATION_FAILED';
}

export interface ZodPipeOptions {
  /** Query strings use the pagination-specific 400 codes (INVALID_LIMIT, INVALID_FILTER, ...). */
  readonly kind?: 'body' | 'query';
}

/** Validates (and transforms) one request part with a `@app/contracts` zod schema. */
export class ZodValidationPipe<TSchema extends ZodType> implements PipeTransform {
  constructor(
    private readonly schema: TSchema,
    private readonly options: ZodPipeOptions = {},
  ) {}

  transform(value: unknown): TSchema['_output'] {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) {
      return result.data;
    }
    const issues = result.error.issues as readonly IssueLike[];
    const errors: ProblemFieldError[] = issues.map((issue) => ({
      path: formatPath(issue.path),
      message: safeMessage(issue.message),
    }));
    const code: ProblemCode =
      this.options.kind === 'query' ? queryProblemCode(issues) : 'VALIDATION_FAILED';
    throw new ProblemError(code, 'Request validation failed', { errors });
  }
}
