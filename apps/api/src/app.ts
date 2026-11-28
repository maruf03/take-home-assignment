import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { NextLike, ReqLike, ResLike } from './common/http.js';
import { ProblemFilter } from './common/problem.filter.js';
import { baseHeadersMiddleware, requestIdMiddleware } from './common/request-id.js';
import type { ApiDeps } from './deps.js';
import { createHttpMetricsMiddleware } from './observability/metrics.middleware.js';
import { ApiMetricsService } from './observability/metrics.service.js';
import { setupSwagger } from './swagger.js';

const JSON_BODY_LIMIT = '64kb';
const DOCS_ASSET_PATH_RE = /^\/docs\/[^/]+$/;

function isDocsRoute(pathname: string): boolean {
  return pathname === '/docs' || pathname === '/docs/' || DOCS_ASSET_PATH_RE.test(pathname);
}

/** Builds the HTTP app with security headers, trust proxy, pino, throttling, metrics, and Swagger. */
export async function createApiApp(deps: ApiDeps): Promise<NestExpressApplication> {
  const usePino = deps.config.LOG_LEVEL !== 'silent';
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    bodyParser: false,
    bufferLogs: usePino,
    logger: usePino ? undefined : ['error'],
  });

  if (usePino) {
    app.useLogger(app.get(Logger));
  }

  // Spec §8 & apps/api/AGENTS.md: trust X-Forwarded-For ONLY from the fixed compose edge subnet.
  app.set('trust proxy', deps.config.TRUST_PROXY_CIDR);
  app.disable('x-powered-by');

  const apiHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  const docsHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  // Register request-id, baseline headers, helmet, and metrics BEFORE body parsers so 400/413/415 keep them.
  app.use(requestIdMiddleware);
  app.use(baseHeadersMiddleware);
  app.use((req: ReqLike, res: ResLike, next: NextLike) => {
    const middleware = isDocsRoute(req.path) ? docsHelmet : apiHelmet;
    middleware(req as never, res as never, next as never);
  });

  const metrics = app.get(ApiMetricsService);
  app.use(createHttpMetricsMiddleware(metrics));

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalFilters(new ProblemFilter());

  await setupSwagger(app);

  return app;
}
