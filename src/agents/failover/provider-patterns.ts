import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveNodeRequireFromMeta } from "../../logging/node-require.js";
import { isRateLimitErrorMessage } from "./message-patterns.js";
import { FAILOVER_REASONS, type FailoverReason } from "./signal.js";
type ProviderErrorPattern = {
  /** Regex to match against the raw error message. */
  test: RegExp;
  /** The failover reason this pattern maps to. */
  reason: FailoverReason;
};
/**
 * Provider-specific patterns that map to specific failover reasons.
 * These handle cases where the generic message tables produce wrong results
 * for specific providers.
 */
const PROVIDER_SPECIFIC_PATTERNS: readonly ProviderErrorPattern[] = [
  {
    test: /\bworkers_ai\b.*\bquota limit exceeded\b/i,
    reason: "rate_limit",
  },
  {
    test: /\bmodelnotreadyexception\b/i,
    reason: "overloaded",
  },
  // Groq does not currently ship a bundled provider hook.
  {
    test: /model(?:_is)?_deactivated|model has been deactivated/i,
    reason: "model_not_found",
  },
];

type ProviderRuntimeHooks = {
  classifyProviderFailoverSignalWithPlugin: (params: {
    provider?: string;
    context: ProviderSpecificErrorContext;
  }) => FailoverReason | null | undefined;
};

const requireProviderRuntime = resolveNodeRequireFromMeta(import.meta.url);
let cachedProviderRuntimeHooks: ProviderRuntimeHooks | null | undefined;
const PROVIDER_CONTEXT_OVERFLOW_SIGNAL_RE =
  /\b(?:context|window|prompt|token|tokens|input|request|model)\b/i;
const PROVIDER_CONTEXT_OVERFLOW_ACTION_RE =
  /\b(?:too\s+(?:large|long|many)|exceed(?:s|ed|ing)?|overflow|limit|maximum|max)\b/i;

function isFailoverReason(value: unknown): value is FailoverReason {
  return typeof value === "string" && FAILOVER_REASONS.some((reason) => reason === value);
}

function resolveProviderRuntimeHooks(): ProviderRuntimeHooks | null {
  if (cachedProviderRuntimeHooks !== undefined) {
    return cachedProviderRuntimeHooks;
  }
  if (!requireProviderRuntime) {
    cachedProviderRuntimeHooks = null;
    return cachedProviderRuntimeHooks;
  }
  try {
    const runtime: unknown = requireProviderRuntime("../../plugins/provider-runtime.js");
    const classify = isRecord(runtime) ? runtime.classifyProviderFailoverSignalWithPlugin : null;
    if (typeof classify !== "function") {
      cachedProviderRuntimeHooks = null;
      return cachedProviderRuntimeHooks;
    }
    cachedProviderRuntimeHooks = {
      classifyProviderFailoverSignalWithPlugin: (params) => {
        const result: unknown = classify(params);
        return result === null || result === undefined || isFailoverReason(result)
          ? result
          : undefined;
      },
    };
  } catch {
    cachedProviderRuntimeHooks = null;
  }
  return cachedProviderRuntimeHooks ?? null;
}

export function looksLikeProviderContextOverflowCandidate(errorMessage: string): boolean {
  return (
    !isRateLimitErrorMessage(errorMessage) &&
    PROVIDER_CONTEXT_OVERFLOW_SIGNAL_RE.test(errorMessage) &&
    PROVIDER_CONTEXT_OVERFLOW_ACTION_RE.test(errorMessage)
  );
}

type ProviderSpecificErrorContext = {
  provider?: string;
  modelId?: string;
  errorMessage: string;
  status?: number;
  code?: string;
  errorType?: string;
  providerPlugin?: PreparedProviderFailoverOwner;
};
export type PreparedProviderFailoverOwner = {
  id: string;
  matchesContextOverflowError?: (ctx: ProviderSpecificErrorContext) => boolean | undefined;
  classifyFailoverReason?: (ctx: ProviderSpecificErrorContext) => FailoverReason | null | undefined;
};

function normalizeProviderSpecificErrorContext(
  input: string | ProviderSpecificErrorContext,
): ProviderSpecificErrorContext {
  return typeof input === "string" ? { errorMessage: input } : input;
}
/**
 * Check if an error message matches any provider-specific context overflow pattern.
 * Called from `isContextOverflowError()` to catch provider-specific wording.
 */
export function matchesProviderContextOverflow(errorMessage: string): boolean {
  return (
    looksLikeProviderContextOverflowCandidate(errorMessage) &&
    (classifyProviderPluginError({ errorMessage }) === "context_overflow" ||
      matchesContextOverflowMessage(errorMessage, "provider-fallback"))
  );
}
export function classifyProviderPluginError(
  input: string | ProviderSpecificErrorContext,
): FailoverReason | null {
  const context = normalizeProviderSpecificErrorContext(input);
  const { providerPlugin, ...providerContext } = context;
  if (providerPlugin) {
    const ownedContext = { ...providerContext, provider: providerPlugin.id };
    if (providerPlugin.matchesContextOverflowError?.(ownedContext)) {
      return "context_overflow";
    }
    return providerPlugin.classifyFailoverReason?.(ownedContext) ?? null;
  }
  return (
    resolveProviderRuntimeHooks()?.classifyProviderFailoverSignalWithPlugin({
      provider: context.provider,
      context: providerContext,
    }) ?? null
  );
}
/**
 * Try to classify an error using provider-specific patterns.
 * Returns null if no provider-specific pattern matches (fall through to generic classification).
 */
export function classifyProviderSpecificError(
  input: string | ProviderSpecificErrorContext,
  opts?: { includePluginHooks?: boolean },
): FailoverReason | null {
  const context = normalizeProviderSpecificErrorContext(input);
  return (
    (opts?.includePluginHooks === false ? null : classifyProviderPluginError(context)) ??
    classifyLegacyProviderSpecificError(context)
  );
}
export function classifyLegacyProviderSpecificError(
  context: ProviderSpecificErrorContext,
): FailoverReason | null {
  for (const pattern of PROVIDER_SPECIFIC_PATTERNS) {
    if (pattern.test.test(context.errorMessage)) {
      return pattern.reason;
    }
  }
  return null;
}
