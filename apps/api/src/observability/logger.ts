import type { DestinationStream, Logger } from 'pino';
import pino from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { ApiConfig } from '../config.js';

/** Spec §8 & §9: redact credentials, keys, prompts, parsed text, and raw LLM responses. */
export const API_LOG_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.GEMINI_API_KEY',
  '*.ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.prompt',
  'prompt',
  '*.parsedText',
  'parsedText',
  '*.rawResponse',
  'rawResponse',
  '*.note',
];

export interface CreateApiPinoLoggerOptions {
  readonly level?: string;
  readonly destination?: DestinationStream;
}

export function createApiPinoLogger(options: CreateApiPinoLoggerOptions = {}): Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? 'info',
    redact: {
      paths: API_LOG_REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

export function createPinoHttpOptions(config: ApiConfig): PinoHttpOptions {
  const logger = createApiPinoLogger({ level: config.LOG_LEVEL });
  return {
    logger,
    genReqId: (req) => (req as { requestId?: string }).requestId ?? 'unknown',
    customProps: (req) => ({
      requestId: (req as { requestId?: string }).requestId ?? 'unknown',
    }),
    serializers: {
      req: (req: { id?: unknown; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode?: number }) => ({
        statusCode: res.statusCode,
      }),
    },
    autoLogging: config.LOG_LEVEL !== 'silent',
  };
}
