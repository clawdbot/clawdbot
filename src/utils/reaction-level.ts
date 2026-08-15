/**
 * Shared reaction-level resolver for channel plugins that expose ACK and agent reaction controls.
 * Channel adapters supply defaults/fallbacks; this helper owns the common flag expansion.
 */
/** User-configurable reaction behavior level for channel delivery. */
export type ReactionLevel = "off" | "ack" | "minimal" | "extensive";

/** Expanded reaction flags consumed by runtime delivery and prompt guidance. */
export type ResolvedReactionLevel = {
  level: ReactionLevel;
  /** Whether ACK reactions (e.g., 👀 when processing) are enabled. */
  ackEnabled: boolean;
  /** Whether agent-controlled reactions are enabled. */
  agentReactionsEnabled: boolean;
  /** Guidance level for agent reactions (minimal = sparse, extensive = liberal). */
  agentReactionGuidance?: "minimal" | "extensive";
};

const LEVELS = new Set<ReactionLevel>(["off", "ack", "minimal", "extensive"]);

/** Parses a raw config value while preserving missing vs invalid for fallback policy. */
function parseLevel(
  value: unknown,
): { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; value: ReactionLevel } {
  if (value === undefined || value === null) {
    return { kind: "missing" };
  }
  if (typeof value !== "string") {
    return { kind: "invalid" };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: "missing" };
  }
  if (LEVELS.has(trimmed as ReactionLevel)) {
    return { kind: "ok", value: trimmed as ReactionLevel };
  }
  return { kind: "invalid" };
}

/** Resolves raw reaction config into ACK and agent-reaction runtime flags. */
export function resolveReactionLevel(params: {
  value: unknown;
  defaultLevel: ReactionLevel;
  invalidFallback: "ack" | "minimal";
}): ResolvedReactionLevel {
  const parsed = parseLevel(params.value);
  const effective =
    parsed.kind === "ok"
      ? parsed.value
      : parsed.kind === "missing"
        ? params.defaultLevel
        : params.invalidFallback;

  switch (effective) {
    case "off":
      return { level: "off", ackEnabled: false, agentReactionsEnabled: false };
    case "ack":
      return { level: "ack", ackEnabled: true, agentReactionsEnabled: false };
    case "minimal":
      return {
        level: "minimal",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      };
    case "extensive":
      return {
        level: "extensive",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "extensive",
      };
    default:
      return {
        level: "minimal",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      };
  }
}
