import { z } from 'zod';
import { dateOrderSchema, fieldTypeSchema } from '../status.js';
import {
  DOCUMENT_TYPE_KEY_REGEX_SOURCE,
  FIELD_KEY_REGEX_SOURCE,
  isoCurrencySchema,
} from '../values.js';

export const documentTypeKeySchema = z
  .string()
  .regex(new RegExp(DOCUMENT_TYPE_KEY_REGEX_SOURCE), 'Invalid document type key');

export const fieldKeySchema = z
  .string()
  .regex(new RegExp(FIELD_KEY_REGEX_SOURCE), 'Invalid field key');

export const templateFieldDtoSchema = z.object({
  fieldKey: fieldKeySchema,
  fieldType: fieldTypeSchema,
  position: z.number().int().min(1).max(100),
  label: z.string().min(1),
  description: z.string().nullable(),
});

export type TemplateFieldDto = z.infer<typeof templateFieldDtoSchema>;

export const extractionTemplateDtoSchema = z.object({
  version: z.number().int().min(1),
  defaultCurrency: isoCurrencySchema,
  dateOrder: dateOrderSchema,
  fields: z.array(templateFieldDtoSchema),
});

export type ExtractionTemplateDto = z.infer<typeof extractionTemplateDtoSchema>;

export const documentTypeDtoSchema = z.object({
  key: documentTypeKeySchema,
  displayName: z.string().min(1),
  template: extractionTemplateDtoSchema,
});

export type DocumentTypeDto = z.infer<typeof documentTypeDtoSchema>;
