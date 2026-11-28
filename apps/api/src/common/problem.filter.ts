import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { ReqLike, ResLike } from './http.js';
import { buildProblemBody, mapExceptionToProblem } from './problem.js';

/** RFC 9457 `application/problem+json` for every error, with `code` and `requestId`. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const res = http.getResponse<ResLike>();
    const mapped = mapExceptionToProblem(exception);

    if (mapped.unexpected) {
      // Never log request bodies, prompts or parsed text: message + stack only.
      this.logger.error(
        `Unhandled error on ${req.method} ${req.path} [${req.requestId ?? '-'}]: ${
          exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)
        }`,
      );
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    if (mapped.status === 503 || mapped.status === 429) {
      res.setHeader('Retry-After', '5');
    }
    const body = buildProblemBody(mapped, req.originalUrl, req.requestId ?? 'unknown');
    res.statusCode = mapped.status;
    res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    res.send(JSON.stringify(body));
  }
}
