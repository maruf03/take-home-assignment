import { Module, type DynamicModule } from '@nestjs/common';
import {
  DocumentTypesController,
  DocumentTypesService,
} from './document-types/document-types.controller.js';
import { API_DEPS, type ApiDeps } from './deps.js';
import { DocumentsController } from './documents/documents.controller.js';
import { DocumentsService } from './documents/documents.service.js';
import { ValuesController } from './values/values.controller.js';
import { ValuesService } from './values/values.service.js';
import { VersionsController } from './versions/versions.controller.js';
import { VersionsService } from './versions/versions.service.js';
import { ViewService } from './views/view.service.js';

@Module({})
export class AppModule {
  /** Dependencies are injected so tests can swap the blob store and the enqueuer. */
  static register(deps: ApiDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        DocumentsController,
        VersionsController,
        ValuesController,
        DocumentTypesController,
      ],
      providers: [
        { provide: API_DEPS, useValue: deps },
        ViewService,
        DocumentsService,
        VersionsService,
        ValuesService,
        DocumentTypesService,
      ],
    };
  }
}
