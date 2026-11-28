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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseUuidPipe } from '../common/id.pipes.js';
import type { ReqLike, ResLike } from '../common/http.js';
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
  @ApiOperation({ summary: 'Approve or correct an extracted value on the reviewable version' })
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
  @UseInterceptors(PaginatedInterceptor)
  reviews(
    @Param('id', new ParseUuidPipe()) id: string,
    @Query(new ZodValidationPipe(listReviewsQuerySchema, { kind: 'query' }))
    query: ListReviewsQuery,
  ) {
    return this.values.reviews(id, query);
  }
}
