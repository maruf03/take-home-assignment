import { createVersionResponseDtoSchema, type CreateVersionResponseDto } from '@app/contracts/dto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/client.js';
import { queryKeys } from '../../shared/api/query-keys.js';

export function useUploadVersion(documentId: string) {
  const queryClient = useQueryClient();

  return useMutation<CreateVersionResponseDto, Error, File>({
    mutationFn: (file) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return api.postMultipart(
        `/documents/${encodeURIComponent(documentId)}/versions`,
        form,
        createVersionResponseDtoSchema,
      );
    },
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
