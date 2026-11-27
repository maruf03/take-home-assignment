import { z } from 'zod';
import { versionErrorCodeSchema } from '../problems.js';

export const uuidSchema = z.uuid();
export const isoTimestampSchema = z.iso.datetime({ offset: true });

export const hiddenTextRangeSchema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
  z.string().min(1),
]);

export const lowVisibilityRangeSchema = z.tuple([z.number().int().min(0), z.number().int().min(0)]);

export const textRangesSchema = z.object({
  hidden: z.array(hiddenTextRangeSchema),
  lowVisibility: z.array(lowVisibilityRangeSchema),
});

export type TextRanges = z.infer<typeof textRangesSchema>;

export const valuesTextMetaSchema = z.object({
  textRanges: textRangesSchema,
  pageOffsets: z.array(z.number().int().min(0)),
});

export type ValuesTextMeta = z.infer<typeof valuesTextMetaSchema>;

export const versionErrorSchema = z.object({
  code: versionErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

export type VersionError = z.infer<typeof versionErrorSchema>;

export const progressSchema = z.object({
  versionNumber: z.number().int().min(1).nullable(),
  pending: z.number().int().min(0),
  approved: z.number().int().min(0),
  corrected: z.number().int().min(0),
  carriedOver: z.number().int().min(0),
  total: z.number().int().min(0),
  gaps: z.number().int().min(0),
});

export type Progress = z.infer<typeof progressSchema>;
