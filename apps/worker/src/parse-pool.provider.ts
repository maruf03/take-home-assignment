import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import {
  PdfParserPool,
  type PdfParseLimits,
  type PdfParseResult,
  type PdfParser,
  type PdfParserPoolOptions,
} from '@app/pdf';

export const PARSE_POOL_OPTIONS = Symbol('PARSE_POOL_OPTIONS');

@Injectable()
export class ParsePoolService implements PdfParser, OnModuleDestroy {
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

  async onModuleDestroy(): Promise<void> {
    await this.pool.close();
  }
}
