import { createHash } from 'node:crypto';
import { type PipeTransform } from '@nestjs/common';
import { ProblemError } from './problem.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PDF_HEADER = '%PDF-';
const PDF_EOF = '%%EOF';
const EOF_TAIL_BYTES = 1024;
const MAX_FILENAME_LENGTH = 255;
export const MAX_TITLE_LENGTH = 200;

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

export function sanitizeFilename(raw: string): string {
  // Multer decodes multipart filenames as latin1; recover the UTF-8 name.
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  const base = decoded.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const truncated = [...cleaned].slice(0, MAX_FILENAME_LENGTH).join('');
  return truncated.length > 0 ? truncated : 'document.pdf';
}

export function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.pdf$/i, '').trim();
  const title = [...stem].slice(0, MAX_TITLE_LENGTH).join('').trim();
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
