import { AnthropicProvider } from './anthropic.js';
import { CassetteProvider, type RecordedProviderName } from './cassette.js';
import { LlmError } from './errors.js';
import { FakeIpcLlmProvider } from './fake-ipc.js';
import { FakeLlmProvider, type FakeScriptEntry } from './fake.js';
import { GeminiProvider } from './gemini.js';
import { TEST_ONLY_PROVIDERS, type LlmProvider, type LlmProviderName } from './provider.js';

export interface CreateProviderConfig {
  readonly appEnv: 'development' | 'test' | 'production';
  readonly provider: LlmProviderName;
  readonly geminiApiKey?: string;
  readonly geminiBaseUrl?: string;
  readonly anthropicApiKey?: string;
  readonly anthropicBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly cassettesDir?: string;
  readonly cassetteRecordedProvider?: RecordedProviderName;
  readonly cassetteExpectedPromptVersion?: string;
  readonly fakeScript?: readonly FakeScriptEntry[];
  readonly fakeIpcEndpoint?: string;
}

/**
 * Factory creating the configured `LlmProvider`.
 * Strictly refuses `fake`, `fake-ipc`, and `cassette` unless `appEnv === 'test'` (AGENTS.md #9, [I8]).
 */
export function createProvider(config: CreateProviderConfig): LlmProvider {
  if (TEST_ONLY_PROVIDERS.has(config.provider) && config.appEnv !== 'test') {
    throw new LlmError(
      'BAD_REQUEST',
      `LLM provider "${config.provider}" is only allowed when APP_ENV=test (current APP_ENV="${config.appEnv}")`,
      { transient: false },
    );
  }

  switch (config.provider) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: config.geminiApiKey ?? '',
        baseUrl: config.geminiBaseUrl,
        timeoutMs: config.timeoutMs,
      });

    case 'anthropic':
      return new AnthropicProvider({
        apiKey: config.anthropicApiKey ?? '',
        baseURL: config.anthropicBaseUrl,
        timeoutMs: config.timeoutMs,
      });

    case 'fake':
      return new FakeLlmProvider({ script: config.fakeScript });

    case 'fake-ipc':
      return new FakeIpcLlmProvider({ endpoint: config.fakeIpcEndpoint ?? '' });

    case 'cassette':
      if (!config.cassettesDir) {
        throw new LlmError('BAD_REQUEST', 'CassetteProvider requires cassettesDir', {
          transient: false,
        });
      }
      return new CassetteProvider({
        cassettesDir: config.cassettesDir,
        recordedProvider: config.cassetteRecordedProvider ?? 'gemini',
        expectedPromptVersion: config.cassetteExpectedPromptVersion,
      });

    default: {
      const unknownProvider: string = config.provider;
      throw new LlmError('BAD_REQUEST', `Unsupported LLM provider "${unknownProvider}"`, {
        transient: false,
      });
    }
  }
}
