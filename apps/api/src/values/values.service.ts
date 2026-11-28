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
import { ProblemError } from '../common/problem.js';
import { API_DEPS, type ApiDeps } from '../deps.js';
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
        throw new ProblemError('INVALID_CORRECTION', parsed.error, {
          errors: [{ path: 'correctedValue', message: parsed.error }],
        });
      }
      correctedValue = parsed.value;
    }

    let result: Awaited<ReturnType<typeof insertReview>>;
    try {
      result = await withTx(this.deps.db, (tx) =>
        insertReview(
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
        ),
      );
    } catch (err) {
      if (err instanceof DbRepoError && err.code === 'REVIEW_CONFLICT') {
        const currentValue = await this.currentValueView(valueId);
        throw new ProblemError('REVIEW_CONFLICT', err.message, { details: { currentValue } });
      }
      throw err;
    }

    const value = await this.currentValueView(valueId);
    return {
      status: result.noop ? 200 : 201,
      body: { value, progress: result.progress, ...(result.noop ? { noop: true } : {}) },
    };
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
