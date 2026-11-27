import { z } from 'zod';
import {
  attentionBucketSchema,
  changeKindSchema,
  changeReasonSchema,
  extractedValueKindSchema,
  fieldTypeSchema,
  gapCodeSchema,
  matchModeSchema,
  reviewStateSchema,
  valueFlagSchema,
} from '../status.js';
import { typedValueSchema } from '../values.js';
import { progressSchema, uuidSchema } from './common.js';
import { fieldKeySchema } from './document-types.js';
import { reviewDtoSchema } from './reviews.js';

export const evidenceOccurrenceSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

export const evidenceDtoSchema = z.object({
  quote: z.string(),
  line: z.number().int().min(1),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  matchCount: z.number().int().min(1),
  matchMode: matchModeSchema,
  citedLine: z.number().int().min(1).nullable(),
  otherOccurrences: z.array(evidenceOccurrenceSchema),
});

export type EvidenceDto = z.infer<typeof evidenceDtoSchema>;

export const gapDtoSchema = z.object({
  code: gapCodeSchema,
  reason: z.string(),
  attemptedQuote: z.string().nullable(),
});

export type GapDto = z.infer<typeof gapDtoSchema>;

export const previousValueDtoSchema = z.object({
  versionNumber: z.number().int().min(1),
  valueId: uuidSchema,
  kind: extractedValueKindSchema,
  value: typedValueSchema.nullable(),
  effectiveValue: typedValueSchema.nullable(),
  evidence: z
    .object({
      quote: z.string(),
      line: z.number().int().min(1),
    })
    .nullable(),
  gap: z
    .object({
      code: gapCodeSchema,
      reason: z.string(),
    })
    .nullable(),
  review: reviewDtoSchema.nullable(),
});

export type PreviousValueDto = z.infer<typeof previousValueDtoSchema>;

export const valueViewDtoSchema = z.object({
  id: uuidSchema,
  fieldKey: fieldKeySchema,
  label: z.string().min(1),
  fieldType: fieldTypeSchema,
  position: z.number().int().min(1).max(100),
  kind: extractedValueKindSchema,
  value: typedValueSchema.nullable(),
  effectiveValue: typedValueSchema.nullable(),
  evidence: evidenceDtoSchema.nullable(),
  gap: gapDtoSchema.nullable(),
  flags: z.array(valueFlagSchema),
  changeKind: changeKindSchema,
  changeReason: changeReasonSchema.nullable(),
  reviewState: reviewStateSchema,
  attention: attentionBucketSchema,
  review: reviewDtoSchema.nullable(),
  previous: previousValueDtoSchema.nullable(),
  reviewable: z.boolean(),
});

export type ValueViewDto = z.infer<typeof valueViewDtoSchema>;

export const reviewResponseDtoSchema = z.object({
  value: valueViewDtoSchema,
  progress: progressSchema,
  noop: z.boolean().optional(),
});

export type ReviewResponseDto = z.infer<typeof reviewResponseDtoSchema>;
