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
      // Structured log so pino object redaction covers error fields; never logs bodies/prompts.
      this.logger.error(
        {
          err: exception instanceof Error ? exception : new Error(String(exception)),
          requestId: req.requestId ?? '-',
          method: req.method,
          path: req.path,
        },
        'Unhandled API error',
      );
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    if ((mapped.status === 503 || mapped.status === 429) && !res.getHeader('Retry-After')) {
      res.setHeader('Retry-After', '5');
    }
    const body = buildProblemBody(mapped, req.originalUrl, req.requestId ?? 'unknown');
    res.statusCode = mapped.status;
    res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    res.send(JSON.stringify(body));
  }
}
