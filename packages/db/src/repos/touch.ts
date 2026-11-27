import { sql } from 'drizzle-orm';

/**
 * Sets `updated_at = now()` using Postgres's clock on every repository UPDATE (spec §4.0).
 */
export function touch() {
  return {
    updatedAt: sql<Date>`now()`,
  };
}
