import type { NextLike, ReqLike, ResLike } from '../common/http.js';
import type { ApiMetricsService } from './metrics.service.js';

interface ExpressReqWithRoute extends ReqLike {
  baseUrl?: string;
  route?: { path?: string };
}

interface ExpressResWithFinish extends ResLike {
  on(event: 'finish', listener: () => void): void;
}

/** Records `http_request_duration_seconds{method,route,status}` with bounded route labels. */
export function createHttpMetricsMiddleware(metrics: ApiMetricsService) {
  return (req: ExpressReqWithRoute, res: ExpressResWithFinish, next: NextLike): void => {
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      const routePath =
        req.route?.path !== undefined ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      metrics.observeHttpRequest(req.method, routePath, res.statusCode, durationSec);
    });
    next();
  };
}
