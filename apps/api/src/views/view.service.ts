import type { DocumentDetailDto, DocumentSummaryDto, ValueViewDto } from '@app/contracts/dto';
import {
  getVersionsWithTemplateVersion,
  listVersions,
  loadDocumentContext,
  loadDocumentContexts,
  loadValueReadRows,
  withReadOnlyTx,
  type DbTx,
  type DocumentRow,
  type DocumentVersionRow,
} from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { API_DEPS, type ApiDeps } from '../deps.js';
import {
  sortValueViews,
  textContextOf,
  toDocumentDetail,
  toDocumentSummary,
  toValueView,
  toVersionSummary,
} from './presenters.js';

const RECENT_VERSIONS = 5;

/** Assembles contract DTOs from the db read models. */
@Injectable()
export class ViewService {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  async valueViews(
    tx: DbTx,
    version: DocumentVersionRow,
    document: Pick<DocumentRow, 'reviewableVersionId' | 'deletedAt'>,
    valueIds?: readonly string[],
  ): Promise<ValueViewDto[]> {
    const rows = await loadValueReadRows(tx, version, valueIds);
    const text = textContextOf(version);
    const reviewable = document.deletedAt === null && document.reviewableVersionId === version.id;
    return sortValueViews(rows.map((row) => toValueView(row, text, reviewable)));
  }

  async documentSummaries(tx: DbTx, docs: readonly DocumentRow[]): Promise<DocumentSummaryDto[]> {
    const contexts = await loadDocumentContexts(tx, docs);
    return contexts.map((ctx) => toDocumentSummary(ctx, ctx.progress));
  }

  async documentDetail(tx: DbTx, documentId: string): Promise<DocumentDetailDto> {
    const ctx = await loadDocumentContext(tx, documentId);
    const values = ctx.reviewable
      ? await this.valueViews(tx, ctx.reviewable.version, ctx.document)
      : [];
    const recent = await listVersions(tx, documentId, { limit: RECENT_VERSIONS });
    const rows = await getVersionsWithTemplateVersion(
      tx,
      recent.data.map((v) => v.id),
    );
    const recentVersions = recent.data.flatMap((v) => {
      const row = rows.get(v.id);
      return row ? [toVersionSummary(row, ctx.document)] : [];
    });
    return toDocumentDetail(ctx, { values, recentVersions });
  }

  documentDetailSnapshot(documentId: string): Promise<DocumentDetailDto> {
    return withReadOnlyTx(this.deps.db, (tx) => this.documentDetail(tx, documentId));
  }
}
