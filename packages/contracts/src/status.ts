import { z } from 'zod';

export const FIELD_TYPES = ['string', 'date', 'money', 'number', 'percent'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const fieldTypeSchema = z.enum(FIELD_TYPES);

export const DATE_ORDERS = ['MDY', 'DMY', 'YMD'] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];
export const dateOrderSchema = z.enum(DATE_ORDERS);

export const VERSION_ORIGINS = ['upload', 'reextract'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];
export const versionOriginSchema = z.enum(VERSION_ORIGINS);

export const VERSION_STATUSES = ['queued', 'extracting', 'extracted', 'failed'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export const versionStatusSchema = z.enum(VERSION_STATUSES);

export const VERSION_WARNINGS = [
  'SUSPICIOUS_INSTRUCTIONS',
  'MULTI_COLUMN',
  'ROTATED_TEXT',
  'HIDDEN_TEXT_PRESENT',
  'CHUNKED',
] as const;
export type VersionWarning = (typeof VERSION_WARNINGS)[number];
export const versionWarningSchema = z.enum(VERSION_WARNINGS);

export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'abandoned'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const runStatusSchema = z.enum(RUN_STATUSES);

export const RUN_TRIGGERS = [
  'upload',
  'sweep',
  'retry',
  'redelivery',
  'reextract',
  'restore',
] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const runTriggerSchema = z.enum(RUN_TRIGGERS);

export const LLM_CALL_KINDS = ['extract', 'repair', 'chunk'] as const;
export type LlmCallKind = (typeof LLM_CALL_KINDS)[number];
export const llmCallKindSchema = z.enum(LLM_CALL_KINDS);

export const EXTRACTED_VALUE_KINDS = ['value', 'gap'] as const;
export type ExtractedValueKind = (typeof EXTRACTED_VALUE_KINDS)[number];
export const extractedValueKindSchema = z.enum(EXTRACTED_VALUE_KINDS);

export const MATCH_MODES = ['strict', 'quote_folded'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];
export const matchModeSchema = z.enum(MATCH_MODES);

export const GAP_CODES = [
  'NOT_FOUND',
  'MODEL_OMITTED',
  'EVIDENCE_NOT_IN_TEXT',
  'VALUE_NOT_SUPPORTED',
  'UNPARSEABLE_VALUE',
  'EVIDENCE_HIDDEN',
  'CONFLICTING_EVIDENCE',
] as const;
export type GapCode = (typeof GAP_CODES)[number];
export const gapCodeSchema = z.enum(GAP_CODES);

export const VALUE_FLAGS = [
  'LOW_VISIBILITY',
  'AMBIGUOUS_OCCURRENCE',
  'TOKEN_AMBIGUOUS',
  'AMBIGUOUS_DATE',
  'QUOTE_FOLDED',
  'WEAK_EVIDENCE_LINE',
  'CONFLICTING_LINES',
  'LINE_HINT_MISMATCH',
] as const;
export type ValueFlag = (typeof VALUE_FLAGS)[number];
export const valueFlagSchema = z.enum(VALUE_FLAGS);

export const CHANGE_KINDS = ['new', 'same', 'changed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const changeKindSchema = z.enum(CHANGE_KINDS);

export const CHANGE_REASONS = [
  'VALUE_CHANGED',
  'EVIDENCE_CHANGED',
  'GAP_INVOLVED',
  'WEAK_EVIDENCE_LINE',
  'PARSER_CHANGED',
  'POSSIBLE_AMENDMENT',
  'CONFLICTING_EVIDENCE',
  'EVIDENCE_HIDDEN',
  'TYPE_CHANGED',
] as const;
export type ChangeReason = (typeof CHANGE_REASONS)[number];
export const changeReasonSchema = z.enum(CHANGE_REASONS);

export const REVIEW_DECISIONS = ['approve', 'correct', 'revert'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export const reviewDecisionSchema = z.enum(REVIEW_DECISIONS);

export const CORE_REVIEW_DECISIONS = ['approve', 'correct'] as const;
export type CoreReviewDecision = (typeof CORE_REVIEW_DECISIONS)[number];
export const coreReviewDecisionSchema = z.enum(CORE_REVIEW_DECISIONS);

export const REVIEW_ORIGINS = ['human', 'carried'] as const;
export type ReviewOrigin = (typeof REVIEW_ORIGINS)[number];
export const reviewOriginSchema = z.enum(REVIEW_ORIGINS);

export const REVIEW_STATES = ['pending', 'approved', 'corrected', 'carried_over'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const reviewStateSchema = z.enum(REVIEW_STATES);

export const ATTENTION_BUCKETS = ['changed', 'gap', 'pending', 'done'] as const;
export type AttentionBucket = (typeof ATTENTION_BUCKETS)[number];
export const attentionBucketSchema = z.enum(ATTENTION_BUCKETS);

export const IDEMPOTENCY_SCOPES = [
  'create_document',
  'create_version',
  'reextract',
  'review',
  'retry',
] as const;
export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[number];
export const idempotencyScopeSchema = z.enum(IDEMPOTENCY_SCOPES);
