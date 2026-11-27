import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from '../client.js';
import { seedDatabase, type SeedBlobStore } from '../seed.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MIGRATIONS_FOLDER = path.join(PACKAGE_ROOT, 'drizzle');
const GRANTS_SQL_PATH = path.join(PACKAGE_ROOT, 'assets', 'grants.sql');
const HINTS_PATH = path.join(PACKAGE_ROOT, 'assets', 'template-hints.json');

function getErrorNameAndStatus(err: unknown): { name?: string; statusCode?: number } {
  if (typeof err !== 'object' || err === null) {
    return {};
  }
  const rec = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return {
    name: rec.name ?? rec.Code,
    statusCode: rec.$metadata?.httpStatusCode,
  };
}

class S3SeedBlobStore implements SeedBlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  }) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (err) {
      const { name, statusCode } = getErrorNameAndStatus(err);
      if (statusCode !== 404 && name !== 'NotFound' && name !== 'NoSuchBucket') {
        throw err;
      }
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const { name } = getErrorNameAndStatus(err);
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
        return;
      }
      throw err;
    }
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/pdf',
      }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}

async function main(): Promise<void> {
  const migrateOnly = process.argv.includes('--migrate-only');
  const appEnv = process.env['APP_ENV'] ?? 'development';

  const migratorUrl =
    process.env['DATABASE_MIGRATOR_URL'] ??
    (appEnv === 'production' ? '' : 'postgresql://migrator:dev-migrator@127.0.0.1:5432/lomi');
  if (!migratorUrl) {
    throw new Error('DATABASE_MIGRATOR_URL is required in production');
  }

  const pool = createPool(migratorUrl, { max: 2 });
  const db = createDb(pool);

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const grantsSql = await readFile(GRANTS_SQL_PATH, 'utf8');
    await pool.query(grantsSql);

    if (migrateOnly) {
      console.log('Migrations and least-privilege grants applied.');
      return;
    }

    const s3Endpoint = process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:8333';
    const s3Region = process.env['S3_REGION'] ?? 'us-east-1';
    const s3Bucket = process.env['S3_BUCKET'] ?? 'documents';
    const s3AccessKey =
      process.env['S3_ACCESS_KEY'] ?? (appEnv === 'production' ? '' : 'dev-s3-key');
    const s3SecretKey =
      process.env['S3_SECRET_KEY'] ?? (appEnv === 'production' ? '' : 'dev-s3-secret');
    if (!s3AccessKey || !s3SecretKey) {
      throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY are required in production');
    }

    const fixturesDir = process.env['FIXTURES_DIR'] ?? path.join(REPO_ROOT, 'fixtures');
    const blobStore = new S3SeedBlobStore({
      endpoint: s3Endpoint,
      region: s3Region,
      bucket: s3Bucket,
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
    });

    try {
      const summary = await seedDatabase(db, blobStore, {
        fixturesDir,
        hintsPath: HINTS_PATH,
      });
      console.log(
        `Migrations, grants, and seed complete (templatesCreated=${summary.templatesCreated}, documentsCreated=${summary.documentsCreated}, blobsUploaded=${summary.blobsUploaded}).`,
      );
    } finally {
      blobStore.close();
    }
  } finally {
    await pool.end();
  }
}

await main();
