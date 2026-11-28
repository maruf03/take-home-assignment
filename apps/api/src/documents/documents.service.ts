import type {
  CreateDocumentMetadata,
  DocumentDetailDto,
  DocumentsFacetsDto,
  DocumentSummaryDto,
  ListDocumentsQuery,
} from '@app/contracts/dto';
import type { Page } from '@app/contracts/page';
import {
  countNeedsReviewFacets,
  createDocumentWithInitialVersion,
  getDocumentTypeByKey,
  getLatestTemplateForType,
  listAliveDocuments,
  loadDocumentContext,
  withReadOnlyTx,
  withTx,
} from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import { titleFromFilename, type PdfUpload } from '../common/pdf-file.pipe.js';
import { API_DEPS, type ApiDeps } from '../deps.js';
import { ViewService } from '../views/view.service.js';

export function storageKeyFor(sha256: string): string {
  return `pdfs/sha256/${sha256}.pdf`;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(API_DEPS) private readonly deps: ApiDeps,
    @Inject(ViewService) private readonly views: ViewService,
  ) {}

  async list(query: ListDocumentsQuery): Promise<Page<DocumentSummaryDto>> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      const page = await listAliveDocuments(tx, {
        ...(query.type !== undefined ? { type: query.type } : {}),
        ...(query.needsReview !== undefined ? { needsReview: query.needsReview } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.externalId !== undefined ? { externalId: query.externalId } : {}),
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      const data = await this.views.documentSummaries(tx, page.data);
      return { data, page: page.page };
    });
  }

  facets(): Promise<DocumentsFacetsDto> {
    return withReadOnlyTx(this.deps.db, async (tx) => ({
      needsReview: await countNeedsReviewFacets(tx),
    }));
  }

  detail(documentId: string): Promise<DocumentDetailDto> {
    return this.views.documentDetailSnapshot(documentId);
  }

  progress(documentId: string) {
    return withReadOnlyTx(
      this.deps.db,
      async (tx) => (await loadDocumentContext(tx, documentId)).progress,
    );
  }

  async create(
    upload: PdfUpload,
    meta: CreateDocumentMetadata,
    requestId: string,
  ): Promise<DocumentDetailDto> {
    const type = await getDocumentTypeByKey(this.deps.db, meta.type);
    if (!type) {
      throw new ProblemError('UNKNOWN_DOCUMENT_TYPE', `Unknown document type: ${meta.type}`);
    }
    if (!(await getLatestTemplateForType(this.deps.db, meta.type))) {
      throw new ProblemError(
        'NO_TEMPLATE_FOR_TYPE',
        `No extraction template configured for document type: ${meta.type}`,
      );
    }

    // Content-addressed PUT happens before the transaction and is idempotent (spec §6).
    const storageKey = storageKeyFor(upload.sha256);
    await this.deps.blobStore.putObject(storageKey, upload.buffer, 'application/pdf');

    const { version } = await withTx(this.deps.db, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: meta.type,
        title: meta.title ?? titleFromFilename(upload.originalFilename),
        storageKey,
        fileSha256: upload.sha256,
        fileSizeBytes: upload.sizeBytes,
        originalFilename: upload.originalFilename,
        requestId,
      }),
    );

    await this.deps.enqueuer.enqueue(version.id, { trigger: 'upload', correlationId: requestId });
    return this.views.documentDetailSnapshot(version.documentId);
  }
}
