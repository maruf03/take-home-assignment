import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type StorageErrorCode = 'NOT_FOUND' | 'STORAGE_UNAVAILABLE';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly transient: boolean;

  constructor(
    code: StorageErrorCode,
    message: string,
    options: { transient: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'StorageError';
    this.code = code;
    this.transient = options.transient;
  }
}

export interface BlobHeadResult {
  readonly contentLength: number;
  readonly contentType?: string;
}

export interface BlobStore {
  putObject(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  getObject(key: string, signal?: AbortSignal): Promise<Buffer>;
  headObject(key: string): Promise<BlobHeadResult | null>;
  ensureBucket(): Promise<void>;
  ping(): Promise<void>;
  close?(): void;
}

export interface S3BlobStoreConfig {
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
}

function isNotFoundS3Error(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.$metadata?.httpStatusCode === 404 ||
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.name === 'NoSuchBucket' ||
    e.Code === 'NoSuchKey' ||
    e.Code === 'NotFound' ||
    e.Code === 'NoSuchBucket'
  );
}

function isBucketAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.$metadata?.httpStatusCode === 409 ||
    e.name === 'BucketAlreadyOwnedByYou' ||
    e.name === 'BucketAlreadyExists' ||
    e.Code === 'BucketAlreadyOwnedByYou' ||
    e.Code === 'BucketAlreadyExists'
  );
}

/**
 * S3-compatible BlobStore over `@aws-sdk/client-s3` (SeaweedFS, AWS Emulator, real S3).
 * Follows spec §10.2: `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`,
 * `responseChecksumValidation: 'WHEN_REQUIRED'`.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3BlobStoreConfig) {
    this.bucket = config.bucket;
    const hasExplicitCreds =
      Boolean(config.accessKeyId?.trim()) && Boolean(config.secretAccessKey?.trim());
    this.client = new S3Client({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region,
      forcePathStyle: config.forcePathStyle ?? true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(hasExplicitCreds
        ? {
            credentials: {
              accessKeyId: config.accessKeyId!,
              secretAccessKey: config.secretAccessKey!,
            },
          }
        : {}),
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (err) {
      if (!isNotFoundS3Error(err)) {
        throw new StorageError(
          'STORAGE_UNAVAILABLE',
          `Failed to check S3 bucket "${this.bucket}": ${err instanceof Error ? err.message : String(err)}`,
          { transient: true, cause: err },
        );
      }
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (isBucketAlreadyExistsError(err)) {
        return;
      }
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        `Failed to create S3 bucket "${this.bucket}": ${err instanceof Error ? err.message : String(err)}`,
        { transient: true, cause: err },
      );
    }
  }

  async putObject(key: string, body: Uint8Array, contentType = 'application/pdf'): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        `S3 PutObject failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        { transient: true, cause: err },
      );
    }
  }

  async getObject(key: string, signal?: AbortSignal): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        signal ? { abortSignal: signal } : undefined,
      );
      if (!response.Body) {
        throw new StorageError(
          'STORAGE_UNAVAILABLE',
          `S3 GetObject returned empty body for "${key}"`,
          {
            transient: true,
          },
        );
      }
      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (err instanceof StorageError) {
        throw err;
      }
      if (isNotFoundS3Error(err)) {
        throw new StorageError('NOT_FOUND', `Object not found at "${key}"`, {
          transient: false,
          cause: err,
        });
      }
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        `S3 GetObject failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        { transient: true, cause: err },
      );
    }
  }

  async headObject(key: string): Promise<BlobHeadResult | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: response.ContentLength ?? 0,
        contentType: response.ContentType,
      };
    } catch (err) {
      if (isNotFoundS3Error(err)) {
        return null;
      }
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        `S3 HeadObject failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        { transient: true, cause: err },
      );
    }
  }

  async ping(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      throw new StorageError(
        'STORAGE_UNAVAILABLE',
        `S3 health check failed for bucket "${this.bucket}": ${err instanceof Error ? err.message : String(err)}`,
        { transient: true, cause: err },
      );
    }
  }

  close(): void {
    this.client.destroy();
  }
}

/**
 * In-memory BlobStore for unit and fast integration tests.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, { data: Buffer; contentType?: string }>();
  failWith: StorageError | null = null;

  async ensureBucket(): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
  }

  async ping(): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
  }

  async putObject(key: string, body: Uint8Array, contentType = 'application/pdf'): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.objects.set(key, { data: Buffer.from(body), contentType });
  }

  async getObject(key: string, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) {
      throw new StorageError('STORAGE_UNAVAILABLE', 'Storage read aborted', { transient: true });
    }
    if (this.failWith) {
      throw this.failWith;
    }
    const entry = this.objects.get(key);
    if (!entry) {
      throw new StorageError('NOT_FOUND', `Object not found at "${key}"`, { transient: false });
    }
    return Buffer.from(entry.data);
  }

  async headObject(key: string): Promise<BlobHeadResult | null> {
    if (this.failWith) {
      throw this.failWith;
    }
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }
    return { contentLength: entry.data.byteLength, contentType: entry.contentType };
  }

  clear(): void {
    this.objects.clear();
  }
}
