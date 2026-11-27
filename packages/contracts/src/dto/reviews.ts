import { z } from 'zod';
import { reviewDecisionSchema, reviewOriginSchema } from '../status.js';
import { stringValueSchema, typedValueSchema } from '../values.js';
import { isoTimestampSchema, uuidSchema } from './common.js';

export const MAX_REVIEW_NOTE_LENGTH = 1000;

export const reviewDtoSchema = z.object({
  id: uuidSchema,
  decision: reviewDecisionSchema,
  correctedValue: typedValueSchema.nullable(),
  note: z.string().max(MAX_REVIEW_NOTE_LENGTH).nullable(),
  origin: reviewOriginSchema,
  carriedFromVersion: z.number().int().min(1).nullable(),
  createdAt: isoTimestampSchema,
});

export type ReviewDto = z.infer<typeof reviewDtoSchema>;

const reviewNoteInputSchema = z.string().max(MAX_REVIEW_NOTE_LENGTH).optional();
const expectedCurrentReviewIdSchema = uuidSchema.nullable().optional();

// Accepts uncanonicalized string or { amount: string, currency?: string } inputs (rejecting JSON
// numbers) so the API service can canonicalize via parseTypedValue() or return 422 INVALID_CORRECTION.
export const correctionInputValueSchema = z.union([
  stringValueSchema,
  z
    .object({
      amount: z.string().trim().min(1).max(128),
      currency: z.string().max(16).optional(),
    })
    .strict(),
]);

export type CorrectionInputValue = z.infer<typeof correctionInputValueSchema>;

// Core supports approve and correct (revert is Extended E1c; spec §15.3).
export const createReviewRequestSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('approve'),
      note: reviewNoteInputSchema,
      expectedCurrentReviewId: expectedCurrentReviewIdSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal('correct'),
      correctedValue: correctionInputValueSchema,
      note: reviewNoteInputSchema,
      expectedCurrentReviewId: expectedCurrentReviewIdSchema,
    })
    .strict(),
]);

export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;
