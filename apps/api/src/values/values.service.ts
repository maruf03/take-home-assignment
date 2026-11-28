import {
  createReviewRequestSchema,
  listReviewsQuerySchema,
  type CreateReviewRequest,
  type ListReviewsQuery,
  type ReviewDto,
  type ReviewResponseDto,
} from '@app/contracts/dto';
import type { Page } from '@app/contracts/page';
import { parseTypedValue, type TypedValue } from '@app/contracts/values';
import {
  DbRepoError,
  getCarriedFromVersionNumbers,
  getValueContext,
  insertReview,
  listReviewsForValue,
  withReadOnlyTx,
  withTx,
} from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError, truncateProblemMessage } from '../common/problem.js';
import { API_DEPS, type ApiDeps } from '../deps.js';
import { ApiMetricsService } from '../observability/metrics.service.js';
import { toReviewListItem } from '../views/presenters.js';
import { ViewService } from '../views/view.service.js';

type DateOrder = Parameters<typeof parseTypedValue>[2] extends infer T
  ? T extends { dateOrder?: infer D }
    ? D
    : never
  : never;

@Injectable()
export class ValuesService {
  constructor(
    @Inject(API_DEPS) private readonly deps: ApiDeps,
    @Inject(ViewService) private readonly views: ViewService,
    @Inject(ApiMetricsService) private readonly metrics: ApiMetricsService,
  ) {}

  async review(
    valueId: string,
    body: CreateReviewRequest,
    requestId: string,
  ): Promise<{ status: 200 | 201; body: ReviewResponseDto }> {
    const ctx = await getValueContext(this.deps.db, valueId);

    let correctedValue: TypedValue | null = null;
    if (body.decision === 'correct') {
      const parsed = parseTypedValue(ctx.value.fieldType as never, body.correctedValue, {
        defaultCurrency: ctx.template.defaultCurrency,
        dateOrder: ctx.template.dateOrder as DateOrder,
      });
      if (!parsed.ok) {
        // Spec §7.3: never echo values longer than 100 characters in error payloads.
        const rawExceedsLimit =
          (typeof body.correctedValue === 'string' && body.correctedValue.length > 100) ||
          (typeof body.correctedValue === 'object' &&
            body.correctedValue !== null &&
            body.correctedValue.amount.length > 100);
        const safeError = rawExceedsLimit
          ? `Invalid ${ctx.value.fieldType} value`
          : truncateProblemMessage(parsed.error);
        throw new ProblemError('INVALID_CORRECTION', safeError, {
          errors: [{ path: 'correctedValue', message: safeError }],
        });
      }
      correctedValue = parsed.value;
    }

    try {
      // Build ValueViewDto in the SAME transaction as insertReview so { value, progress } are atomic.
      const committed = await withTx(this.deps.db, async (tx) => {
        const result = await insertReview(
          tx,
          valueId,
          {
            decision: body.decision,
            correctedValue,
            note: body.note ?? null,
            ...(body.expectedCurrentReviewId !== undefined
              ? { expectedCurrentReviewId: body.expectedCurrentReviewId }
              : {}),
          },
          requestId,
        );
        const viewCtx = await getValueContext(tx, valueId);
        const [value] = await this.views.valueViews(tx, viewCtx.version, viewCtx.document, [
          valueId,
        ]);
        return {
          status: (result.noop ? 200 : 201) as 200 | 201,
          body: {
            value: value!,
            progress: result.progress,
            ...(result.noop ? { noop: true } : {}),
          },
        };
      });
      if (committed.status === 201) {
        this.metrics.incReview(body.decision, 'human');
      }
      return committed;
    } catch (err) {
      if (err instanceof DbRepoError && err.code === 'REVIEW_CONFLICT') {
        const currentValue = await this.currentValueView(valueId);
        throw new ProblemError('REVIEW_CONFLICT', err.message, { details: { currentValue } });
      }
      throw err;
    }
  }

  reviews(valueId: string, query: ListReviewsQuery): Promise<Page<ReviewDto>> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      await getValueContext(tx, valueId);
      const page = await listReviewsForValue(tx, valueId, {
        ...(query.origin !== undefined ? { origin: query.origin } : {}),
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      const carried = await getCarriedFromVersionNumbers(tx, page.data);
      return { data: page.data.map((r) => toReviewListItem(r, carried)), page: page.page };
    });
  }

  private currentValueView(valueId: string) {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      const ctx = await getValueContext(tx, valueId);
      const [view] = await this.views.valueViews(tx, ctx.version, ctx.document, [valueId]);
      return view!;
    });
  }
}

export { createReviewRequestSchema, listReviewsQuerySchema };
