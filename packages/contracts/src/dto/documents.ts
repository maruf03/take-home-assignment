import { z } from 'zod';
import { listQuery } from '../page.js';
import {
  attentionBucketSchema,
  llmCallKindSchema,
  reviewOriginSchema,
  reviewStateSchema,
  runStatusSchema,
  versionOriginSchema,
  versionStatusSchema,
} from '../status.js';
import { isoTimestampSchema, progressSchema, uuidSchema, valuesTextMetaSchema } from './common.js';
import { documentTypeKeySchema } from './document-types.js';
import { valueViewDtoSchema } from './values.js';
import { versionSummaryDtoSchema } from './versions.js';

export const documentSummaryDtoSchema = z.object({
  id: uuidSchema,
  externalId: z.string().nullable(),
  type: documentTypeKeySchema,
  typeLabel: z.string().min(1),
  title: z.string().min(1).max(200),
  status: versionStatusSchema,
  currentVersion: versionSummaryDtoSchema,
  valuesVersion: z.number().int().min(1).nullable(),
  progress: progressSchema,
  needsReview: z.boolean(),
  deletedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});

export type DocumentSummaryDto = z.infer<typeof documentSummaryDtoSchema>;

export const documentDetailDtoSchema = documentSummaryDtoSchema.extend({
  values: z.array(valueViewDtoSchema),
  valuesTextMeta: valuesTextMetaSchema.nullable(),
  recentVersions: z.array(versionSummaryDtoSchema),
  versionsCount: z.number().int().min(0),
  links: z.object({
    versions: z.string().min(1),
  }),
});

export type DocumentDetailDto = z.infer<typeof documentDetailDtoSchema>;

export const createVersionResponseDtoSchema = z.object({
  document: documentSummaryDtoSchema,
  version: versionSummaryDtoSchema,
  deduplicated: z.boolean().optional(),
});

export type CreateVersionResponseDto = z.infer<typeof createVersionResponseDtoSchema>;

export const documentsFacetsDtoSchema = z.object({
  needsReview: z.object({
    count: z.number().int().min(0).max(100),
    capped: z.boolean(),
  }),
});

export type DocumentsFacetsDto = z.infer<typeof documentsFacetsDtoSchema>;

export const createDocumentMetadataSchema = z
  .object({
    type: documentTypeKeySchema,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type CreateDocumentMetadata = z.infer<typeof createDocumentMetadataSchema>;

const booleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const listDocumentsQuerySchema = listQuery({
  type: documentTypeKeySchema.optional(),
  needsReview: booleanQuerySchema,
  status: versionStatusSchema.optional(),
  externalId: z.string().min(1).max(128).optional(),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

export const listVersionsQuerySchema = listQuery({
  status: versionStatusSchema.optional(),
  origin: versionOriginSchema.optional(),
});

export type ListVersionsQuery = z.infer<typeof listVersionsQuerySchema>;

export const listValuesQuerySchema = listQuery({
  reviewState: reviewStateSchema.optional(),
  attention: attentionBucketSchema.optional(),
});

export type ListValuesQuery = z.infer<typeof listValuesQuerySchema>;

export const listReviewsQuerySchema = listQuery({
  origin: reviewOriginSchema.optional(),
});

export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;

export const listRunsQuerySchema = listQuery({
  status: runStatusSchema.optional(),
});

export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const listLlmCallsQuerySchema = listQuery({
  kind: llmCallKindSchema.optional(),
});

export type ListLlmCallsQuery = z.infer<typeof listLlmCallsQuerySchema>;
