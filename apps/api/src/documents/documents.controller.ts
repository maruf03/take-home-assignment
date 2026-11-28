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
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { ReqLike, ResLike } from '../common/http.js';
import { ParseUuidPipe } from '../common/id.pipes.js';
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
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        type: { type: 'string' },
        title: { type: 'string', maxLength: 200 },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Document created and queued' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 413, description: 'File exceeds 10 MB' })
  @ApiResponse({ status: 415, description: 'Not a valid PDF' })
  @ApiResponse({ status: 422, description: 'Unknown document type or missing template' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
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
  @ApiOperation({ summary: 'List alive documents with forward keyset pagination and filters' })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiQuery({ name: 'needsReview', required: false, type: Boolean })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['queued', 'extracting', 'extracted', 'failed'],
  })
  @ApiQuery({ name: 'externalId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated document summaries' })
  @ApiResponse({ status: 400, description: 'Invalid query or cursor' })
  @UseInterceptors(PaginatedInterceptor)
  list(
    @Query(new ZodValidationPipe(listDocumentsQuerySchema, { kind: 'query' }))
    query: ListDocumentsQuery,
  ) {
    return this.documents.list(query);
  }

  // Declared before `:id` so Express never matches "facets" as an id (spec §7.5).
  @Get('facets')
  @ApiOperation({ summary: 'Get capped (<=100) count of documents needing review' })
  @ApiResponse({ status: 200, description: 'Needs-review facet count' })
  facets() {
    return this.documents.facets();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get document detail including values, valuesTextMeta, and recent versions',
  })
  @ApiResponse({ status: 200, description: 'Document detail snapshot' })
  @ApiResponse({ status: 400, description: 'Invalid document UUID' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  detail(@Param('id', new ParseUuidPipe()) id: string) {
    return this.documents.detail(id);
  }

  @Get(':id/progress')
  @ApiOperation({ summary: 'Get disjoint review progress counts for the reviewable version' })
  @ApiResponse({ status: 200, description: 'Progress summary' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  progress(@Param('id', new ParseUuidPipe()) id: string) {
    return this.documents.progress(id);
  }
}
