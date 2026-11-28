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
import { ParseUuidPipe, ParseVersionNumberPipe } from '../common/id.pipes.js';
import type { ReqLike, ResLike } from '../common/http.js';
import { PaginatedInterceptor } from '../common/paginated.interceptor.js';
import { PdfFilePipe, type PdfUpload } from '../common/pdf-file.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UPLOAD_LIMITS } from '../documents/documents.controller.js';
import { VersionsService } from './versions.service.js';

function asciiFallback(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

@Controller('documents/:id/versions')
export class VersionsController {
  constructor(@Inject(VersionsService) private readonly versions: VersionsService) {}

  @Post()
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
  @UseInterceptors(PaginatedInterceptor)
  list(
    @Param('id', new ParseUuidPipe()) id: string,
    @Query(new ZodValidationPipe(listVersionsQuerySchema, { kind: 'query' }))
    query: ListVersionsQuery,
  ) {
    return this.versions.list(id, query);
  }

  @Get(':n')
  detail(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
  ) {
    return this.versions.detail(id, n);
  }

  @Get(':n/values')
  @UseInterceptors(PaginatedInterceptor)
  values(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Query(new ZodValidationPipe(listValuesQuerySchema, { kind: 'query' })) query: ListValuesQuery,
  ) {
    return this.versions.values(id, n, query);
  }

  @Get(':n/text')
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
    if (ifNoneMatch !== undefined && ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);
  }

  @Get(':n/file')
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
    if (ifNoneMatch !== undefined && ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
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
