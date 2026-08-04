/**
 * Smart Model Tiering
 *
 * Routes simple requests to a cheaper model, keeping the primary model for work
 * that warrants it. This can significantly reduce costs for users who primarily
 * use OpenClaw for casual conversations.
 *
 * This module only decides *which* model a request should use; callers own model
 * resolution. It is wired into the two places that resolve a model for a
 * user-initiated run — `createModelSelectionState` (chat channels) and
 * `agentCommand` (CLI, gateway RPC, OpenAI-compatible HTTP APIs) — so every
 * surface behaves the same. Internal sub-runs (memory extraction, follow-ups)
 * deliberately do not tier: they have their own prompts, not the user's.
 *
 * Configuration (per-agent `agents.list[].model.tiering` merges over this):
 * ```json5
 * {
 *   agents: {
 *     defaults: {
 *       model: {
 *         primary: "anthropic/claude-sonnet-4-5",  // Complex tasks
 *         tiering: {
 *           enabled: true,
 *           simple: "ollama/llama3.3",  // Simple queries (free/cheap)
 *         },
 *       },
 *     },
 *   },
 * }
 * ```
 */

import type { OpenClawConfig } from "../config/config.js";
import type { ModelTieringConfig } from "../config/types.agent-defaults.js";
import { resolveAgentModelTiering } from "./agent-scope.js";
import {
  buildModelAliasIndex,
  modelKey,
  resolveModelRefFromString,
  type ModelAliasIndex,
  type ModelRef,
} from "./model-selection.js";

export type QueryComplexity = "simple" | "complex";

export type TieringConfig = ModelTieringConfig;

const DEFAULT_COMPLEX_LENGTH_THRESHOLD = 500;

/**
 * Upper bound on the text handed to the complex-pattern sweep. Several patterns
 * contain `.*`, which is O(n^2) on non-matching input, so a large
 * `complexLengthThreshold` would otherwise let a big paste block the event loop.
 * The patterns are keyword-shaped, so the head of a message is enough to
 * classify it.
 */
const PATTERN_SCAN_LIMIT = 4000;

/**
 * Patterns that indicate a query is complex and needs a powerful model.
 * These are checked case-insensitively.
 */
const DEFAULT_COMPLEX_PATTERNS = [
  // Code-related tasks
  /\b(write|create|implement|build|code|program)\b.*\b(function|class|api|endpoint|algorithm|module|component|service|script)\b/i,
  /\b(function|class|api|endpoint|algorithm)\b.*\b(for|that|which|to)\b/i,
  /\b(debug|fix|refactor|optimize|review)\b.*\b(code|function|bug|error|issue)\b/i,
  /\b(explain|analyze)\b.*\b(code|algorithm|architecture|system)\b/i,
  /```[\s\S]{50,}```/, // Code blocks over 50 chars

  // Multi-step reasoning
  /\b(step[- ]by[- ]step|let'?s think|break down|analyze|compare and contrast)\b/i,
  /\b(pros? and cons?|trade[- ]?offs?|advantages? and disadvantages?)\b/i,

  // Long-form content
  /\b(write|draft|compose|create)\b.*\b(essay|article|report|document|proposal|plan)\b/i,
  /\b(summarize|synthesize)\b.*\b(article|paper|document|book|chapter)\b/i,

  // Data/file operations
  /\b(read|parse|process|transform|convert)\b.*\b(file|json|csv|xml|data)\b/i,
  /\b(search|find|grep|locate)\b.*\b(in|across|through)\b.*\b(files?|codebase|project)\b/i,

  // System operations
  /\b(run|execute|install|deploy|configure|setup)\b/i,
  /\b(git|npm|pip|docker|kubectl|terraform)\b/i,

  // Complex questions
  /\b(how (does|do|can|should|would)|why (does|do|is|are|would)|what (is the best|are the|would happen))\b.*\?/i,

  // Planning/architecture
  /\b(design|architect|plan|structure|organize)\b.*\b(system|app|application|project|database)\b/i,
];

/**
 * Patterns that indicate a query is simple and can use a cheaper model.
 */
const SIMPLE_PATTERNS = [
  // Greetings
  /^(hi|hello|hey|good (morning|afternoon|evening)|howdy|yo|sup)[\s!?.]*$/i,

  // Simple status/info
  /^(thanks|thank you|ok|okay|got it|understood|cool|great|nice|awesome|perfect)[\s!?.]*$/i,

  // Simple questions
  /^(what time is it|what'?s the (time|date|weather))[\s?]*$/i,
  /^(who are you|what are you|what can you do)[\s?]*$/i,

  // Single-word or very short queries
  /^[a-z]{1,15}[\s!?.]*$/i,

  // Yes/no responses
  /^(yes|no|yep|nope|yeah|nah|sure|maybe)[\s!?.]*$/i,
];

/**
 * Question/explanation words; two or more of them signal a compound question.
 * Carries the `g` flag, so it must only be used with `String.match` (which
 * resets `lastIndex`), never with `RegExp.test` on this shared instance.
 */
const QUESTION_WORDS_PATTERN = /\b(what|why|how|when|where|which|who|explain|describe)\b/gi;

/** List requests ("show me all ...") often need structured thinking. */
const LIST_REQUEST_PATTERN =
  /\b(list|enumerate|give me|show me|tell me)\b.*\b(all|every|each|different|various)\b/i;

/**
 * Cache of compiled user-supplied patterns, keyed by the raw pattern string.
 * Classification runs once per inbound message, so compiling here keeps the
 * per-message cost at a map lookup. Invalid patterns cache as `null` so a
 * broken config costs one failed compile rather than a throw every message.
 */
const customPatternCache = new Map<string, RegExp | null>();

function compileCustomPattern(patternStr: string): RegExp | null {
  const cached = customPatternCache.get(patternStr);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(patternStr, "i");
  } catch {
    // Invalid regex; remember the failure so we don't retry per message.
    compiled = null;
  }
  customPatternCache.set(patternStr, compiled);
  return compiled;
}

function complexPatternMatch(pattern: RegExp): { tier: QueryComplexity; reason: string } {
  return { tier: "complex", reason: `Matches complex pattern: ${pattern.source.slice(0, 50)}...` };
}

/**
 * Single source of truth for the tier decision and the reason behind it, so
 * the classification and its explanation can never drift apart.
 */
function classify(
  query: string,
  config?: TieringConfig,
): { tier: QueryComplexity; reason: string | null } {
  const simple = { tier: "simple", reason: null } as const;
  const trimmed = query.trim();

  // Empty or very short queries are simple
  if (!trimmed || trimmed.length < 3) {
    return simple;
  }

  // Check explicit simple patterns first
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return simple;
    }
  }

  const lengthThreshold = config?.complexLengthThreshold ?? DEFAULT_COMPLEX_LENGTH_THRESHOLD;
  if (trimmed.length > lengthThreshold) {
    return { tier: "complex", reason: `Query length exceeds ${lengthThreshold} characters` };
  }

  // Bound the input to the `.*`-bearing patterns; see PATTERN_SCAN_LIMIT.
  const scanned =
    trimmed.length > PATTERN_SCAN_LIMIT ? trimmed.slice(0, PATTERN_SCAN_LIMIT) : trimmed;

  for (const pattern of DEFAULT_COMPLEX_PATTERNS) {
    if (pattern.test(scanned)) {
      return complexPatternMatch(pattern);
    }
  }

  for (const patternStr of config?.complexPatterns ?? []) {
    const pattern = compileCustomPattern(patternStr);
    if (pattern?.test(scanned)) {
      return complexPatternMatch(pattern);
    }
  }

  const questionWords = (scanned.match(QUESTION_WORDS_PATTERN) || []).length;
  if (questionWords >= 2) {
    return { tier: "complex", reason: `Contains ${questionWords} question/explanation words` };
  }

  if (LIST_REQUEST_PATTERN.test(scanned)) {
    return { tier: "complex", reason: "Requests an enumerated list" };
  }

  // No complex signal: route to the cheap tier.
  return simple;
}

/**
 * Classify a query as simple or complex to determine model tier.
 */
export function classifyQueryComplexity(query: string, config?: TieringConfig): QueryComplexity {
  return classify(query, config).tier;
}

/**
 * Resolve the effective tiering configuration for an agent.
 *
 * Per-agent `agents.list[].model.tiering` is merged over the global
 * `agents.defaults.model.tiering`, field by field, so an agent can override
 * just `simple` (or switch tiering off) while inheriting the rest.
 */
export function resolveTieringConfig(cfg: OpenClawConfig, agentId?: string): TieringConfig | null {
  const globalTiering = cfg.agents?.defaults?.model?.tiering;
  const agentTiering = agentId ? resolveAgentModelTiering(cfg, agentId) : undefined;
  if (!globalTiering && !agentTiering) {
    return null;
  }
  const merged: TieringConfig = { ...globalTiering, ...agentTiering };
  return merged.enabled ? merged : null;
}

/**
 * Resolve the cheaper model to route this request to, or null to keep the
 * model the caller already resolved.
 *
 * Callers must pass the text of the *current* request only (no transcript or
 * structural context), otherwise length and greeting checks measure the wrong
 * thing. `explicitModel` must be set whenever the model was deliberately
 * chosen — an inline `/model` directive, a stored session override, or a
 * configured heartbeat model — so tiering never overrides a deliberate choice.
 */
export function resolveTieredModel(params: {
  cfg: OpenClawConfig;
  query: string;
  defaultProvider: string;
  agentId?: string;
  explicitModel?: boolean;
  aliasIndex?: ModelAliasIndex;
  /** When non-empty, the tiered model must appear in this allowlist. */
  allowedModelKeys?: Set<string>;
}): ModelRef | null {
  if (params.explicitModel) {
    return null;
  }

  const tiering = resolveTieringConfig(params.cfg, params.agentId);
  // Skip classification entirely when there is no cheaper model to route to.
  if (!tiering?.simple) {
    return null;
  }

  if (classifyQueryComplexity(params.query, tiering) !== "simple") {
    return null;
  }

  const aliasIndex =
    params.aliasIndex ??
    buildModelAliasIndex({ cfg: params.cfg, defaultProvider: params.defaultProvider });
  const resolved = resolveModelRefFromString({
    raw: tiering.simple,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return null;
  }

  // Honour the same allowlist as `/model`; a tiered model must not be a way
  // around `agents.defaults.models`.
  const allowed = params.allowedModelKeys;
  if (
    allowed &&
    allowed.size > 0 &&
    !allowed.has(modelKey(resolved.ref.provider, resolved.ref.model))
  ) {
    return null;
  }

  return resolved.ref;
}

/**
 * Get a human-readable description of why a query was classified as complex,
 * or null when the query is simple. Shares `classify` with
 * `classifyQueryComplexity`, so the reason always matches the decision.
 */
export function describeComplexityReason(query: string, config?: TieringConfig): string | null {
  return classify(query, config).reason;
}
