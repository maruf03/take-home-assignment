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
import { useState } from 'react';
import { api, ApiError } from '../../shared/api/client.js';
import { queryKeys } from '../../shared/api/query-keys.js';

export interface ReviewMutationVariables {
  readonly valueId: string;
  readonly fieldKey: string;
  readonly body: CreateReviewRequest;
  /** Canonical typed value used only for optimistic UI projection when decision='correct'. */
  readonly optimisticCorrectedValue?: TypedValue;
}

export function recomputeProgress(
  values: readonly ValueViewDto[],
  versionNumber: number | null,
): Progress {
  let pending = 0;
  let approved = 0;
  let corrected = 0;
  let carriedOver = 0;
  let gaps = 0;
  for (const v of values) {
    if (v.kind === 'gap') gaps += 1;
    switch (v.reviewState) {
      case 'pending':
        pending += 1;
        break;
      case 'approved':
        approved += 1;
        break;
      case 'corrected':
        corrected += 1;
        break;
      case 'carried_over':
        carriedOver += 1;
        break;
    }
  }
  return {
    versionNumber,
    pending,
    approved,
    corrected,
    carriedOver,
    total: values.length,
    gaps,
  };
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
    review: existing.review
      ? {
          ...existing.review,
          decision: variables.body.decision,
          correctedValue:
            variables.body.decision === 'correct' &&
            variables.optimisticCorrectedValue !== undefined
              ? variables.optimisticCorrectedValue
              : null,
          note: variables.body.note ?? null,
          origin: 'human',
          carriedFromVersion: null,
        }
      : null,
  };

  const nextValues = doc.values.map((v) => (v.id === variables.valueId ? updatedValue : v));
  const nextProgress = recomputeProgress(nextValues, doc.progress.versionNumber);

  return {
    ...doc,
    values: nextValues,
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
  const [pendingValueIds, setPendingValueIds] = useState<ReadonlySet<string>>(() => new Set());

  const mutation = useMutation<
    ReviewResponseDto,
    Error,
    ReviewMutationVariables,
    { previousValue?: ValueViewDto }
  >({
    mutationFn: (variables) =>
      api.post(
        `/values/${encodeURIComponent(variables.valueId)}/review`,
        variables.body,
        reviewResponseDtoSchema,
      ),
    onMutate: async (variables) => {
      setPendingValueIds((prev) => {
        const next = new Set(prev);
        next.add(variables.valueId);
        return next;
      });
      const detailKey = queryKeys.documents.detail(documentId);
      await queryClient.cancelQueries({ queryKey: detailKey });
      const currentDetail = queryClient.getQueryData<DocumentDetailDto>(detailKey);
      const previousValue = currentDetail?.values.find((v) => v.id === variables.valueId);
      if (currentDetail && previousValue) {
        queryClient.setQueryData<DocumentDetailDto>(
          detailKey,
          applyOptimisticReview(currentDetail, variables),
        );
      }
      return { previousValue };
    },
    onSuccess: (response) => {
      const detailKey = queryKeys.documents.detail(documentId);
      queryClient.setQueryData<DocumentDetailDto>(detailKey, (current) => {
        if (!current) return current;
        const nextValues = current.values.map((v) =>
          v.id === response.value.id ? response.value : v,
        );
        return {
          ...current,
          values: nextValues,
          progress: response.progress,
          needsReview: response.progress.pending > 0,
        };
      });

      // Patch matching document rows across cached list queries only (never text/detail queries).
      queryClient.setQueriesData<InfiniteData<Page<DocumentSummaryDto>>>(
        {
          queryKey: queryKeys.documents.all(),
          predicate: (q) => q.queryKey[1] === 'list',
        },
        (old) => {
          if (!old || typeof old !== 'object' || !('pages' in old)) return old;
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
      // Roll back ONLY the failed value so concurrent reviews on sibling rows are never clobbered.
      if (context?.previousValue) {
        const rollbackVal = context.previousValue;
        queryClient.setQueryData<DocumentDetailDto>(detailKey, (current) => {
          if (!current) return current;
          const nextValues = current.values.map((v) =>
            v.id === variables.valueId ? rollbackVal : v,
          );
          const nextProgress = recomputeProgress(nextValues, current.progress.versionNumber);
          return {
            ...current,
            values: nextValues,
            progress: nextProgress,
            needsReview: nextProgress.pending > 0,
          };
        });
      }

      if (err instanceof ApiError && err.status === 409) {
        if (err.code === 'REVIEW_CONFLICT') {
          const conflictVal = extractConflictValue(err);
          callbacks.onReviewConflict?.(variables.valueId, conflictVal);
          void queryClient.invalidateQueries({ queryKey: detailKey });
        } else if (err.code === 'VERSION_NOT_REVIEWABLE') {
          callbacks.onVersionNotReviewable?.();
          void queryClient.invalidateQueries({ queryKey: detailKey });
        }
      }
    },
    onSettled: (_data, _err, variables) => {
      setPendingValueIds((prev) => {
        if (!prev.has(variables.valueId)) return prev;
        const next = new Set(prev);
        next.delete(variables.valueId);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents.facets() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.documents.all(),
        predicate: (q) => q.queryKey[1] === 'list',
      });
    },
  });

  return {
    ...mutation,
    pendingValueIds,
  };
}
