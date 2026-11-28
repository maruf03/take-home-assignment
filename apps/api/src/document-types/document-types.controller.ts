import type { DocumentTypeDto } from '@app/contracts/dto';
import { listQuery, type Page } from '@app/contracts/page';
import { listDocumentTypesWithTemplates, withReadOnlyTx } from '@app/db';
import { Controller, Get, Inject, Injectable, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { PaginatedInterceptor } from '../common/paginated.interceptor.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { API_DEPS, type ApiDeps } from '../deps.js';

const listDocumentTypesQuerySchema = listQuery();
type ListDocumentTypesQuery = z.infer<typeof listDocumentTypesQuerySchema>;

@Injectable()
export class DocumentTypesService {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  list(query: ListDocumentTypesQuery): Promise<Page<DocumentTypeDto>> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      const page = await listDocumentTypesWithTemplates(tx, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return {
        data: page.data.map((t) => ({
          key: t.key,
          displayName: t.displayName,
          template: {
            version: t.template.version,
            defaultCurrency: t.template.defaultCurrency,
            dateOrder: t.template.dateOrder as DocumentTypeDto['template']['dateOrder'],
            fields: t.template.fields.map((f) => ({
              fieldKey: f.fieldKey,
              fieldType: f.fieldType as DocumentTypeDto['template']['fields'][number]['fieldType'],
              position: f.position,
              label: f.label,
              description: f.description ?? null,
            })),
          },
        })),
        page: page.page,
      };
    });
  }
}

@ApiTags('document-types')
@Controller('document-types')
export class DocumentTypesController {
  constructor(@Inject(DocumentTypesService) private readonly types: DocumentTypesService) {}

  @Get()
  @ApiOperation({ summary: 'List supported document types and their latest extraction templates' })
  @UseInterceptors(PaginatedInterceptor)
  list(
    @Query(new ZodValidationPipe(listDocumentTypesQuerySchema, { kind: 'query' }))
    query: ListDocumentTypesQuery,
  ) {
    return this.types.list(query);
  }
}
