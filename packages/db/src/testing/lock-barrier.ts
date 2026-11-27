import type { Pool, PoolClient } from 'pg';

export type BarrierTable = 'documents' | 'document_versions' | 'extracted_values';

export interface RowLockBarrier {
  readonly holderPid: number;
  waitForBlockedCount(expectedCount: number, timeoutMs?: number): Promise<number[]>;
  release(): Promise<void>;
}

/**
 * Poll helper for integration, concurrency, and chaos tests (no fake timers, spec §11.3).
 */
export async function eventually<T>(
  fn: () => Promise<T> | T,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`eventually() timed out after ${timeoutMs}ms: ${String(lastError)}`);
}

/**
 * Acquires a real Postgres `FOR UPDATE` row lock on `table(id)` on a dedicated connection,
 * and proves competing transactions are parked on it via `pg_blocking_pids()` and
 * `wait_event_type = 'Lock'` (spec §11.3, Core Task 8).
 */
export async function acquireRowLockBarrier(
  pool: Pool,
  table: BarrierTable,
  rowId: string,
  observePool: Pool = pool,
): Promise<RowLockBarrier> {
  const client: PoolClient = await pool.connect();
  let released = false;

  try {
    await client.query('BEGIN');
    const pidRes = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const holderPid = pidRes.rows[0]!.pid;

    const lockSql =
      table === 'documents'
        ? 'SELECT id FROM documents WHERE id = $1 FOR UPDATE'
        : table === 'document_versions'
          ? 'SELECT id FROM document_versions WHERE id = $1 FOR UPDATE'
          : 'SELECT id FROM extracted_values WHERE id = $1 FOR UPDATE';

    const locked = await client.query(lockSql, [rowId]);
    if (locked.rowCount !== 1) {
      throw new Error(`Row ${rowId} not found in ${table} when acquiring lock barrier`);
    }

    return {
      holderPid,
      async waitForBlockedCount(expectedCount: number, timeoutMs = 5_000): Promise<number[]> {
        return eventually(
          async () => {
            const res = await observePool.query<{ pid: number }>(
              `WITH RECURSIVE blocked(pid) AS (
                 SELECT pid
                 FROM pg_stat_activity
                 WHERE datname = current_database()
                   AND wait_event_type = 'Lock'
                   AND $1 = ANY(pg_blocking_pids(pid))
                 UNION
                 SELECT a.pid
                 FROM pg_stat_activity a
                 JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
                 WHERE a.datname = current_database()
                   AND a.wait_event_type = 'Lock'
               )
               SELECT pid FROM blocked`,
              [holderPid],
            );
            const blockedPids = res.rows.map((r) => r.pid);
            if (blockedPids.length < expectedCount) {
              throw new Error(
                `Expected >= ${expectedCount} blocked queries behind pid ${holderPid}, found ${blockedPids.length}`,
              );
            }
            return blockedPids;
          },
          { timeoutMs, intervalMs: 25 },
        );
      },
      async release(): Promise<void> {
        if (released) {
          return;
        }
        released = true;
        try {
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    if (!released) {
      released = true;
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    throw err;
  }
}
