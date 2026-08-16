// Overflow helpers classify provider overflow errors and retryable responses.
import type { AssistantMessage } from "../types.js";

const CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE =
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i;

/** Detects DS4-style raw token-count context overflow errors. */
export function isConfiguredContextSizeOverflowError(errorMessage: string): boolean {
  return CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE.test(errorMessage);
}

/**
 * Canonical scoped patterns for context overflow errors from different providers.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - Cerebras: "413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: May return "tokens in request more than max tokens allowed" (code 1210),
 *   "Prompt exceeds max length" (code 1261), or accept overflow silently; handled via the
 *   error patterns or usage.input > contextWindow
 * - Xiaomi MiMo: Truncates input to fill contextWindow exactly, then returns finish_reason "length"
 *   with output=0 (no room left to generate). Detected via stopReason "length" + zero output +
 *   input filling the context window.
 * - Ollama: Some deployments truncate silently, others return errors like "prompt too long; exceeded max context length by X tokens"
 */
const ASSISTANT_OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input length and `?max_tokens`? exceed context limit: [\d,]+ \+ [\d,]+ > [\d,]+/i, // Anthropic direct API
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (all backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /tokens? in request more than max tokens? allowed/i, // Z.AI / Zhipu GLM error 1210
  /prompt exceeds max(?:imum)? length/i, // Z.AI / Zhipu GLM error 1261
  /too large for model with \d+ maximum context length/i, // Mistral
  CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  /^413\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 413 with no body
];

const FAILOVER_EXPLICIT_OVERFLOW_PATTERNS = [
  /request_too_large/i, // Anthropic request byte-size overflow
  /context_overflow/i,
  CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE, // DS4 server
  /invalid_argument[\s\S]*maximum number of tokens/i, // Google/Vertex
  /request exceeds the maximum size/i, // Anthropic
  /context length exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /prompt too long/i,
  /exceeds model context window/i,
  /model token limit/i,
  /input exceeds[\s\S]*maximum number of tokens/i,
  /^(?=[\s\S]*context window)(?=[\s\S]*ran out of (?:room|space))/i, // Codex
  /request size exceeds[\s\S]*context window/i,
  /context overflow:/i,
  /exceed context limit/i,
  /exceeds the model'?s maximum context/i,
  /max_tokens[\s\S]*exceed[\s\S]*context/i,
  /input length[\s\S]*exceed[\s\S]*context/i,
  /413[\s\S]*too large/i,
  /context_window_exceeded/i,
  // FIXED(refactor-06): PR 2 removed the embedded-429 false positive; this is provider overflow.
  /input length [\d,]+\s+tokens? exceeds the model limit/i,
  /上下文过长|上下文超出|上下文长度超|超出最大上下文|请压缩上下文/,
];

const PROVIDER_FALLBACK_OVERFLOW_PATTERNS = [
  /\binput token count exceeds the maximum number of input tokens\b/i, // AWS Bedrock
  /\binput is too long for this model\b/i, // AWS Bedrock stream errors
  /\binput exceeds the maximum number of tokens\b/i, // Google Vertex / Gemini
  /\bollama error:\s*context length exceeded(?:,\s*too many tokens)?\b/i,
  /\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i, // Cohere
  /\b(?:request|prompt) \(\d[\d,]*\s*tokens?\) exceeds (?:the )?available context size\b/i, // llama.cpp
  /\binput (?:is )?too long for (?:the )?model\b/i,
];

const CONTEXT_OVERFLOW_PATTERN_SCOPES = {
  "assistant-error": ASSISTANT_OVERFLOW_PATTERNS,
  "failover-explicit": FAILOVER_EXPLICIT_OVERFLOW_PATTERNS,
  "provider-fallback": PROVIDER_FALLBACK_OVERFLOW_PATTERNS,
  "failover-hint": [
    /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i,
  ],
  "context-window-too-small": [/context window.*(too small|minimum is)/i],
  "tpm-rate-limit-hint": [/\btpm\b|tokens per minute/i],
  "rate-limit-hint": [
    /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i,
  ],
} as const;

export type ContextOverflowMessageScope = keyof typeof CONTEXT_OVERFLOW_PATTERN_SCOPES;

/** Match one canonical context-overflow wording scope without applying caller policy. */
export function matchesContextOverflowMessage(
  errorMessage: string,
  scope: ContextOverflowMessageScope,
): boolean {
  return CONTEXT_OVERFLOW_PATTERN_SCOPES[scope].some((pattern: RegExp) =>
    pattern.test(errorMessage),
  );
}

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
 * Error messages matching any of these are excluded from overflow detection
 * even if they also match an OVERFLOW_PATTERN.
 *
 * Example: Bedrock formats throttling errors as "ThrottlingException: Too many tokens,
 * please wait before trying again." which would match the /too many tokens/i overflow
 * pattern without this exclusion.
 */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

function resolveContextInputTokens(message: AssistantMessage): number | undefined {
  if (message.usage.contextUsage?.state === "available") {
    return message.usage.contextUsage.promptTokens;
  }
  if (message.usage.contextUsage?.state === "unavailable") {
    return undefined;
  }
  // Cache writes are prompt tokens too: providers that report them separately keep
  // them out of `input`, so omitting the bucket under-counts the context by exactly
  // that amount. Mirrors the Anthropic lane's `input + cacheRead + cacheWrite`.
  return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
}

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles two cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern.
 * 2. Silent overflow: Some providers accept overflow requests and return
 *    successfully. For these, we check if usage.input exceeds the context window.
 *
 * ## Reliability by Provider
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum" or "request_too_large"
 * - OpenAI (Completions & Responses): "exceeds the context window" or "exceeds the model's maximum context length of X tokens"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 413 status code (no body)
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter (all backends): "maximum context length is X tokens"
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 * - z.ai: "tokens in request more than max tokens allowed" or "Prompt exceeds max length"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),
 *   sometimes returns rate limit errors instead of the explicit overflow error above. Pass
 *   contextWindow param to detect silent overflow.
 * - Xiaomi MiMo: Truncates input to fit contextWindow then returns stopReason "length" with
 *   output=0. Pass contextWindow param to detect via the "filled context + zero output" signal.
 * - Ollama: May truncate input silently for some setups, but may also return explicit
 *   overflow errors that match the patterns above. Silent truncation still cannot be
 *   detected here because we do not know the expected token count.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to the appropriate canonical scope in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size for detecting silent overflow (z.ai)
 * @returns true if the message indicates a context overflow
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  // Case 1: Check error message patterns
  if (message.stopReason === "error" && message.errorMessage) {
    // Hoist so the regex closures keep the narrowing without assertions.
    const errorMessage = message.errorMessage;
    // Skip messages matching known non-overflow patterns (e.g. throttling / rate-limit)
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
    if (!isNonOverflow && matchesContextOverflowMessage(errorMessage, "assistant-error")) {
      return true;
    }
  }

  // Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
  if (contextWindow && message.stopReason === "stop") {
    const inputTokens = resolveContextInputTokens(message);
    if (inputTokens !== undefined && inputTokens > contextWindow) {
      return true;
    }
  }

  // Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates oversized input
  // to fit the context window, leaving no room for output. Returns stopReason "length"
  // with output=0 and the prompt buckets filling the context window.
  if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
    const inputTokens = resolveContextInputTokens(message);
    if (inputTokens !== undefined && inputTokens >= contextWindow * 0.99) {
      return true;
    }
  }

  return false;
}
