import type {
  CreateVersionResponseDto,
  ListValuesQuery,
  ListVersionsQuery,
  ValueViewDto,
  VersionDetailDto,
  VersionSummaryDto,
} from '@app/contracts/dto';
import type { Page } from '@app/contracts/page';
import {
  computeVersionProgress,
  createNewVersion,
  createReextractVersion,
  decodeCursor,
  fingerprintFilters,
  getAliveDocumentOrThrow,
  getVersionsWithTemplateVersion,
  getVersionWithTemplateVersionByNumber,
  isValidPositiveIntKey,
  listVersions,
  loadDocumentContext,
  retryVersion,
  toPage,
  withReadOnlyTx,
  withTx,
} from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import type { PdfUpload } from '../common/pdf-file.pipe.js';
import { API_DEPS, type ApiDeps } from '../deps.js';
import { storageKeyFor } from '../documents/documents.service.js';
import { ApiMetricsService } from '../observability/metrics.service.js';
import { toDocumentSummary, toVersionSummary } from '../views/presenters.js';
import { ViewService } from '../views/view.service.js';

export interface VersionBytes {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly filename: string;
}

@Injectable()
export class VersionsService {
  constructor(
    @Inject(API_DEPS) private readonly deps: ApiDeps,
    @Inject(ViewService) private readonly views: ViewService,
    @Inject(ApiMetricsService) private readonly metrics: ApiMetricsService,
  ) {}

  async create(
    documentId: string,
    upload: PdfUpload,
    requestId: string,
  ): Promise<{ status: 200 | 201; body: CreateVersionResponseDto; versionNumber: number }> {
    // 404/410 before any S3 write.
    await getAliveDocumentOrThrow(this.deps.db, documentId);
    const storageKey = storageKeyFor(upload.sha256);
    await this.deps.blobStore.putObject(storageKey, upload.buffer, 'application/pdf');

    const committed = await withTx(this.deps.db, async (tx) => {
      const result = await createNewVersion(tx, documentId, {
        storageKey,
        fileSha256: upload.sha256,
        fileSizeBytes: upload.sizeBytes,
        originalFilename: upload.originalFilename,
        requestId,
      });
      const ctx = await loadDocumentContext(tx, documentId);
      const versionRow = (await getVersionsWithTemplateVersion(tx, [result.version.id])).get(
        result.version.id,
      )!;
      const body: CreateVersionResponseDto = {
        document: toDocumentSummary(ctx, ctx.progress),
        version: toVersionSummary(versionRow, ctx.document),
        ...(result.deduplicated ? { deduplicated: true } : {}),
      };
      return {
        versionId: result.version.id,
        deduplicated: result.deduplicated,
        status: (result.deduplicated ? 200 : 201) as 200 | 201,
        body,
        versionNumber: result.version.versionNumber,
      };
    });
    if (committed.deduplicated) {
      this.metrics.incVersionDeduplicated();
    } else {
      await this.deps.enqueuer.enqueue(committed.versionId, {
        trigger: 'upload',
        correlationId: requestId,
      });
    }

    return {
      status: committed.status,
      body: committed.body,
      versionNumber: committed.versionNumber,
    };
  }

  list(documentId: string, query: ListVersionsQuery): Promise<Page<VersionSummaryDto>> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      const document = await getAliveDocumentOrThrow(tx, documentId);
      const page = await listVersions(tx, documentId, {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.origin !== undefined ? { origin: query.origin } : {}),
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      const rows = await getVersionsWithTemplateVersion(
        tx,
        page.data.map((v) => v.id),
      );
      const data = page.data.flatMap((v) => {
        const row = rows.get(v.id);
        return row ? [toVersionSummary(row, document)] : [];
      });
      return { data, page: page.page };
    });
  }

  detail(documentId: string, versionNumber: number): Promise<VersionDetailDto> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      const document = await getAliveDocumentOrThrow(tx, documentId);
      const row = await getVersionWithTemplateVersionByNumber(tx, documentId, versionNumber);
      const { version } = row;
      const values = await this.views.valueViews(tx, version, document);
      const progress = await computeVersionProgress(tx, version.id, version.versionNumber);
      return {
        ...toVersionSummary(row, document),
        values,
        progress,
        file: {
          originalFilename: version.originalFilename,
          fileSizeBytes: version.fileSizeBytes,
          fileSha256: version.fileSha256,
        },
        textRanges: (version.textRanges as VersionDetailDto['textRanges']) ?? null,
        pageOffsets: version.pageOffsets ?? null,
      };
    });
  }

  values(
    documentId: string,
    versionNumber: number,
    query: ListValuesQuery,
  ): Promise<Page<ValueViewDto>> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      const document = await getAliveDocumentOrThrow(tx, documentId);
      const { version } = await getVersionWithTemplateVersionByNumber(
        tx,
        documentId,
        versionNumber,
      );
      const fingerprint = fingerprintFilters({
        reviewState: query.reviewState,
        attention: query.attention,
      });
      const decoded = query.cursor
        ? decodeCursor(query.cursor, fingerprint, isValidPositiveIntKey)
        : null;
      const isPrev = decoded?.d === 'prev';
      const cursorPosition = decoded ? Number(decoded.k) : 0;
      const all = await this.views.valueViews(tx, version, document);
      // Spec §7.2: GET .../versions/:n/values is ordered by position ASC (bounded <= 100).
      const filtered = [...all]
        .sort((a, b) => (isPrev ? b.position - a.position : a.position - b.position))
        .filter((v) => {
          if (query.reviewState !== undefined && v.reviewState !== query.reviewState) return false;
          if (query.attention !== undefined && v.attention !== query.attention) return false;
          if (!decoded) return true;
          return isPrev ? v.position < cursorPosition : v.position > cursorPosition;
        });
      return toPage(filtered, query.limit, (v) => String(v.position), fingerprint, {
        isPrev,
        hasCursor: decoded !== null,
      });
    });
  }

  async text(documentId: string, versionNumber: number): Promise<{ text: string; sha256: string }> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      await getAliveDocumentOrThrow(tx, documentId);
      const { version } = await getVersionWithTemplateVersionByNumber(
        tx,
        documentId,
        versionNumber,
      );
      if (version.parsedText === null || version.parsedTextSha256 === null) {
        throw new ProblemError(
          'TEXT_NOT_AVAILABLE',
          `Version ${versionNumber} has no parsed text yet`,
        );
      }
      return { text: version.parsedText, sha256: version.parsedTextSha256 };
    });
  }

  async file(documentId: string, versionNumber: number): Promise<VersionBytes> {
    const version = await withReadOnlyTx(this.deps.db, async (tx) => {
      await getAliveDocumentOrThrow(tx, documentId);
      return (await getVersionWithTemplateVersionByNumber(tx, documentId, versionNumber)).version;
    });
    const bytes = await this.deps.blobStore.getObject(version.storageKey);
    return { bytes, sha256: version.fileSha256, filename: version.originalFilename };
  }

  async retry(
    documentId: string,
    versionNumber: number,
    requestId: string,
  ): Promise<VersionSummaryDto> {
    const { versionId, summary } = await withTx(this.deps.db, async (tx) => {
      const version = await retryVersion(tx, documentId, versionNumber);
      const document = await getAliveDocumentOrThrow(tx, documentId);
      const row = (await getVersionsWithTemplateVersion(tx, [version.id])).get(version.id)!;
      return { versionId: version.id, summary: toVersionSummary(row, document) };
    });
    await this.deps.enqueuer.enqueue(versionId, { trigger: 'retry', correlationId: requestId });
    return summary;
  }

  async reextract(
    documentId: string,
    versionNumber: number,
    reparse: boolean,
    requestId: string,
  ): Promise<VersionSummaryDto> {
    const { versionId, summary } = await withTx(this.deps.db, async (tx) => {
      const { document, version } = await createReextractVersion(tx, documentId, versionNumber, {
        reparse,
        requestId,
      });
      const row = (await getVersionsWithTemplateVersion(tx, [version.id])).get(version.id)!;
      return { versionId: version.id, summary: toVersionSummary(row, document) };
    });
    await this.deps.enqueuer.enqueue(versionId, {
      trigger: 'reextract',
      correlationId: requestId,
    });
    return summary;
  }
}
