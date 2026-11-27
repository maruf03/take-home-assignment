export { extractRawPagesFromPdf, type ChildParseTask } from './child.js';
export {
  classifyChildError,
  isPdfParseErrorCode,
  PDF_PARSE_ERROR_CODES,
  PdfParseError,
  type PdfParseErrorCode,
} from './errors.js';
export {
  buildDocumentFromPages,
  cleanPdfText,
  DEFAULT_PDF_PARSE_LIMITS,
  PARSER_ID,
  resolvePdfParseLimits,
  type PdfParseLimits,
  type PdfParseResult,
} from './line-builder.js';
export { PdfParserPool, type PdfParser, type PdfParserPoolOptions } from './pool.js';
export {
  effectiveFontSize,
  isLowVisibilityItem,
  isOffPageItem,
  isRotatedItem,
  LOW_VISIBILITY_FONT_PT,
  mergeHiddenRanges,
  mergeLowVisibilityRanges,
  type HiddenRange,
  type LowVisibilityRange,
  type PdfTransform,
  type PdfViewBox,
  type RawPdfPage,
  type RawPdfTextItem,
} from './ranges.js';
export {
  DEFAULT_MAX_RSS_BYTES,
  DEFAULT_WATCHDOG_POLL_MS,
  readProcessRssBytes,
  RssWatchdog,
  type RssWatchdogOptions,
  type WatchdogWorkerRef,
} from './watchdog.js';
