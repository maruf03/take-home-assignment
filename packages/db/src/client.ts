import { PROBLEM_STATUS, type ProblemCode } from '@app/contracts/problems';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema/index.js';

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type DbTx = AppDatabase | AppTransaction;

export class DbRepoError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ProblemCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DbRepoError';
    this.code = code;
    this.status = PROBLEM_STATUS[code];
    this.details = details;
  }
}

export function createPool(
  connectionString: string,
  options: Omit<PoolConfig, 'connectionString'> = {},
): Pool {
  return new Pool({
    connectionString,
    max: 10,
    ...options,
  });
}

export function createDb(pool: Pool): AppDatabase {
  return drizzle(pool, { schema });
}

/**
 * Runs a write transaction at READ COMMITTED (spec §3).
 */
export async function withTx<T>(
  db: AppDatabase,
  fn: (tx: AppTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(fn, {
    isolationLevel: 'read committed',
    accessMode: 'read write',
  });
}

/**
 * Runs a multi-statement read snapshot at REPEATABLE READ READ ONLY (spec §3).
 */
export async function withReadOnlyTx<T>(
  db: AppDatabase,
  fn: (tx: AppTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(fn, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}
