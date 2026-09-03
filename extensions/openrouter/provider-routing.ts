// Openrouter provider module implements model/runtime integration.
import { mergeDeep } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";

type OpenRouterProviderConfig = {
  params?: Record<string, unknown>;
};

type OpenRouterExtraParamsContext = {
  config?: {
    models?: {
      providers?: Record<string, OpenRouterProviderConfig>;
    };
  };
  extraParams: Record<string, unknown>;
  provider: string;
  model?: {
    params?: Record<string, unknown>;
  };
};

const BLOCKED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitizeJsonLikeValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonLikeValue).filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return sanitizeRecord(value as Record<string, unknown>);
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !BLOCKED_RECORD_KEYS.has(key) && entry !== undefined)
      .map(([key, entry]) => [key, sanitizeJsonLikeValue(entry)]),
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sanitized = sanitizeRecord(value as Record<string, unknown>);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function resolveOpenRouterProviderConfigParams(
  ctx: OpenRouterExtraParamsContext,
): Record<string, unknown> | undefined {
  const requestedProvider = ctx.provider.trim();
  const normalizedProvider = normalizeProviderId(requestedProvider);
  if (!normalizedProvider) {
    return undefined;
  }

  const providers = Object.entries(ctx.config?.models?.providers ?? {});
  // Preserve routing split across normalized duplicates. Merge aliases in stable
  // raw-key order, then exact-key rows so config insertion order cannot decide conflicts.
  const matchedProviders = providers.filter(
    ([provider]) => normalizeProviderId(provider) === normalizedProvider,
  );
  matchedProviders.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const prioritizedProviders = [
    ...matchedProviders.filter(([provider]) => provider.trim() !== requestedProvider),
    ...matchedProviders.filter(([provider]) => provider.trim() === requestedProvider),
  ];
  let matchedParams: Record<string, unknown> | undefined;
  for (const [, config] of prioritizedProviders) {
    const params = readRecord(config.params);
    if (params) {
      // SAFETY: both inputs are sanitized plain records, so the recursive merge remains a record.
      matchedParams = mergeDeep(matchedParams ?? {}, params) as Record<string, unknown>;
    }
  }
  return matchedParams;
}

function mergeOpenRouterProviderRouting(params: {
  providerParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  extraParams: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const providerRouting = readRecord(params.providerParams?.provider);
  const modelRouting = readRecord(params.modelParams?.provider);
  const extraRouting = readRecord(params.extraParams.provider);
  const merged = {
    ...providerRouting,
    ...modelRouting,
    ...extraRouting,
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveOpenRouterExtraParamsForTransport(
  ctx: OpenRouterExtraParamsContext,
): { patch?: Record<string, unknown> } | undefined {
  const providerConfigParams = resolveOpenRouterProviderConfigParams(ctx);
  const modelParams = readRecord(ctx.model?.params);
  const providerRouting = mergeOpenRouterProviderRouting({
    providerParams: providerConfigParams,
    modelParams,
    extraParams: ctx.extraParams,
  });
  if (!providerConfigParams && !modelParams && !providerRouting) {
    return undefined;
  }
  return {
    patch: {
      ...providerConfigParams,
      ...modelParams,
      ...ctx.extraParams,
      ...(providerRouting ? { provider: providerRouting } : {}),
    },
  };
}
