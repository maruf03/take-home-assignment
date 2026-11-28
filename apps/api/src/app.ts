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

/** Builds the HTTP app with security headers, trust proxy, pino, throttling, metrics, and Swagger. */
export async function createApiApp(deps: ApiDeps): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    bodyParser: false,
    bufferLogs: deps.config.APP_ENV !== 'test',
    logger: deps.config.APP_ENV === 'test' ? ['error'] : undefined,
  });

  if (deps.config.APP_ENV !== 'test') {
    app.useLogger(app.get(Logger));
  }

  // Spec §8 & apps/api/AGENTS.md: trust X-Forwarded-For ONLY from the fixed compose edge subnet.
  app.set('trust proxy', deps.config.TRUST_PROXY_CIDR);
  app.disable('x-powered-by');

  const apiHelmet = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  const docsHelmet = helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  // Register request-id, baseline headers, helmet, and metrics BEFORE body parsers so 400/413/415 keep them.
  app.use(requestIdMiddleware);
  app.use(baseHeadersMiddleware);
  app.use((req: ReqLike, res: ResLike, next: NextLike) => {
    const middleware =
      req.path === '/docs' || req.path.startsWith('/docs/') ? docsHelmet : apiHelmet;
    middleware(req as never, res as never, next as never);
  });

  const metrics = app.get(ApiMetricsService);
  app.use(createHttpMetricsMiddleware(metrics));

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalFilters(new ProblemFilter());

  await setupSwagger(app);

  return app;
}
