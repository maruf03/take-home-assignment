import {
  createDocumentMetadataSchema,
  listDocumentsQuerySchema,
  type CreateDocumentMetadata,
  type ListDocumentsQuery,
} from '@app/contracts/dto';
import {
  Body,
  Controller,
  Get,
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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseUuidPipe } from '../common/id.pipes.js';
import type { ReqLike, ResLike } from '../common/http.js';
import { PaginatedInterceptor } from '../common/paginated.interceptor.js';
import { MAX_UPLOAD_BYTES, PdfFilePipe, type PdfUpload } from '../common/pdf-file.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ThrottleGroup } from '../security/throttler.guard.js';
import { DocumentsService } from './documents.service.js';

export const UPLOAD_LIMITS = {
  fileSize: MAX_UPLOAD_BYTES,
  files: 1,
  fields: 5,
  fieldSize: 1024,
  parts: 8,
} as const;

@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Post()
  @ThrottleGroup('upload')
  @ApiOperation({ summary: 'Upload a PDF and create a new document (queued for extraction)' })
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS, defParamCharset: 'utf8' }))
  async create(
    @UploadedFile(new PdfFilePipe()) upload: PdfUpload,
    @Body(new ZodValidationPipe(createDocumentMetadataSchema)) meta: CreateDocumentMetadata,
    @Req() req: ReqLike,
    @Res() res: ResLike,
  ): Promise<void> {
    const detail = await this.documents.create(upload, meta, req.requestId ?? 'unknown');
    res.setHeader('Location', `/documents/${detail.id}`);
    res.status(201).json(detail);
  }

  @Get()
  @UseInterceptors(PaginatedInterceptor)
  list(
    @Query(new ZodValidationPipe(listDocumentsQuerySchema, { kind: 'query' }))
    query: ListDocumentsQuery,
  ) {
    return this.documents.list(query);
  }

  // Declared before `:id` so Express never matches "facets" as an id (spec §7.5).
  @Get('facets')
  facets() {
    return this.documents.facets();
  }

  @Get(':id')
  detail(@Param('id', new ParseUuidPipe()) id: string) {
    return this.documents.detail(id);
  }

  @Get(':id/progress')
  progress(@Param('id', new ParseUuidPipe()) id: string) {
    return this.documents.progress(id);
  }
}
