export {
  classifyChange,
  decideCarry,
  type BaselineReviewRef,
  type CarryoverContext,
  type ChangeClassification,
} from './carryover/classify.js';
export {
  analyzeLineAnchor,
  countDistinctTokenValues,
  extractDateTokens,
  extractMoneyTokens,
  extractNumberTokens,
  extractPercentTokens,
  extractTypedTokens,
  parseSpelledNumber,
  supportedByString,
  type ExtractedToken,
  type LineAnchorInfo,
} from './evidence/tokenizers.js';
export {
  mergeChunkResults,
  validateExtraction,
  type ValidateExtractionOptions,
} from './evidence/validate.js';
export { scanInstructions, type InstructionScanResult } from './instructions-scan.js';
export {
  buildPrompt,
  buildPromptFromRenderedDocument,
  computeMaxOutputTokens,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  type BuiltPrompt,
} from './prompt/build-prompt.js';
export {
  buildToolSchema,
  MAX_DOCUMENT_FLAG_SPANS,
  MAX_QUOTE_LENGTH,
  parseToolOutput,
  type ParseToolOutputResult,
  type ToolOutputParseError,
} from './prompt/schema.js';
export {
  findLinesTouchingSpan,
  lineIndex,
  lineNumberAtOffset,
  type TextLine,
} from './text/lines.js';
export {
  buildNormIndex,
  findAllNormalizedOccurrences,
  foldCurlyQuotes,
  matchNormalize,
  normSpanToOrigSpan,
  type NormIndex,
} from './text/normalize.js';
export {
  DEFAULT_CHUNK_CHAR_LIMIT,
  DEFAULT_CHUNK_OVERLAP_LINES,
  maskHiddenText,
  planChunks,
  renderPromptDocument,
  type ChunkWindow,
} from './text/render.js';
export type {
  BaselineFieldSnapshot,
  ExtractionTemplateSpec,
  ParsedFieldCandidate,
  ParsedToolOutput,
  TemplateFieldSpec,
  ValidatedFieldResult,
  ValidatedGapResult,
  ValidatedValueResult,
  VisibleEvidenceOccurrence,
} from './types.js';
