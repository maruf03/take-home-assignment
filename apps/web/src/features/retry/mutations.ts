import { versionSummaryDtoSchema, type VersionSummaryDto } from '@app/contracts/dto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client.js';
import { queryKeys } from '../../shared/api/query-keys.js';

export function useRetryVersion(documentId: string) {
  const queryClient = useQueryClient();

  return useMutation<VersionSummaryDto, Error, number>({
    mutationFn: (versionNumber) =>
      api.post(
        `/documents/${encodeURIComponent(documentId)}/versions/${versionNumber}/retry`,
        undefined,
        versionSummaryDtoSchema,
      ),
    onSuccess: (_summary, versionNumber) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.detail(documentId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.documents.version(documentId, versionNumber),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.facets() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.documents.all(),
        predicate: (q) => q.queryKey[1] === 'list',
      });
    },
  });
}

export function useReextractVersion(documentId: string) {
  const queryClient = useQueryClient();

  return useMutation<VersionSummaryDto, Error, { versionNumber: number; reparse?: boolean }>({
    mutationFn: ({ versionNumber, reparse = false }) =>
      api.post(
        `/documents/${encodeURIComponent(documentId)}/versions/${versionNumber}/reextract?reparse=${reparse ? 'true' : 'false'}`,
        undefined,
        versionSummaryDtoSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.detail(documentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.facets() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.documents.all(),
        predicate: (q) => q.queryKey[1] === 'list',
      });
    },
  });
}
