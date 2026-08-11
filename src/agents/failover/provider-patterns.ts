import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { resolveNodeRequireFromMeta } from "../../logging/node-require.js";
import { isRateLimitErrorMessage } from "./message-patterns.js";
import type { FailoverReason } from "./signal.js";
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

function resolveProviderRuntimeHooks(): ProviderRuntimeHooks | null {
  if (cachedProviderRuntimeHooks !== undefined) {
    return cachedProviderRuntimeHooks;
  }
  if (!requireProviderRuntime) {
    cachedProviderRuntimeHooks = null;
    return cachedProviderRuntimeHooks;
  }
  try {
    cachedProviderRuntimeHooks = requireProviderRuntime(
      "../../plugins/provider-runtime.js",
    ) as unknown as ProviderRuntimeHooks;
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
  return (
    resolveProviderRuntimeHooks()?.classifyProviderFailoverSignalWithPlugin({
      provider: context.provider,
      context,
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
