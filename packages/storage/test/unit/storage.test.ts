import { describe, expect, it } from 'vitest';
import { MemoryBlobStore, StorageError } from '../../src/index.js';

describe('MemoryBlobStore', () => {
  it('stores, reads, and heads binary payloads without aliasing internal buffers', async () => {
    const store = new MemoryBlobStore();
    await store.ensureBucket();

    const payload = Buffer.from('%PDF-1.7\nhello\n%%EOF');
    await store.putObject('pdfs/sha256/abc.pdf', payload, 'application/pdf');

    const head = await store.headObject('pdfs/sha256/abc.pdf');
    expect(head).toEqual({ contentLength: payload.byteLength, contentType: 'application/pdf' });
    expect(await store.headObject('pdfs/sha256/missing.pdf')).toBeNull();

    const fetched = await store.getObject('pdfs/sha256/abc.pdf');
    expect(fetched.equals(payload)).toBe(true);

    // Mutating returned buffer does not corrupt stored copy
    fetched[0] = 0;
    const fetchedAgain = await store.getObject('pdfs/sha256/abc.pdf');
    expect(fetchedAgain.equals(payload)).toBe(true);
  });

  it('throws StorageError NOT_FOUND on missing key and propagates injected transient errors', async () => {
    const store = new MemoryBlobStore();
    await expect(store.getObject('missing')).rejects.toMatchObject({
      name: 'StorageError',
      code: 'NOT_FOUND',
      transient: false,
    });

    store.failWith = new StorageError('STORAGE_UNAVAILABLE', 's3 down', { transient: true });
    await expect(store.getObject('missing')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      transient: true,
    });
  });
});
