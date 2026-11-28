import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 512;

// Core pagination is forward-only (spec §15.3 overrides §7.2: no prevCursor in Core).
export const pageMetaSchema = z
  .object({
    limit: z.number().int().min(MIN_PAGE_LIMIT).max(MAX_PAGE_LIMIT),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(MAX_CURSOR_LENGTH).nullable(),
  })
  .strict();

export type PageMeta = z.infer<typeof pageMetaSchema>;

export interface Page<T> {
  data: T[];
  page: PageMeta;
}

export function pageSchema<TItem extends z.ZodType>(itemSchema: TItem) {
  return z
    .object({
      data: z.array(itemSchema),
      page: pageMetaSchema,
    })
    .strict();
}

export const pageLimitQuerySchema = z
  .union([
    z.number().int(),
    z
      .string()
      .regex(/^[0-9]+$/, 'Limit must be a positive integer')
      .transform((value) => Number(value)),
  ])
  .pipe(z.number().int().min(MIN_PAGE_LIMIT).max(MAX_PAGE_LIMIT))
  .default(DEFAULT_PAGE_LIMIT);

export const pageCursorQuerySchema = z.string().min(1).max(MAX_CURSOR_LENGTH).optional();

export const baseListQueryShape = {
  limit: pageLimitQuerySchema,
  cursor: pageCursorQuerySchema,
} as const;

export function listQuery<TShape extends z.ZodRawShape = Record<never, never>>(filters?: TShape) {
  return z.object({ ...baseListQueryShape, ...(filters ?? ({} as TShape)) }).strict();
}

export const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    k: z.string().min(1).max(128),
    d: z.literal('next'),
    f: z.string().max(128),
  })
  .strict();

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;
