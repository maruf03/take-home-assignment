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
  readonly page?: {
    readonly nextCursor?: string | null;
    readonly prevCursor?: string | null;
  };
}

export function buildPageLink(originalUrl: string, cursor: string, rel: 'next' | 'prev'): string {
  const [path = '', rawQuery = ''] = originalUrl.split('?');
  const params = new URLSearchParams(rawQuery);
  params.set('cursor', cursor);
  return `<${path}?${params.toString()}>; rel="${rel}"`;
}

export function buildNextLink(originalUrl: string, nextCursor: string): string {
  return buildPageLink(originalUrl, nextCursor, 'next');
}

/** Emits `Link: <…>; rel="next"` / `rel="prev"` for bidirectional keyset pages. */
@Injectable()
export class PaginatedInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const res = http.getResponse<ResLike>();
    return next.handle().pipe(
      tap((body: unknown) => {
        const page = (body as PageLike | null)?.page;
        const links: string[] = [];
        if (typeof page?.nextCursor === 'string' && page.nextCursor.length > 0) {
          links.push(buildPageLink(req.originalUrl, page.nextCursor, 'next'));
        }
        if (typeof page?.prevCursor === 'string' && page.prevCursor.length > 0) {
          links.push(buildPageLink(req.originalUrl, page.prevCursor, 'prev'));
        }
        if (links.length > 0) {
          res.setHeader('Link', links.join(', '));
        }
      }),
    );
  }
}
