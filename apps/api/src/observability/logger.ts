import type { DestinationStream, Logger } from 'pino';
import pino from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { ApiConfig } from '../config.js';

const SENSITIVE_KEYS = [
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'S3_SECRET_KEY',
  'S3_ACCESS_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'apiKey',
  'password',
  'secret',
  'prompt',
  'parsedText',
  'parsed_text',
  'rawResponse',
  'raw_response',
  'request',
  'note',
  'correctedValue',
  'originalFilename',
  'filename',
] as const;

/**
 * Spec §8 & §9: redact credentials, keys, prompts, parsed text, filenames, notes, and raw LLM
 * payloads across top-level, multi-depth nested, error, and array paths.
 */
export const API_LOG_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [
    key,
    `*.${key}`,
    `*.*.${key}`,
    `*.*.*.${key}`,
    `*[*].${key}`,
    `err.${key}`,
    `err.*.${key}`,
    `err.config.${key}`,
  ]),
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
