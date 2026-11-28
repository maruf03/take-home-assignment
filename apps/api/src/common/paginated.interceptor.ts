import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';
import type { ReqLike, ResLike } from './http.js';

interface PageLike {
  readonly page?: { readonly nextCursor?: string | null };
}

export function buildNextLink(originalUrl: string, nextCursor: string): string {
  const [path = '', rawQuery = ''] = originalUrl.split('?');
  const params = new URLSearchParams(rawQuery);
  params.set('cursor', nextCursor);
  return `<${path}?${params.toString()}>; rel="next"`;
}

/** Emits `Link: <…>; rel="next"` for forward-only keyset pages (spec §7.2, Core). */
@Injectable()
export class PaginatedInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const res = http.getResponse<ResLike>();
    return next.handle().pipe(
      tap((body: unknown) => {
        const nextCursor = (body as PageLike | null)?.page?.nextCursor;
        if (typeof nextCursor === 'string' && nextCursor.length > 0) {
          res.setHeader('Link', buildNextLink(req.originalUrl, nextCursor));
        }
      }),
    );
  }
}
