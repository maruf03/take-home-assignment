import type { Pool } from 'pg';

/**
 * Test-only helper that moves a running version's lease into the past using Postgres clock
 * so sweep / fencing tests never sleep (spec §6, §14).
 */
export async function expireLease(pool: Pool, versionId: string): Promise<void> {
  await pool.query(
    `UPDATE document_versions
     SET lease_until = now() - interval '1 minute'
     WHERE id = $1 AND status = 'extracting'`,
    [versionId],
  );
}
