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
 * Provider-specific context overflow patterns not covered by the generic
 * `isContextOverflowError()` in errors.ts. Called from `isContextOverflowError()`
 * to catch provider-specific wording that the generic regex misses.
 */
const PROVIDER_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  // AWS Bedrock validation / stream errors use provider-specific wording.
  /\binput token count exceeds the maximum number of input tokens\b/i,
  /\binput is too long for this model\b/i,

  // Google Vertex / Gemini REST surfaces this wording.
  /\binput exceeds the maximum number of tokens\b/i,

  // Ollama may append a provider prefix and extra token wording.
  /\bollama error:\s*context length exceeded(?:,\s*too many tokens)?\b/i,

  // Cohere does not currently ship a bundled provider hook.
  /\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i,

  // llama.cpp HTTP server (often used directly or behind an OpenAI-compatible
  // shim) returns "request (N tokens) exceeds the available context size
  // (M tokens), try increasing it" when the prompt overshoots a slot's
  // ctx-size. Wording is from the upstream slot manager and is stable.
  // Example: "400 request (66202 tokens) exceeds the available context size (65536 tokens), try increasing it"
  /\b(?:request|prompt) \(\d[\d,]*\s*tokens?\) exceeds (?:the )?available context size\b/i,

  // Generic "input too long" pattern that isn't covered by existing checks
  /\binput (?:is )?too long for (?:the )?model\b/i,
];

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
      matchesLegacyProviderContextOverflow(errorMessage))
  );
}
export function matchesLegacyProviderContextOverflow(errorMessage: string): boolean {
  return (
    looksLikeProviderContextOverflowCandidate(errorMessage) &&
    PROVIDER_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))
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
