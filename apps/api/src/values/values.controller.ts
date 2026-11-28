import {
  createReviewRequestSchema,
  listReviewsQuerySchema,
  type CreateReviewRequest,
  type ListReviewsQuery,
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
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ReqLike, ResLike } from '../common/http.js';
import { ParseUuidPipe } from '../common/id.pipes.js';
import { PaginatedInterceptor } from '../common/paginated.interceptor.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ThrottleGroup } from '../security/throttler.guard.js';
import { ValuesService } from './values.service.js';

@ApiTags('values')
@Controller('values')
export class ValuesController {
  constructor(@Inject(ValuesService) private readonly values: ValuesService) {}

  @Post(':id/review')
  @ThrottleGroup('review')
  @ApiOperation({
    summary: 'Approve, correct, or revert an extracted value on the reviewable version',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['decision'],
      properties: {
        decision: { type: 'string', enum: ['approve', 'correct', 'revert'] },
        correctedValue: {},
        note: { type: 'string', maxLength: 1000 },
        expectedCurrentReviewId: { type: 'string', format: 'uuid', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Review recorded' })
  @ApiResponse({ status: 200, description: 'Identical review no-op' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 404, description: 'Value not found' })
  @ApiResponse({ status: 409, description: 'Version not reviewable or review conflict' })
  @ApiResponse({ status: 422, description: 'Invalid typed correction' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async review(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(createReviewRequestSchema)) body: CreateReviewRequest,
    @Req() req: ReqLike,
    @Res() res: ResLike,
  ): Promise<void> {
    const result = await this.values.review(id, body, req.requestId ?? 'unknown');
    res.status(result.status).json(result.body);
  }

  @Get(':id/reviews')
  @ApiOperation({ summary: 'List append-only review history for an extracted value' })
  @ApiQuery({ name: 'origin', required: false, enum: ['human', 'carried'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated review history' })
  @ApiResponse({ status: 404, description: 'Value not found' })
  @UseInterceptors(PaginatedInterceptor)
  reviews(
    @Param('id', new ParseUuidPipe()) id: string,
    @Query(new ZodValidationPipe(listReviewsQuerySchema, { kind: 'query' }))
    query: ListReviewsQuery,
  ) {
    return this.values.reviews(id, query);
  }
}
