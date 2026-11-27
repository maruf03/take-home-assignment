import { z } from 'zod';
import {
  llmCallKindSchema,
  runStatusSchema,
  runTriggerSchema,
  versionOriginSchema,
  versionStatusSchema,
  versionWarningSchema,
} from '../status.js';
import { HEX64_REGEX_SOURCE } from '../values.js';
import {
  isoTimestampSchema,
  progressSchema,
  textRangesSchema,
  uuidSchema,
  versionErrorSchema,
} from './common.js';
import { valueViewDtoSchema } from './values.js';

export const versionSummaryDtoSchema = z.object({
  number: z.number().int().min(1),
  status: versionStatusSchema,
  origin: versionOriginSchema,
  sourceVersionNumber: z.number().int().min(1).nullable(),
  templateVersion: z.number().int().min(1),
  parser: z.string().nullable(),
  warnings: z.array(versionWarningSchema),
  error: versionErrorSchema.nullable(),
  attempts: z.number().int().min(0),
  createdAt: isoTimestampSchema,
  extractedAt: isoTimestampSchema.nullable(),
  reviewable: z.boolean(),
});

export type VersionSummaryDto = z.infer<typeof versionSummaryDtoSchema>;

export const versionFileInfoDtoSchema = z.object({
  originalFilename: z.string().min(1).max(255),
  fileSizeBytes: z.number().int().min(1),
  fileSha256: z.string().regex(new RegExp(HEX64_REGEX_SOURCE)),
});

export type VersionFileInfoDto = z.infer<typeof versionFileInfoDtoSchema>;

export const versionDetailDtoSchema = versionSummaryDtoSchema.extend({
  values: z.array(valueViewDtoSchema),
  progress: progressSchema,
  file: versionFileInfoDtoSchema,
  textRanges: textRangesSchema.nullable(),
  pageOffsets: z.array(z.number().int().min(0)).nullable(),
});

export type VersionDetailDto = z.infer<typeof versionDetailDtoSchema>;

export const runDtoSchema = z.object({
  id: uuidSchema,
  runNumber: z.number().int().min(1),
  status: runStatusSchema,
  trigger: runTriggerSchema,
  correlationId: z.string().nullable(),
  workerId: z.string(),
  chunked: z.boolean(),
  llmCallCount: z.number().int().min(0),
  reusedCallCount: z.number().int().min(0),
  costUsd: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
});

export type RunDto = z.infer<typeof runDtoSchema>;

export const llmCallDtoSchema = z.object({
  id: uuidSchema,
  runId: uuidSchema,
  seq: z.number().int().min(1),
  kind: llmCallKindSchema,
  chunkIndex: z.number().int().min(0).nullable(),
  reusedFromCallId: uuidSchema.nullable(),
  provider: z.string(),
  model: z.string(),
  servedModel: z.string().nullable(),
  promptVersion: z.string(),
  providerRequestId: z.string().nullable(),
  stopReason: z.string().nullable(),
  schemaValid: z.boolean().nullable(),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  costUsd: z.string(),
  latencyMs: z.number().int().min(0).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  request: z.unknown(),
  rawResponse: z.unknown(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
});

export type LlmCallDto = z.infer<typeof llmCallDtoSchema>;

export const reextractQuerySchema = z
  .object({
    reparse: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional()
      .default(false),
  })
  .strict();

export type ReextractQuery = z.infer<typeof reextractQuerySchema>;
