import { Inject, Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import {
  PdfParserPool,
  type PdfParseLimits,
  type PdfParseResult,
  type PdfParser,
  type PdfParserPoolOptions,
} from '@app/pdf';

export const PARSE_POOL_OPTIONS = Symbol('PARSE_POOL_OPTIONS');

/**
 * Implements `OnApplicationShutdown` (NOT `OnModuleDestroy`) so child parse workers stay alive
 * while `BullExplorer.onModuleDestroy()` drains active BullMQ jobs before teardown.
 */
@Injectable()
export class ParsePoolService implements PdfParser, OnApplicationShutdown {
  private readonly pool: PdfParserPool;

  constructor(@Optional() @Inject(PARSE_POOL_OPTIONS) options?: PdfParserPoolOptions) {
    this.pool = new PdfParserPool(options);
  }

  parse(
    pdfBytes: Uint8Array,
    limits?: Partial<PdfParseLimits>,
    signal?: AbortSignal,
  ): Promise<PdfParseResult> {
    return this.pool.parse(pdfBytes, limits, signal);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.close();
  }
}
