import { randomUUID } from 'node:crypto';
import type { NextLike, ReqLike, ResLike } from './http.js';

export const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && REQUEST_ID_REGEX.test(candidate) ? candidate : randomUUID();
}

/** Accepts a valid inbound `X-Request-Id` or generates one, and echoes it on the response. */
export function requestIdMiddleware(req: ReqLike, res: ResLike, next: NextLike): void {
  const requestId = resolveRequestId(req.headers['x-request-id']);
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

/** Baseline response headers for every reply (Helmet-level hardening lands in Task 10). */
export function baseHeadersMiddleware(req: ReqLike, res: ResLike, next: NextLike): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
}
