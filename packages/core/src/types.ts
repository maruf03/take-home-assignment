import type {
  DateOrder,
  ExtractedValueKind,
  FieldType,
  GapCode,
  MatchMode,
  ValueFlag,
} from '@app/contracts/status';
import type { TypedValue } from '@app/contracts/values';

export interface TemplateFieldSpec {
  fieldKey: string;
  fieldType: FieldType;
  position: number;
  label: string;
  description?: string | null;
}

export interface ExtractionTemplateSpec {
  id?: string;
  documentType: string;
  version?: number;
  instructions?: string | null;
  defaultCurrency: string;
  dateOrder: DateOrder;
  fields: readonly TemplateFieldSpec[];
}

export interface ParsedFieldCandidate {
  found: boolean;
  value: TypedValue | string | { amount: string; currency: string } | null;
  rawValue: string | null;
  quote: string | null;
  line: number | null;
  notFoundReason: string | null;
}

export interface ParsedToolOutput {
  fields: Record<string, ParsedFieldCandidate>;
  documentFlags: {
    suspiciousInstructions: boolean;
    spans: string[];
  };
}

export interface VisibleEvidenceOccurrence {
  start: number;
  end: number;
  line: number;
  canonicalEvidence: string;
}

export interface ValidatedValueResult {
  fieldKey: string;
  fieldType: FieldType;
  kind: 'value';
  value: TypedValue;
  rawValue: string;
  evidence: string;
  canonicalEvidence: string;
  evidenceStart: number;
  evidenceEnd: number;
  evidenceMatchCount: number;
  citedLine: number | null;
  matchMode: MatchMode;
  chunkIndex: number | null;
  gapCode: null;
  gapReason: null;
  attemptedQuote: null;
  flags: ValueFlag[];
  visibleOccurrences: VisibleEvidenceOccurrence[];
}

export interface ValidatedGapResult {
  fieldKey: string;
  fieldType: FieldType;
  kind: 'gap';
  value: null;
  rawValue: string | null;
  evidence: null;
  attemptedQuote: string | null;
  canonicalEvidence: null;
  evidenceStart: null;
  evidenceEnd: null;
  evidenceMatchCount: null;
  citedLine: number | null;
  matchMode: null;
  chunkIndex: number | null;
  gapCode: GapCode;
  gapReason: string;
  flags: ValueFlag[];
  visibleOccurrences: [];
}

export type ValidatedFieldResult = ValidatedValueResult | ValidatedGapResult;

export interface BaselineFieldSnapshot {
  id: string;
  fieldKey: string;
  fieldType: FieldType;
  kind: ExtractedValueKind;
  value: TypedValue | null;
  canonicalEvidence: string | null;
  flags: readonly ValueFlag[];
}
