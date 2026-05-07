/**
 * Structured decision returned by gate/policy hooks.
 * Core is outcome-agnostic — it handles the mechanics of each outcome
 * without knowing *why* the decision was made.
 */
export type HookDecision = HookDecisionPass | HookDecisionBlock;

/** Content is fine. Proceed normally. */
export type HookDecisionPass = {
  outcome: "pass";
};

/** Prefix for user-facing replacement messages when a `block` decision stops a request. */
export const BLOCK_MESSAGE_PREFIX = "Your message could not be sent";

/**
 * Content is blocked. `reason` is internal plugin-local detail; core must not log,
 * persist, broadcast, or expose it verbatim. `message` is user-facing detail.
 */
export type HookDecisionBlock = {
  outcome: "block";
  /** Internal plugin-local reason. Do not log, persist, broadcast, or expose verbatim. */
  reason: string;
  /** Optional user-facing detail included in the block response envelope. */
  message?: string;
  /** Plugin-defined category for analytics (e.g. "violence", "pii", "cost_limit"). */
  category?: string;
  /** Opaque metadata for the plugin's own use. Core does not interpret it. */
  metadata?: Record<string, unknown>;
};

export function resolveBlockMessage(
  decision: HookDecisionBlock,
  params: { blockedBy?: string } = {},
): string {
  const message = typeof decision.message === "string" ? decision.message.trim() : "";
  const blockedBy = params.blockedBy?.trim();
  if (message) {
    return blockedBy
      ? `${BLOCK_MESSAGE_PREFIX}: ${message} (blocked by ${blockedBy})`
      : `${BLOCK_MESSAGE_PREFIX}: ${message}`;
  }
  return blockedBy
    ? `${BLOCK_MESSAGE_PREFIX}: blocked by ${blockedBy}`
    : `${BLOCK_MESSAGE_PREFIX}: blocked`;
}

/** Outcome severity for most-restrictive-wins merging. Higher = more restrictive. */
export const HOOK_DECISION_SEVERITY: Record<HookDecision["outcome"], number> = {
  pass: 0,
  block: 2,
};

/**
 * Merge two HookDecisions using most-restrictive-wins semantics.
 * `block > pass`
 */
export function mergeHookDecisions(a: HookDecision | undefined, b: HookDecision): HookDecision {
  if (!a) {
    return b;
  }
  return HOOK_DECISION_SEVERITY[b.outcome] > HOOK_DECISION_SEVERITY[a.outcome] ? b : a;
}

/**
 * Type guard: does this object look like a HookDecision (has `outcome` field)?
 */
export function isHookDecision(value: unknown): value is HookDecision {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (v.outcome === "pass") {
    return keys.length === 1;
  }
  if (v.outcome !== "block") {
    return false;
  }
  const allowedBlockKeys = new Set(["outcome", "reason", "message", "category", "metadata"]);
  if (keys.some((key) => !allowedBlockKeys.has(key))) {
    return false;
  }
  if (typeof v.reason !== "string" || !v.reason.trim()) {
    return false;
  }
  if ("message" in v && (typeof v.message !== "string" || !v.message.trim())) {
    return false;
  }
  if ("category" in v && (typeof v.category !== "string" || !v.category.trim())) {
    return false;
  }
  if (
    "metadata" in v &&
    (typeof v.metadata !== "object" || v.metadata === null || Array.isArray(v.metadata))
  ) {
    return false;
  }
  return true;
}

/** Outcomes valid for input gates (before_agent_run). */
export type InputGateDecision = HookDecisionPass | HookDecisionBlock;

/**
 * A gate hook decision paired with the pluginId that produced it.
 * Returned by gate hook runners so callers can
 * attribute blocked entries and audit events to the originating plugin.
 */
export type GateHookResult<TDecision extends HookDecision = HookDecision> = {
  decision: TDecision;
  pluginId: string;
};
