import { createHash } from 'node:crypto';
import { type PipeTransform } from '@nestjs/common';
import { ProblemError } from './problem.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PDF_HEADER = '%PDF-';
const PDF_EOF = '%%EOF';
const EOF_TAIL_BYTES = 1024;
const MAX_FILENAME_BYTES = 255;
export const MAX_TITLE_LENGTH = 200;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

export interface PdfUpload {
  readonly buffer: Buffer;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly originalFilename: string;
}

export interface UploadedFileLike {
  readonly buffer: Buffer;
  readonly size: number;
  readonly originalname: string;
}

function truncateByUtf8Bytes(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) {
    return input;
  }
  let out = '';
  let usedBytes = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(input)) {
    const segBytes = Buffer.byteLength(segment, 'utf8');
    if (usedBytes + segBytes > maxBytes) {
      break;
    }
    out += segment;
    usedBytes += segBytes;
  }
  return out;
}

function truncateByGraphemeAndLength(input: string, maxUnits: number): string {
  if (input.length <= maxUnits) {
    return input;
  }
  let out = '';
  let graphemes = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(input)) {
    if (graphemes + 1 > maxUnits || out.length + segment.length > maxUnits) {
      break;
    }
    out += segment;
    graphemes += 1;
  }
  return out;
}

export function sanitizeFilename(raw: string): string {
  // Multer/busboy uses defParamCharset: 'utf8', so `raw` is already UTF-8.
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(CONTROL_CHARS_RE, '').normalize('NFC').trim();
  const truncated = truncateByUtf8Bytes(cleaned, MAX_FILENAME_BYTES).trim();
  return truncated.length > 0 ? truncated : 'document.pdf';
}

export function titleFromFilename(filename: string): string {
  const normalized = sanitizeFilename(filename);
  const stem = normalized.replace(/\.pdf$/i, '').trim();
  const title = truncateByGraphemeAndLength(stem, MAX_TITLE_LENGTH).trim();
  return title.length > 0 ? title : 'Untitled document';
}

/** Validates one in-memory PDF upload: size, `%PDF-` at offset 0 and `%%EOF` in the tail. */
export class PdfFilePipe implements PipeTransform<UploadedFileLike | undefined, PdfUpload> {
  transform(file: UploadedFileLike | undefined): PdfUpload {
    if (!file) {
      throw new ProblemError('VALIDATION_FAILED', 'A single multipart "file" part is required', {
        errors: [{ path: 'file', message: 'Required' }],
      });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ProblemError('FILE_TOO_LARGE', 'PDF exceeds the 10 MB upload limit');
    }
    const { buffer } = file;
    const head = buffer.subarray(0, PDF_HEADER.length).toString('latin1');
    const tail = buffer.subarray(Math.max(0, buffer.length - EOF_TAIL_BYTES)).toString('latin1');
    if (head !== PDF_HEADER || !tail.includes(PDF_EOF)) {
      throw new ProblemError('UNSUPPORTED_MEDIA_TYPE', 'Upload is not a valid PDF file');
    }
    return {
      buffer,
      sizeBytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      originalFilename: sanitizeFilename(file.originalname),
    };
  }
}
