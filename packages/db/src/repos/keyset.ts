import { createHash } from 'node:crypto';
import {
  cursorPayloadSchema,
  DEFAULT_PAGE_LIMIT,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
  type CursorPayload,
  type Page,
} from '@app/contracts/page';
import { gt, lt, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DbRepoError } from '../client.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_INT4_MAX = 2_147_483_647;

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function isValidPositiveIntKey(value: string): boolean {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= PG_INT4_MAX;
}

export function fingerprintFilters(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return '';
  }
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex').slice(0, 32);
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(
  raw: string,
  expectedFingerprint: string,
  validateKey?: (key: string) => boolean,
): CursorPayload {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    throw new DbRepoError('INVALID_CURSOR', 'Cursor length out of bounds');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new DbRepoError('INVALID_CURSOR', 'Cursor is not valid base64url');
  }

  let parsedJson: unknown;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    parsedJson = JSON.parse(decoded);
  } catch {
    throw new DbRepoError('INVALID_CURSOR', 'Cursor payload is not valid JSON');
  }

  const parsed = cursorPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new DbRepoError('INVALID_CURSOR', 'Cursor payload has invalid shape');
  }

  if (parsed.data.f !== expectedFingerprint) {
    throw new DbRepoError(
      'CURSOR_MISMATCH',
      'Pagination cursor does not match the current query filters',
    );
  }

  if (validateKey && !validateKey(parsed.data.k)) {
    throw new DbRepoError('INVALID_CURSOR', 'Cursor key is invalid for this collection');
  }

  return parsed.data;
}

export interface KeysetOptions<TCol extends AnyPgColumn> {
  key: TCol;
  cursor?: string;
  limit?: number;
  direction?: 'desc' | 'asc';
  fingerprint?: string;
  parseKey?: (rawKey: string) => unknown;
  validateKey?: (rawKey: string) => boolean;
}

export interface KeysetResult {
  limit: number;
  limitPlusOne: number;
  whereClause: SQL | undefined;
  fingerprint: string;
  isPrev: boolean;
  hasCursor: boolean;
}

export function keyset<TCol extends AnyPgColumn>(options: KeysetOptions<TCol>): KeysetResult {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_PAGE_LIMIT || limit > MAX_PAGE_LIMIT) {
    throw new DbRepoError(
      'INVALID_LIMIT',
      `Limit must be an integer between ${MIN_PAGE_LIMIT} and ${MAX_PAGE_LIMIT}`,
    );
  }

  const direction = options.direction ?? 'desc';
  const fingerprint = options.fingerprint ?? '';

  if (!options.cursor) {
    return {
      limit,
      limitPlusOne: limit + 1,
      whereClause: undefined,
      fingerprint,
      isPrev: false,
      hasCursor: false,
    };
  }

  const payload = decodeCursor(options.cursor, fingerprint, options.validateKey);
  const keyValue = options.parseKey ? options.parseKey(payload.k) : payload.k;
  const isPrev = payload.d === 'prev';
  const effectiveDirection = isPrev ? (direction === 'desc' ? 'asc' : 'desc') : direction;
  const whereClause =
    effectiveDirection === 'desc' ? lt(options.key, keyValue) : gt(options.key, keyValue);

  return {
    limit,
    limitPlusOne: limit + 1,
    whereClause,
    fingerprint,
    isPrev,
    hasCursor: true,
  };
}

export function toPage<T>(
  rows: readonly T[],
  limit: number,
  keyFn: (row: T) => string,
  fingerprint = '',
  opts: { isPrev?: boolean; hasCursor?: boolean } = {},
): Page<T> {
  const isPrev = opts.isPrev ?? false;
  const hasCursor = opts.hasCursor ?? false;

  if (isPrev) {
    const hasMorePrev = rows.length > limit;
    const sliced = (hasMorePrev ? rows.slice(0, limit) : [...rows]).reverse();
    const firstRow = sliced[0];
    const lastRow = sliced.at(-1);
    const prevCursor =
      hasMorePrev && firstRow !== undefined
        ? encodeCursor({ v: 1, k: keyFn(firstRow), d: 'prev', f: fingerprint })
        : null;
    const nextCursor =
      lastRow !== undefined
        ? encodeCursor({ v: 1, k: keyFn(lastRow), d: 'next', f: fingerprint })
        : null;
    return {
      data: sliced,
      page: {
        limit,
        hasMore: nextCursor !== null,
        nextCursor,
        prevCursor,
      },
    };
  }

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : [...rows];
  const firstRow = data[0];
  const lastRow = data.at(-1);
  const nextCursor =
    hasMore && lastRow !== undefined
      ? encodeCursor({ v: 1, k: keyFn(lastRow), d: 'next', f: fingerprint })
      : null;
  const prevCursor =
    hasCursor && firstRow !== undefined
      ? encodeCursor({ v: 1, k: keyFn(firstRow), d: 'prev', f: fingerprint })
      : null;

  return {
    data,
    page: {
      limit,
      hasMore,
      nextCursor,
      prevCursor,
    },
  };
}
