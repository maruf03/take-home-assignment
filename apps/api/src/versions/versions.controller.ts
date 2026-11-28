import {
  listValuesQuerySchema,
  listVersionsQuerySchema,
  reextractQuerySchema,
  type ListValuesQuery,
  type ListVersionsQuery,
  type ReextractQuery,
} from '@app/contracts/dto';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { ReqLike, ResLike } from '../common/http.js';
import { ParseUuidPipe, ParseVersionNumberPipe } from '../common/id.pipes.js';
import { PaginatedInterceptor } from '../common/paginated.interceptor.js';
import { PdfFilePipe, type PdfUpload } from '../common/pdf-file.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UPLOAD_LIMITS } from '../documents/documents.controller.js';
import { ThrottleGroup } from '../security/throttler.guard.js';
import { VersionsService } from './versions.service.js';

function asciiFallback(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

/** RFC 9110 §13.1.2 weak ETag comparison (`*` or optional leading `W/`). */
export function ifNoneMatchMatches(header: string | undefined, strongEtag: string): boolean {
  if (header === undefined) return false;
  const target = strongEtag.replace(/^W\//, '');
  return header.split(',').some((raw) => {
    const token = raw.trim();
    return token === '*' || token.replace(/^W\//, '') === target;
  });
}

@ApiTags('versions')
@Controller('documents/:id/versions')
export class VersionsController {
  constructor(@Inject(VersionsService) private readonly versions: VersionsService) {}

  @Post()
  @ThrottleGroup('upload')
  @ApiOperation({ summary: 'Upload a new PDF version for an existing document (with dedupe)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 201, description: 'New version created and queued' })
  @ApiResponse({ status: 200, description: 'Deduplicated against latest non-failed upload' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @ApiResponse({ status: 413, description: 'File exceeds 10 MB' })
  @ApiResponse({ status: 415, description: 'Not a valid PDF' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS, defParamCharset: 'utf8' }))
  async create(
    @Param('id', new ParseUuidPipe()) id: string,
    @UploadedFile(new PdfFilePipe()) upload: PdfUpload,
    @Req() req: ReqLike,
    @Res() res: ResLike,
  ): Promise<void> {
    const result = await this.versions.create(id, upload, req.requestId ?? 'unknown');
    if (result.status === 201) {
      res.setHeader('Location', `/documents/${id}/versions/${result.versionNumber}`);
    }
    res.status(result.status).json(result.body);
  }

  @Get()
  @ApiOperation({ summary: 'List versions of a document (newest first)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['queued', 'extracting', 'extracted', 'failed'],
  })
  @ApiQuery({ name: 'origin', required: false, enum: ['upload', 'reextract'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated version summaries' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  @UseInterceptors(PaginatedInterceptor)
  list(
    @Param('id', new ParseUuidPipe()) id: string,
    @Query(new ZodValidationPipe(listVersionsQuerySchema, { kind: 'query' }))
    query: ListVersionsQuery,
  ) {
    return this.versions.list(id, query);
  }

  @Get(':n')
  @ApiOperation({ summary: 'Get detail, values, progress, and file metadata for a version' })
  @ApiResponse({ status: 200, description: 'Version detail' })
  @ApiResponse({ status: 404, description: 'Document or version not found' })
  detail(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
  ) {
    return this.versions.detail(id, n);
  }

  @Get(':n/values')
  @ApiOperation({ summary: 'List extracted values for a version ordered by template position' })
  @ApiQuery({
    name: 'reviewState',
    required: false,
    enum: ['pending', 'approved', 'corrected', 'carried_over'],
  })
  @ApiQuery({ name: 'attention', required: false, enum: ['changed', 'gap', 'pending', 'done'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated extracted values' })
  @ApiResponse({ status: 404, description: 'Document or version not found' })
  @UseInterceptors(PaginatedInterceptor)
  values(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Query(new ZodValidationPipe(listValuesQuerySchema, { kind: 'query' })) query: ListValuesQuery,
  ) {
    return this.versions.values(id, n, query);
  }

  @Get(':n/text')
  @ApiOperation({ summary: 'Download parsed plain text for a version (ETag + 304)' })
  @ApiResponse({ status: 200, description: 'Parsed UTF-8 plain text' })
  @ApiResponse({ status: 304, description: 'Not modified' })
  @ApiResponse({ status: 404, description: 'Document or version not found' })
  @ApiResponse({ status: 409, description: 'Parsed text not yet available' })
  async text(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: ResLike,
  ): Promise<void> {
    const { text, sha256 } = await this.versions.text(id, n);
    const etag = `"${sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);
  }

  @Get(':n/file')
  @ApiOperation({ summary: 'Download original PDF bytes for a version (sandboxed attachment)' })
  @ApiResponse({ status: 200, description: 'Original PDF binary' })
  @ApiResponse({ status: 304, description: 'Not modified' })
  @ApiResponse({ status: 404, description: 'Document or version not found' })
  async file(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: ResLike,
  ): Promise<void> {
    const { bytes, sha256, filename } = await this.versions.file(id, n);
    const etag = `"${sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.status(200).send(bytes);
  }

  @Post(':n/retry')
  @HttpCode(202)
  @ThrottleGroup('upload')
  @ApiOperation({ summary: 'Retry a failed version (resets attempts to 0 and re-enqueues)' })
  @ApiResponse({ status: 202, description: 'Version re-queued for extraction' })
  @ApiResponse({ status: 404, description: 'Document or version not found' })
  @ApiResponse({ status: 409, description: 'Version is not in failed status' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async retry(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Req() req: ReqLike,
    @Res() res: ResLike,
  ): Promise<void> {
    const summary = await this.versions.retry(id, n, req.requestId ?? 'unknown');
    res.status(202).json(summary);
  }

  @Post(':n/reextract')
  @ThrottleGroup('upload')
  @ApiOperation({ summary: 'Create a new version re-extracting a terminal version' })
  @ApiQuery({ name: 'reparse', required: false, type: Boolean })
  @ApiResponse({ status: 201, description: 'New reextract version created and queued' })
  @ApiResponse({ status: 404, description: 'Document or version not found' })
  @ApiResponse({ status: 409, description: 'Source version is not terminal' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async reextract(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Query(new ZodValidationPipe(reextractQuerySchema, { kind: 'query' })) query: ReextractQuery,
    @Req() req: ReqLike,
    @Res() res: ResLike,
  ): Promise<void> {
    const summary = await this.versions.reextract(id, n, query.reparse, req.requestId ?? 'unknown');
    res.setHeader('Location', `/documents/${id}/versions/${summary.number}`);
    res.status(201).json(summary);
  }
}
