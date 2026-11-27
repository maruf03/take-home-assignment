import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocumentProxy } from 'unpdf';
import { classifyChildError, PdfParseError } from './errors.js';
import {
  buildDocumentFromPages,
  resolvePdfParseLimits,
  type PdfParseLimits,
  type PdfParseResult,
} from './line-builder.js';
import type { PdfTransform, PdfViewBox, RawPdfPage, RawPdfTextItem } from './ranges.js';

export interface ChildParseTask {
  bytes: Uint8Array;
  limits?: Partial<PdfParseLimits>;
}

let cachedPdfjsAssets: { standardFontDataUrl: string; cMapUrl: string } | null = null;

function resolvePdfjsAssets(): { standardFontDataUrl: string; cMapUrl: string } {
  if (cachedPdfjsAssets) {
    return cachedPdfjsAssets;
  }
  const pkgUrl = import.meta.resolve('pdfjs-dist/package.json');
  const pkgDir = path.dirname(fileURLToPath(pkgUrl));
  cachedPdfjsAssets = {
    standardFontDataUrl: `${path.join(pkgDir, 'standard_fonts')}/`,
    cMapUrl: `${path.join(pkgDir, 'cmaps')}/`,
  };
  return cachedPdfjsAssets;
}

function isTextItemLike(item: unknown): item is {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  dir?: string;
  hasEOL?: boolean;
} {
  return (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof (item as { str?: unknown }).str === 'string' &&
    'transform' in item &&
    Array.isArray((item as { transform?: unknown }).transform) &&
    (item as { transform: unknown[] }).transform.length === 6
  );
}

/**
 * Extracts raw per-page pdfjs text items and view boxes using unpdf + explicit pdfjs-dist font URLs.
 * Always passes a fresh `Uint8Array` copy (pdfjs detaches the underlying buffer) and destroys
 * `pdf.loadingTask` in `finally` (spec §5.1).
 */
export async function extractRawPagesFromPdf(
  bytes: Uint8Array,
  limitOverrides?: Partial<PdfParseLimits>,
): Promise<RawPdfPage[]> {
  const limits = resolvePdfParseLimits(limitOverrides);
  const assets = resolvePdfjsAssets();

  // Pass a copy so pdfjs detaching the ArrayBuffer never affects the caller's bytes.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  const docOptions: Parameters<typeof getDocumentProxy>[1] & { isEvalSupported?: boolean } = {
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: assets.standardFontDataUrl,
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
    verbosity: 0,
  };
  const pdf = await getDocumentProxy(copy, docOptions);

  try {
    if (pdf.numPages > limits.maxPages) {
      throw new PdfParseError(
        'PARSE_LIMIT_EXCEEDED',
        `PDF has ${pdf.numPages} pages, exceeding limit of ${limits.maxPages}`,
        { pageCount: pdf.numPages, maxPages: limits.maxPages },
      );
    }

    const pages: RawPdfPage[] = [];
    let runningRawChars = 0;
    const rawCharHardCap = limits.maxTextChars * 2;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        if (textContent.items.length > limits.maxItemsPerPage) {
          throw new PdfParseError(
            'PARSE_LIMIT_EXCEEDED',
            `Page ${pageNumber} has ${textContent.items.length} text items, exceeding limit of ${limits.maxItemsPerPage}`,
            { pageNumber, itemCount: textContent.items.length },
          );
        }

        const viewRaw = page.view;
        const view: PdfViewBox = [
          viewRaw[0] ?? 0,
          viewRaw[1] ?? 0,
          viewRaw[2] ?? 612,
          viewRaw[3] ?? 792,
        ];

        const items: RawPdfTextItem[] = [];
        for (const raw of textContent.items) {
          if (!isTextItemLike(raw)) {
            continue;
          }
          runningRawChars += raw.str.length;
          if (runningRawChars > rawCharHardCap) {
            throw new PdfParseError(
              'PARSE_LIMIT_EXCEEDED',
              `Extracted text exceeds maximum length of ${limits.maxTextChars} characters`,
              { maxTextChars: limits.maxTextChars },
            );
          }
          const t = raw.transform;
          const transform: PdfTransform = [t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!];
          items.push({
            str: raw.str,
            transform,
            width: typeof raw.width === 'number' ? raw.width : 0,
            height: typeof raw.height === 'number' ? raw.height : 0,
            dir: raw.dir,
            hasEOL: raw.hasEOL,
          });
        }

        pages.push({ pageNumber, view, items });
      } finally {
        page.cleanup();
      }
    }

    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/**
 * Tinypool child_process entry point.
 */
export default async function parsePdfTask(task: ChildParseTask): Promise<PdfParseResult> {
  try {
    const rawPages = await extractRawPagesFromPdf(task.bytes, task.limits);
    return buildDocumentFromPages(rawPages, task.limits);
  } catch (err) {
    throw classifyChildError(err);
  }
}
