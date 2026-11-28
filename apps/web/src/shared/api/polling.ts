import type { DocumentSummaryDto } from '@app/contracts/dto';

export const DEFAULT_POLL_MS = 2000;

export function isStatusInFlight(status: DocumentSummaryDto['status']): boolean {
  return status === 'queued' || status === 'extracting';
}

export function isDocumentInFlight(doc: Pick<DocumentSummaryDto, 'status'> | undefined): boolean {
  return doc !== undefined && isStatusInFlight(doc.status);
}

export function isFirstPageInFlight(
  pages: ReadonlyArray<{ data: readonly DocumentSummaryDto[] }> | undefined,
): boolean {
  const firstPage = pages?.[0];
  if (!firstPage) return false;
  return firstPage.data.some((doc) => isStatusInFlight(doc.status));
}
