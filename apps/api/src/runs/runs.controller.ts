import {
  listLlmCallsQuerySchema,
  listRunsQuerySchema,
  type ListLlmCallsQuery,
  type ListRunsQuery,
} from '@app/contracts/dto';
import { Controller, Get, Inject, Param, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseUuidPipe, ParseVersionNumberPipe } from '../common/id.pipes.js';
import { PaginatedInterceptor } from '../common/paginated.interceptor.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RunsService } from './runs.service.js';

@ApiTags('runs')
@Controller('documents/:id/versions/:n/runs')
export class RunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Get()
  @ApiOperation({ summary: 'List extraction runs for a document version' })
  @UseInterceptors(PaginatedInterceptor)
  list(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Query(new ZodValidationPipe(listRunsQuerySchema, { kind: 'query' })) query: ListRunsQuery,
  ) {
    return this.runs.listRuns(id, n, query);
  }

  @Get(':runId/calls')
  @ApiOperation({ summary: 'List LLM calls for an extraction run (DEBUG_ENDPOINTS only)' })
  @UseInterceptors(PaginatedInterceptor)
  calls(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Param('runId', new ParseUuidPipe()) runId: string,
    @Query(new ZodValidationPipe(listLlmCallsQuerySchema, { kind: 'query' }))
    query: ListLlmCallsQuery,
  ) {
    return this.runs.listCalls(id, n, runId, query);
  }
}
