import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * Loads generated Swagger CLI plugin metadata if present (spec A10 / ADR-0009) and falls back
 * cleanly to an empty metadata map when running from source without a generated `metadata.ts`.
 */
export async function loadApiPluginMetadata(): Promise<void> {
  await SwaggerModule.loadPluginMetadata(async () => {
    try {
      const modulePath = './metadata.js';
      const mod = (await import(modulePath)) as {
        default?: () => Promise<Record<string, unknown>>;
      };
      if (typeof mod.default === 'function') {
        return await mod.default();
      }
    } catch {
      // Generated `src/metadata.ts` is optional in dev/test runs; decorators supply core metadata.
    }
    return { '@nestjs/swagger': { models: [], controllers: [] } };
  });
}

export async function buildOpenApiDocument(app: INestApplication): Promise<OpenAPIObject> {
  await loadApiPluginMetadata();
  const builder = new DocumentBuilder()
    .setTitle('Document Review API')
    .setDescription(
      'Document upload, structured LLM extraction, verbatim evidence review, and version carry-over API.',
    )
    .setVersion('1.0.0')
    .addTag('documents')
    .addTag('versions')
    .addTag('values')
    .addTag('document-types')
    .addTag('runs')
    .addTag('health')
    .build();
  return SwaggerModule.createDocument(app, builder);
}

export async function setupSwagger(app: INestApplication): Promise<OpenAPIObject> {
  const document = await buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: {
      persistAuthorization: false,
    },
  });
  return document;
}
