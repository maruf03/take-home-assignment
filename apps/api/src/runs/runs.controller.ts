import {
  listLlmCallsQuerySchema,
  listRunsQuerySchema,
  type ListLlmCallsQuery,
  type ListRunsQuery,
} from '@app/contracts/dto';
import { Controller, Get, Inject, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ParseUuidPipe, ParseVersionNumberPipe } from '../common/id.pipes.js';
import { PaginatedInterceptor } from '../common/paginated.interceptor.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DebugEndpointGuard } from './debug-endpoint.guard.js';
import { RunsService } from './runs.service.js';

@ApiTags('runs')
@Controller('documents/:id/versions/:n/runs')
export class RunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Get()
  @ApiOperation({ summary: 'List extraction runs for a document version' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['running', 'succeeded', 'failed', 'abandoned'],
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated extraction runs' })
  @ApiResponse({ status: 400, description: 'Invalid parameters or cursor' })
  @ApiResponse({ status: 404, description: 'Document or version not found' })
  @UseInterceptors(PaginatedInterceptor)
  list(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('n', new ParseVersionNumberPipe()) n: number,
    @Query(new ZodValidationPipe(listRunsQuerySchema, { kind: 'query' })) query: ListRunsQuery,
  ) {
    return this.runs.listRuns(id, n, query);
  }

  @Get(':runId/calls')
  @UseGuards(DebugEndpointGuard)
  @ApiOperation({ summary: 'List LLM calls for an extraction run (DEBUG_ENDPOINTS only)' })
  @ApiQuery({ name: 'kind', required: false, enum: ['extract', 'repair'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated LLM calls (when DEBUG_ENDPOINTS=true)' })
  @ApiResponse({ status: 404, description: 'Route disabled or run not found' })
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
