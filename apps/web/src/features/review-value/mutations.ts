import {
  reviewResponseDtoSchema,
  valueViewDtoSchema,
  type CreateReviewRequest,
  type DocumentDetailDto,
  type DocumentSummaryDto,
  type Progress,
  type ReviewResponseDto,
  type ValueViewDto,
} from '@app/contracts/dto';
import type { Page } from '@app/contracts/page';
import type { TypedValue } from '@app/contracts/values';
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { api, ApiError } from '../../shared/api/client.js';
import { queryKeys } from '../../shared/api/query-keys.js';

export interface ReviewMutationVariables {
  readonly valueId: string;
  readonly fieldKey: string;
  readonly body: CreateReviewRequest;
  /** Canonical typed value used only for optimistic UI projection when decision='correct'. */
  readonly optimisticCorrectedValue?: TypedValue;
}

function decrementBucket(progress: Progress, state: ValueViewDto['reviewState']): Progress {
  switch (state) {
    case 'pending':
      return { ...progress, pending: Math.max(0, progress.pending - 1) };
    case 'approved':
      return { ...progress, approved: Math.max(0, progress.approved - 1) };
    case 'corrected':
      return { ...progress, corrected: Math.max(0, progress.corrected - 1) };
    case 'carried_over':
      return { ...progress, carriedOver: Math.max(0, progress.carriedOver - 1) };
  }
}

function incrementBucket(progress: Progress, decision: 'approve' | 'correct'): Progress {
  if (decision === 'approve') {
    return { ...progress, approved: progress.approved + 1 };
  }
  return { ...progress, corrected: progress.corrected + 1 };
}

/**
 * Pure optimistic projection for reviewing a single value on DocumentDetailDto.
 * Maintains the disjoint progress sum invariant (pending + approved + corrected + carriedOver = total).
 */
export function applyOptimisticReview(
  doc: DocumentDetailDto,
  variables: ReviewMutationVariables,
): DocumentDetailDto {
  const existing = doc.values.find((v) => v.id === variables.valueId);
  if (!existing) return doc;

  const nextState: ValueViewDto['reviewState'] =
    variables.body.decision === 'correct' ? 'corrected' : 'approved';
  const nextEffective =
    variables.body.decision === 'correct' && variables.optimisticCorrectedValue !== undefined
      ? variables.optimisticCorrectedValue
      : existing.value;

  const updatedValue: ValueViewDto = {
    ...existing,
    reviewState: nextState,
    attention: 'done',
    effectiveValue: nextEffective,
    review: {
      id: existing.review?.id ?? '01950000-0000-7000-8000-000000000000',
      decision: variables.body.decision,
      correctedValue:
        variables.body.decision === 'correct' && variables.optimisticCorrectedValue !== undefined
          ? variables.optimisticCorrectedValue
          : null,
      note: variables.body.note ?? null,
      origin: 'human',
      carriedFromVersion: null,
      createdAt: new Date().toISOString(),
    },
  };

  const nextProgress = incrementBucket(
    decrementBucket(doc.progress, existing.reviewState),
    variables.body.decision,
  );

  return {
    ...doc,
    values: doc.values.map((v) => (v.id === variables.valueId ? updatedValue : v)),
    progress: nextProgress,
    needsReview: nextProgress.pending > 0,
  };
}

export function extractConflictValue(error: ApiError): ValueViewDto | null {
  const raw = error.details?.['currentValue'];
  if (!raw) return null;
  const parsed = valueViewDtoSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface UseReviewValueCallbacks {
  readonly onReviewConflict?: (valueId: string, currentValue: ValueViewDto | null) => void;
  readonly onVersionNotReviewable?: () => void;
}

export function useReviewValue(documentId: string, callbacks: UseReviewValueCallbacks = {}) {
  const queryClient = useQueryClient();

  return useMutation<
    ReviewResponseDto,
    Error,
    ReviewMutationVariables,
    { previousDetail?: DocumentDetailDto }
  >({
    mutationFn: (variables) =>
      api.post(
        `/values/${encodeURIComponent(variables.valueId)}/review`,
        variables.body,
        reviewResponseDtoSchema,
      ),
    onMutate: async (variables) => {
      const detailKey = queryKeys.documents.detail(documentId);
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previousDetail = queryClient.getQueryData<DocumentDetailDto>(detailKey);
      if (previousDetail) {
        queryClient.setQueryData<DocumentDetailDto>(
          detailKey,
          applyOptimisticReview(previousDetail, variables),
        );
      }
      return { previousDetail };
    },
    onSuccess: (response) => {
      const detailKey = queryKeys.documents.detail(documentId);
      queryClient.setQueryData<DocumentDetailDto>(detailKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          values: current.values.map((v) => (v.id === response.value.id ? response.value : v)),
          progress: response.progress,
          needsReview: response.progress.pending > 0,
        };
      });

      // Patch matching document rows across cached list queries (spec §14.6).
      queryClient.setQueriesData<InfiniteData<Page<DocumentSummaryDto>>>(
        { queryKey: queryKeys.documents.all() },
        (old) => {
          if (!old || !('pages' in old)) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              data: page.data.map((row) =>
                row.id === documentId
                  ? {
                      ...row,
                      progress: response.progress,
                      needsReview: response.progress.pending > 0,
                    }
                  : row,
              ),
            })),
          };
        },
      );
    },
    onError: (err, variables, context) => {
      const detailKey = queryKeys.documents.detail(documentId);
      if (context?.previousDetail) {
        queryClient.setQueryData(detailKey, context.previousDetail);
      }

      if (err instanceof ApiError && err.status === 409) {
        if (err.code === 'REVIEW_CONFLICT') {
          callbacks.onReviewConflict?.(variables.valueId, extractConflictValue(err));
          void queryClient.invalidateQueries({ queryKey: detailKey });
        } else if (err.code === 'VERSION_NOT_REVIEWABLE') {
          callbacks.onVersionNotReviewable?.();
          void queryClient.invalidateQueries({ queryKey: detailKey });
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.facets() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.documents.all(),
        predicate: (q) => q.queryKey[1] === 'list',
      });
    },
  });
}
