import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../schema/index.js';

export type AppDb = NodePgDatabase<typeof schema>;

export interface TemplateDbHandle {
  databaseName: string;
  migratorPool: Pool;
  appPool: Pool;
  migratorDb: AppDb;
  appDb: AppDb;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface WithTemplateDbOptions {
  applyGrants?: boolean;
}

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_FOLDER = path.join(PACKAGE_ROOT, 'drizzle');
const GRANTS_SQL_PATH = path.join(PACKAGE_ROOT, 'assets', 'grants.sql');

const ALL_TABLES_TRUNCATE_SQL = `TRUNCATE TABLE
  reviews,
  extracted_values,
  llm_calls,
  extraction_runs,
  document_versions,
  documents,
  template_fields,
  extraction_templates,
  document_types
RESTART IDENTITY CASCADE`;

function buildDbUrl(baseUrl: string, dbName: string, user?: string, password?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  return url.toString();
}

function sanitizeDbIdent(raw: string): string {
  const cleaned = raw.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,60}$/.test(cleaned)) {
    throw new Error(`Invalid database identifier: "${raw}"`);
  }
  return cleaned;
}

export async function withTemplateDb(
  options: WithTemplateDbOptions = {},
): Promise<TemplateDbHandle> {
  const applyGrants = options.applyGrants ?? true;

  const baseMigratorUrl =
    process.env['DATABASE_MIGRATOR_URL'] ??
    'postgresql://migrator:dev-migrator@127.0.0.1:5432/lomi';
  const baseAppUrl = process.env['DATABASE_URL'] ?? 'postgresql://app:dev-app@127.0.0.1:5432/lomi';
  const adminPassword = process.env['POSTGRES_PASSWORD'] ?? 'dev-postgres';
  const adminUser = process.env['POSTGRES_USER'] ?? 'postgres';
  const adminUrl =
    process.env['DATABASE_ADMIN_URL'] ??
    buildDbUrl(baseMigratorUrl, 'postgres', adminUser, adminPassword);

  const workerId = process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? '1';
  const databaseName = sanitizeDbIdent(`lomi_test_w${workerId}_${process.pid}`);

  const adminPool = new Pool({ connectionString: adminUrl, max: 2 });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE "${databaseName}" OWNER migrator`);
    // Restrict schema public on the freshly created test database just like 01-roles.sh.
    const testAdminPool = new Pool({
      connectionString: buildDbUrl(adminUrl, databaseName),
      max: 1,
    });
    try {
      await testAdminPool.query(`ALTER SCHEMA public OWNER TO migrator`);
      await testAdminPool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await testAdminPool.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO migrator, app`);
      await testAdminPool.query(`GRANT USAGE, CREATE ON SCHEMA public TO migrator`);
      await testAdminPool.query(`GRANT USAGE ON SCHEMA public TO app`);
    } finally {
      await testAdminPool.end();
    }
  } finally {
    await adminPool.end();
  }

  const migratorPool = new Pool({
    connectionString: buildDbUrl(baseMigratorUrl, databaseName),
    max: 5,
  });
  const appPool = new Pool({
    connectionString: buildDbUrl(baseAppUrl, databaseName),
    max: 5,
  });

  const migratorDb = drizzle(migratorPool, { schema });
  const appDb = drizzle(appPool, { schema });

  try {
    await migrate(migratorDb, { migrationsFolder: MIGRATIONS_FOLDER });

    if (applyGrants) {
      if (!existsSync(GRANTS_SQL_PATH)) {
        throw new Error(`Missing grants SQL file at ${GRANTS_SQL_PATH}`);
      }
      const grantsSql = readFileSync(GRANTS_SQL_PATH, 'utf8');
      await migratorPool.query(grantsSql);
    }
  } catch (err) {
    await migratorPool.end();
    await appPool.end();
    const cleanupPool = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await cleanupPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await cleanupPool.end();
    }
    throw err;
  }

  return {
    databaseName,
    migratorPool,
    appPool,
    migratorDb,
    appDb,
    async reset() {
      await migratorPool.query(ALL_TABLES_TRUNCATE_SQL);
    },
    async close() {
      await appPool.end();
      await migratorPool.end();
      const cleanupPool = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await cleanupPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await cleanupPool.end();
      }
    },
  };
}
