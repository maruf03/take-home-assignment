import type { ProblemCode, VersionErrorCode } from './problems.js';
import type { ChangeReason, GapCode, ValueFlag } from './status.js';

export type UiCopyKey =
  | `gap.${GapCode}`
  | `change.${ChangeReason}`
  | `flag.${ValueFlag}`
  | `versionError.${VersionErrorCode}`
  | `problem.${ProblemCode}`;

export const uiCopy: Readonly<Record<UiCopyKey, string>> = Object.freeze({
  // Gap codes (spec §14.3)
  'gap.NOT_FOUND': 'Not found in the document.',
  'gap.MODEL_OMITTED': "The model didn't return this field.",
  'gap.EVIDENCE_NOT_IN_TEXT':
    "The model's quote doesn't appear in this document, so the value was discarded.",
  'gap.VALUE_NOT_SUPPORTED':
    "The quoted text doesn't contain this value, so the value was discarded.",
  'gap.UNPARSEABLE_VALUE': "The model returned a value that isn't a valid {type}.",
  'gap.EVIDENCE_HIDDEN': 'The only supporting text is invisible in the PDF; possible tampering.',
  'gap.CONFLICTING_EVIDENCE':
    'Different parts of the document give different values: {v1} (line a), {v2} (line b).',

  // Change reasons (spec §14.3)
  'change.VALUE_CHANGED': 'Value changed from v{n}.',
  'change.EVIDENCE_CHANGED': 'Same value, but its source text changed.',
  'change.GAP_INVOLVED': 'Was missing in v{n} or is missing now.',
  'change.WEAK_EVIDENCE_LINE': 'Source line has no label; please re-confirm.',
  'change.PARSER_CHANGED': 'Re-extracted with a newer text reader; please re-confirm.',
  'change.POSSIBLE_AMENDMENT': "A new line mentions '{label}' with a different value.",
  'change.CONFLICTING_EVIDENCE':
    'Another line with the same label gives a different value; please re-confirm.',
  'change.EVIDENCE_HIDDEN':
    'The previous supporting line is now hidden in the PDF; please re-confirm.',
  'change.TYPE_CHANGED': 'Field type changed in the template.',

  // Value flags (spec §14.2)
  'flag.LOW_VISIBILITY': 'Text is very small or faint in the PDF.',
  'flag.AMBIGUOUS_OCCURRENCE': 'The same quote appears on multiple lines in the document.',
  'flag.TOKEN_AMBIGUOUS': 'Multiple candidate values appear inside the quoted text.',
  'flag.AMBIGUOUS_DATE': 'Numeric date format is ambiguous; interpreted using template date order.',
  'flag.QUOTE_FOLDED': 'Matched after normalizing curly quotation marks in the quote.',
  'flag.WEAK_EVIDENCE_LINE': 'Source line contains no surrounding label text.',
  'flag.CONFLICTING_LINES': 'Another line with the same label has a different value.',
  'flag.LINE_HINT_MISMATCH': 'Matched on a different line number than the model cited.',

  // Version error codes (spec §14.3)
  'versionError.PARSE_NO_TEXT':
    "This PDF has no text layer (likely a scan). OCR isn't supported yet.",
  'versionError.PARSE_ENCRYPTED': 'This PDF is password-protected.',
  'versionError.PARSE_MALFORMED': "This PDF couldn't be read.",
  'versionError.PARSE_CRASHED': "This PDF couldn't be read.",
  'versionError.PARSE_TIMEOUT': 'This PDF is too large or complex (limit 200 pages).',
  'versionError.PARSE_LIMIT_EXCEEDED': 'This PDF is too large or complex (limit 200 pages).',
  'versionError.LLM_NOT_CONFIGURED':
    "Extraction isn't configured (missing API key). Ask an admin, then Retry.",
  'versionError.LLM_AUTH': 'The AI provider rejected the request.',
  'versionError.LLM_BAD_REQUEST': 'The AI provider rejected the request.',
  'versionError.LLM_SCHEMA_INVALID':
    'The AI returned an unusable answer. Retry usually fixes this.',
  'versionError.LLM_TRUNCATED': 'The AI returned an unusable answer. Retry usually fixes this.',
  'versionError.LLM_REFUSED': 'The AI returned an unusable answer. Retry usually fixes this.',
  'versionError.LLM_RATE_CAPPED':
    "The AI provider's usage limit was reached. Try again later or contact an admin.",
  'versionError.LLM_CALL_CAP': 'Extraction failed repeatedly. Retry, or contact support.',
  'versionError.MAX_ATTEMPTS': 'Extraction failed repeatedly. Retry, or contact support.',
  'versionError.STORAGE_UNAVAILABLE': "The stored file couldn't be read.",
  'versionError.INTEGRITY_MISMATCH': "The stored file couldn't be read.",
  'versionError.DOCUMENT_DELETED': 'Stopped because the document was deleted.',

  // Problem codes (spec §7.3 / §14.4)
  'problem.VALIDATION_FAILED': 'Some input fields are invalid.',
  'problem.INVALID_ID': 'The requested identifier is not a valid UUID.',
  'problem.INVALID_CURSOR': 'The pagination cursor is invalid.',
  'problem.CURSOR_MISMATCH': 'The pagination cursor does not match the current filters or sort.',
  'problem.INVALID_LIMIT': 'Page limit must be between 1 and 100.',
  'problem.INVALID_SORT': 'The requested sort field is not supported.',
  'problem.INVALID_FILTER': 'One or more filter values are not supported.',
  'problem.DOCUMENT_NOT_FOUND': 'Document not found.',
  'problem.VERSION_NOT_FOUND': 'Document version not found.',
  'problem.VALUE_NOT_FOUND': 'Extracted value not found.',
  'problem.RUN_NOT_FOUND': 'Extraction run not found.',
  'problem.ROUTE_NOT_FOUND': 'Endpoint not found.',
  'problem.VERSION_NOT_REVIEWABLE':
    'A newer version became reviewable. Reloaded to show the latest version.',
  'problem.REVIEW_CONFLICT': 'Another review was saved first. Review the latest state below.',
  'problem.NOTHING_TO_REVERT': 'This value is already pending review.',
  'problem.NOT_RETRYABLE': 'Only failed versions can be retried.',
  'problem.VERSION_NOT_TERMINAL': 'Wait for the current extraction to finish before re-extracting.',
  'problem.TEXT_NOT_AVAILABLE': 'Parsed text is not available for this version yet.',
  'problem.IDEMPOTENCY_KEY_IN_USE': 'A matching request is already in progress. Please retry.',
  'problem.DOCUMENT_DELETED': 'This document has been deleted.',
  'problem.FILE_TOO_LARGE': 'This file exceeds the 10 MB PDF upload limit.',
  'problem.UNSUPPORTED_MEDIA_TYPE': 'Only PDF files are supported.',
  'problem.UNKNOWN_DOCUMENT_TYPE': 'Unknown document type.',
  'problem.NO_TEMPLATE_FOR_TYPE': 'No extraction template is configured for this document type.',
  'problem.INVALID_CORRECTION': 'The corrected value does not match this field type.',
  'problem.IDEMPOTENCY_KEY_REUSED':
    'This idempotency key was already used with a different request.',
  'problem.RATE_LIMITED': 'Too many requests. Please wait a moment and try again.',
  'problem.INTERNAL': 'Something went wrong on the server. Please try again.',
  'problem.STORAGE_UNAVAILABLE': 'Document storage is temporarily unavailable. Please retry.',
  'problem.DATABASE_UNAVAILABLE': "Can't reach the server, retrying…",
});

export function getUiCopy(key: UiCopyKey): string {
  return uiCopy[key];
}
