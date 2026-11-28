import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { API_DEPS, type ApiDeps } from './deps.js';
import {
  DocumentTypesController,
  DocumentTypesService,
} from './document-types/document-types.controller.js';
import { DocumentsController } from './documents/documents.controller.js';
import { DocumentsService } from './documents/documents.service.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './health/metrics.controller.js';
import { createPinoHttpOptions } from './observability/logger.js';
import { ApiMetricsService } from './observability/metrics.service.js';
import { RunsController } from './runs/runs.controller.js';
import { RunsService } from './runs/runs.service.js';
import { ApiThrottlerGuard } from './security/throttler.guard.js';
import { ValuesController } from './values/values.controller.js';
import { ValuesService } from './values/values.service.js';
import { VersionsController } from './versions/versions.controller.js';
import { VersionsService } from './versions/versions.service.js';
import { ViewService } from './views/view.service.js';

@Module({})
export class AppModule {
  /** Dependencies are injected so tests can swap the blob store, enqueuer, and health probes. */
  static register(deps: ApiDeps): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: createPinoHttpOptions(deps.config),
        }),
        ThrottlerModule.forRoot([
          {
            name: 'default',
            ttl: 60_000,
            limit: deps.config.THROTTLE_READ_LIMIT,
          },
        ]),
      ],
      controllers: [
        DocumentsController,
        VersionsController,
        ValuesController,
        DocumentTypesController,
        RunsController,
        HealthController,
        MetricsController,
      ],
      providers: [
        { provide: API_DEPS, useValue: deps },
        ApiMetricsService,
        { provide: APP_GUARD, useClass: ApiThrottlerGuard },
        ViewService,
        DocumentsService,
        VersionsService,
        ValuesService,
        DocumentTypesService,
        RunsService,
      ],
    };
  }
}
