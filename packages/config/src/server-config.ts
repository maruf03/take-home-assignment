import { z } from 'zod';

export type AppEnv = 'development' | 'test' | 'production';

export const appEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const DEV_DEFAULT_SECRETS: readonly string[] = Object.freeze([
  'dev-postgres',
  'dev-migrator',
  'dev-app',
  'dev-redis',
  'dev-s3-key',
  'dev-s3-secret',
  'dev-secret',
  'changeme',
]);

const TEST_ONLY_LLM_PROVIDERS = new Set(['fake', 'fake-ipc', 'cassette']);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface DefineServerConfigOptions {
  env?: Record<string, string | undefined>;
  denylist?: readonly string[];
  onWarn?: (message: string) => void;
}

let hasWarnedDefaultLogger = false;

export function resetDevDefaultWarningForTests(): void {
  hasWarnedDefaultLogger = false;
}

function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function extractUrlCredentials(value: string): string[] {
  const candidates: string[] = [];
  try {
    const parsedUrl = new URL(value);
    if (parsedUrl.username) {
      candidates.push(safeDecodeURIComponent(parsedUrl.username));
    }
    if (parsedUrl.password) {
      candidates.push(safeDecodeURIComponent(parsedUrl.password));
    }
    return candidates;
  } catch {
    // Fallback for multi-host or Unix-socket URIs (e.g. postgresql://user:pass@h1:5432,h2:5432/db
    // or postgresql://user:pass@/db?host=/var/run/postgresql) which Node's WHATWG URL rejects.
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@]*)@/i.exec(value);
    if (!match?.[1]) {
      return candidates;
    }
    const userinfo = match[1];
    const colonIdx = userinfo.indexOf(':');
    if (colonIdx === -1) {
      candidates.push(safeDecodeURIComponent(userinfo));
    } else {
      const user = userinfo.slice(0, colonIdx);
      const pass = userinfo.slice(colonIdx + 1);
      if (user) candidates.push(safeDecodeURIComponent(user));
      if (pass) candidates.push(safeDecodeURIComponent(pass));
    }
    return candidates;
  }
}

function matchesDenylist(value: string, denylistLower: ReadonlySet<string>): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }
  if (denylistLower.has(trimmed)) {
    return true;
  }
  if (trimmed.includes('://')) {
    for (const credential of extractUrlCredentials(value.trim())) {
      const normalized = credential.trim().toLowerCase();
      if (normalized.length > 0 && denylistLower.has(normalized)) {
        return true;
      }
    }
  }
  return false;
}

function findDenylistedKeys(
  value: unknown,
  denylistLower: ReadonlySet<string>,
  prefix: string,
  out: string[],
): void {
  if (typeof value === 'string') {
    if (matchesDenylist(value, denylistLower)) {
      out.push(prefix || '<root>');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findDenylistedKeys(item, denylistLower, `${prefix}[${index}]`, out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = prefix ? `${prefix}.${key}` : key;
      findDenylistedKeys(nested, denylistLower, nextPath, out);
    }
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (nested !== null && typeof nested === 'object' && !Object.isFrozen(nested)) {
        deepFreeze(nested);
      }
    }
  }
  return value;
}

export function defineServerConfig<TSchema extends z.ZodType>(
  schema: TSchema,
  options: DefineServerConfigOptions = {},
): Readonly<z.output<TSchema>> {
  const rawEnv = options.env ?? process.env;
  const result = schema.safeParse(rawEnv);

  if (!result.success) {
    const issueSummary = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid server configuration: ${issueSummary}`);
  }

  const parsed = result.data;
  const parsedRecord =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;

  const parsedAppEnv =
    typeof parsedRecord?.['APP_ENV'] === 'string' && parsedRecord['APP_ENV'].trim().length > 0
      ? parsedRecord['APP_ENV'].trim()
      : undefined;
  const envAppEnv =
    typeof rawEnv['APP_ENV'] === 'string' && rawEnv['APP_ENV'].trim().length > 0
      ? rawEnv['APP_ENV'].trim()
      : undefined;
  const appEnvRaw = parsedAppEnv ?? envAppEnv ?? 'development';

  const llmProvider = parsedRecord?.['LLM_PROVIDER'];
  if (typeof llmProvider === 'string') {
    const normalizedProvider = llmProvider.trim().toLowerCase();
    if (TEST_ONLY_LLM_PROVIDERS.has(normalizedProvider) && appEnvRaw !== 'test') {
      throw new ConfigError(
        `LLM_PROVIDER="${llmProvider}" is only permitted when APP_ENV=test (current APP_ENV="${appEnvRaw}")`,
      );
    }
  }

  const denylist = options.denylist ?? DEV_DEFAULT_SECRETS;
  const denylistLower = new Set(denylist.map((entry) => entry.trim().toLowerCase()));
  const offendingKeys: string[] = [];
  findDenylistedKeys(parsed, denylistLower, '', offendingKeys);

  if (offendingKeys.length > 0) {
    if (appEnvRaw === 'production') {
      throw new ConfigError(
        `Refusing to boot under APP_ENV=production with dev-default secrets configured for: ${offendingKeys.join(', ')}`,
      );
    }
    const warning = `Warning: dev-default secrets are active in ${appEnvRaw} mode for: ${offendingKeys.join(', ')}`;
    if (options.onWarn) {
      options.onWarn(warning);
    } else if (!hasWarnedDefaultLogger) {
      hasWarnedDefaultLogger = true;
      console.warn(warning);
    }
  }

  return deepFreeze(parsed);
}
