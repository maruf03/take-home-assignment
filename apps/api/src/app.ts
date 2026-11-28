import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { baseHeadersMiddleware, requestIdMiddleware } from './common/request-id.js';
import { ProblemFilter } from './common/problem.filter.js';
import type { ApiDeps } from './deps.js';

const JSON_BODY_LIMIT = '64kb';

/** Builds the HTTP app with the shared middleware, filter and body limits (used by main and tests). */
export async function createApiApp(deps: ApiDeps): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    bodyParser: false,
    logger: deps.config.APP_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  app.disable('x-powered-by');
  // Register request-id and baseline headers BEFORE body parsers so 400/413/415 parse errors keep them.
  app.use(requestIdMiddleware);
  app.use(baseHeadersMiddleware);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalFilters(new ProblemFilter());
  return app;
}
