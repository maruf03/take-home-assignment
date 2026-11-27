import type { LlmUsage } from './provider.js';

export interface ModelPricingRate {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  readonly cacheCreationMultiplier?: number;
  readonly cacheReadMultiplier?: number;
}

const PRICING_TABLE: Readonly<Record<string, ModelPricingRate>> = {
  // Gemini Flash family (USD per 1M tokens)
  'gemini-3.5-flash': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'gemini-3.6-flash': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'gemini-3.5-flash-lite': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-3.1-flash-lite': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-2.5-flash': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  // Anthropic Claude 5.5 family (USD per 1M tokens)
  'claude-sonnet-5-5': {
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
    cacheCreationMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  'claude-haiku-5-5': {
    inputPerMillionUsd: 0.8,
    outputPerMillionUsd: 4.0,
    cacheCreationMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  'claude-opus-5-5': {
    inputPerMillionUsd: 15.0,
    outputPerMillionUsd: 75.0,
    cacheCreationMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
};

function lookupPricingRate(model: string): ModelPricingRate | undefined {
  const exact = PRICING_TABLE[model];
  if (exact) {
    return exact;
  }
  for (const [key, rate] of Object.entries(PRICING_TABLE)) {
    if (model.startsWith(`${key}-`)) {
      return rate;
    }
  }
  return undefined;
}

/**
 * Estimates USD cost for an LLM call. Keyed on the requested model (`LLM_MODEL`) with fallback
 * to `servedModel` when an unknown requested alias is supplied (spec §15.5).
 */
export function estimateCostUsd(
  usage: LlmUsage,
  requestedModel: string,
  servedModel?: string | null,
): number {
  const rate =
    lookupPricingRate(requestedModel) ?? (servedModel ? lookupPricingRate(servedModel) : undefined);
  if (!rate) {
    return 0;
  }

  const perM = 1_000_000;
  const inputCost = (Math.max(0, usage.inputTokens) / perM) * rate.inputPerMillionUsd;
  const outputCost = (Math.max(0, usage.outputTokens) / perM) * rate.outputPerMillionUsd;
  const cacheCreateCost =
    usage.cacheCreationInputTokens && rate.cacheCreationMultiplier
      ? (Math.max(0, usage.cacheCreationInputTokens) / perM) *
        rate.inputPerMillionUsd *
        rate.cacheCreationMultiplier
      : 0;
  const cacheReadCost =
    usage.cacheReadInputTokens && rate.cacheReadMultiplier
      ? (Math.max(0, usage.cacheReadInputTokens) / perM) *
        rate.inputPerMillionUsd *
        rate.cacheReadMultiplier
      : 0;

  return Number((inputCost + outputCost + cacheCreateCost + cacheReadCost).toFixed(6));
}
