import {
  documentDetailDtoSchema,
  documentsFacetsDtoSchema,
  documentSummaryDtoSchema,
  documentTypeDtoSchema,
  versionDetailDtoSchema,
  type DocumentDetailDto,
  type DocumentsFacetsDto,
  type DocumentSummaryDto,
  type DocumentTypeDto,
  type VersionDetailDto,
} from '@app/contracts/dto';
import { pageSchema, type Page } from '@app/contracts/page';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client.js';
import {
  DEFAULT_POLL_MS,
  isDocumentInFlight,
  isFirstPageInFlight,
} from '../../shared/api/polling.js';
import { queryKeys, type DocumentsListFilters } from '../../shared/api/query-keys.js';

const documentTypesPageSchema = pageSchema(documentTypeDtoSchema);
const documentsPageSchema = pageSchema(documentSummaryDtoSchema);

export function useDocumentTypes() {
  return useQuery<Page<DocumentTypeDto>>({
    queryKey: queryKeys.documentTypes(),
    queryFn: ({ signal }) => api.get('/document-types?limit=100', documentTypesPageSchema, signal),
    staleTime: Infinity,
  });
}

export function useDocumentsFacets() {
  return useQuery<DocumentsFacetsDto>({
    queryKey: queryKeys.documents.facets(),
    queryFn: ({ signal }) => api.get('/documents/facets', documentsFacetsDtoSchema, signal),
    staleTime: 10_000,
  });
}

function buildDocumentsListPath(filters: DocumentsListFilters, cursor: string | null): string {
  const params = new URLSearchParams({ limit: '20' });
  if (filters.view === 'needs-review') {
    params.set('needsReview', 'true');
  } else if (filters.view === 'failed') {
    params.set('status', 'failed');
  }
  if (filters.type) {
    params.set('type', filters.type);
  }
  if (cursor) {
    params.set('cursor', cursor);
  }
  return `/documents?${params.toString()}`;
}

export function useDocumentsList(filters: DocumentsListFilters, pollMs = DEFAULT_POLL_MS) {
  return useInfiniteQuery<Page<DocumentSummaryDto>>({
    queryKey: queryKeys.documents.list(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        buildDocumentsListPath(filters, pageParam as string | null),
        documentsPageSchema,
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    staleTime: 10_000,
    // Spec §14.6: poll page 1 only while something on page 1 is in flight.
    refetchInterval: (query) => (isFirstPageInFlight(query.state.data?.pages) ? pollMs : false),
  });
}

export function useDocumentDetail(documentId: string, pollMs = DEFAULT_POLL_MS) {
  return useQuery<DocumentDetailDto>({
    queryKey: queryKeys.documents.detail(documentId),
    queryFn: ({ signal }) =>
      api.get(`/documents/${encodeURIComponent(documentId)}`, documentDetailDtoSchema, signal),
    staleTime: 0,
    refetchInterval: (query) => (isDocumentInFlight(query.state.data) ? pollMs : false),
    throwOnError: true,
  });
}

export function useVersionDetail(documentId: string, versionNumber: number | null) {
  return useQuery<VersionDetailDto>({
    queryKey: queryKeys.documents.version(documentId, versionNumber ?? 0),
    enabled: versionNumber !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/documents/${encodeURIComponent(documentId)}/versions/${versionNumber}`,
        versionDetailDtoSchema,
        signal,
      ),
    staleTime: 60_000,
    throwOnError: true,
  });
}

export function useVersionText(documentId: string, versionNumber: number | null, enabled: boolean) {
  return useQuery<string>({
    queryKey: queryKeys.documents.text(documentId, versionNumber ?? 0),
    enabled: enabled && versionNumber !== null,
    queryFn: ({ signal }) =>
      api.getText(
        `/documents/${encodeURIComponent(documentId)}/versions/${versionNumber}/text`,
        signal,
      ),
    staleTime: 60_000,
  });
}

export interface UploadDocumentInput {
  readonly file: File;
  readonly type: string;
  readonly title?: string;
}

export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation<DocumentDetailDto, Error, UploadDocumentInput>({
    mutationFn: async (input) => {
      const form = new FormData();
      form.append('file', input.file, input.file.name);
      form.append('type', input.type);
      const trimmedTitle = input.title?.trim();
      if (trimmedTitle) {
        form.append('title', trimmedTitle);
      }
      return api.postMultipart('/documents', form, documentDetailDtoSchema);
    },
    onSuccess: (created) => {
      queryClient.setQueryData(queryKeys.documents.detail(created.id), created);
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.all() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.facets() });
    },
  });
}
