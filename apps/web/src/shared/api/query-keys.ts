export type DocumentsListView = 'needs-review' | 'all' | 'failed';

export interface DocumentsListFilters {
  readonly view: DocumentsListView;
  readonly type?: string;
}

/** Central TanStack Query key factory (spec §14.6). */
export const queryKeys = {
  documentTypes: () => ['document-types'] as const,
  documents: {
    all: () => ['documents'] as const,
    facets: () => ['documents', 'facets'] as const,
    list: (filters: DocumentsListFilters) => ['documents', 'list', filters] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
    versions: (id: string) => ['documents', 'versions', id] as const,
    version: (id: string, versionNumber: number) =>
      ['documents', 'version', id, versionNumber] as const,
    text: (id: string, versionNumber: number) => ['documents', 'text', id, versionNumber] as const,
  },
  values: {
    reviews: (valueId: string) => ['values', 'reviews', valueId] as const,
  },
  runs: {
    list: (documentId: string, versionNumber: number) =>
      ['runs', 'list', documentId, versionNumber] as const,
  },
};
