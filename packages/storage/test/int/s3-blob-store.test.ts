import { describe, expect, it } from 'vitest';
import { S3BlobStore } from '../../src/index.js';

describe('S3BlobStore (live SeaweedFS integration)', () => {
  it('creates bucket idempotently, puts, heads, and gets binary PDF bytes', async () => {
    const store = new S3BlobStore({
      endpoint: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:8333',
      region: process.env['S3_REGION'] ?? 'us-east-1',
      bucket: process.env['S3_BUCKET'] ?? 'documents',
      accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'dev-s3-key',
      secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'dev-s3-secret',
      forcePathStyle: true,
    });

    try {
      await store.ensureBucket();
      await store.ensureBucket(); // idempotent

      const key = `pdfs/sha256/storage-int-${Date.now()}.pdf`;
      const payload = Buffer.from('%PDF-1.7\nstorage-integration-test\n%%EOF', 'utf8');

      await store.putObject(key, payload, 'application/pdf');
      const head = await store.headObject(key);
      expect(head).not.toBeNull();
      expect(head!.contentLength).toBe(payload.byteLength);

      const roundTrip = await store.getObject(key);
      expect(roundTrip.equals(payload)).toBe(true);

      expect(await store.headObject(`${key}.missing`)).toBeNull();
      await expect(store.getObject(`${key}.missing`)).rejects.toMatchObject({
        name: 'StorageError',
        code: 'NOT_FOUND',
        transient: false,
      });
    } finally {
      store.close();
    }
  });
});
