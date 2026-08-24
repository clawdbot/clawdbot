// Declarative classification rules for Claw agent capability fields.
import { parseDurationMs } from "../cli/parse-duration.js";

export type CapabilityClassification = "escalation" | "reduction" | "neutral";

function rankedValue(value: unknown, rank: Record<string, number>): number {
  return typeof value === "string" ? (rank[value] ?? 0) : 0;
}

function compareRankedCapability(
  current: unknown,
  desired: unknown,
  rank: Record<string, number>,
): CapabilityClassification {
  const currentRank = rankedValue(current, rank);
  const desiredRank = rankedValue(desired, rank);
  return desiredRank > currentRank
    ? "escalation"
    : desiredRank < currentRank
      ? "reduction"
      : "neutral";
}

function classifyToolSet(current: unknown, desired: unknown): CapabilityClassification {
  if (!Array.isArray(current) || !Array.isArray(desired)) {
    return "neutral";
  }
  const currentTools = new Set(
    current.filter((value): value is string => typeof value === "string"),
  );
  const desiredTools = new Set(
    desired.filter((value): value is string => typeof value === "string"),
  );
  if (currentTools.has("*") !== desiredTools.has("*")) {
    return desiredTools.has("*") ? "escalation" : "reduction";
  }
  if (desiredTools.has("*")) {
    return "neutral";
  }
  if ([...desiredTools].some((tool) => !currentTools.has(tool))) {
    return "escalation";
  }
  return [...currentTools].some((tool) => !desiredTools.has(tool)) ? "reduction" : "neutral";
}

function classifyHeartbeatEvery(current: unknown, desired: unknown): CapabilityClassification {
  const toInterval = (value: unknown): number | undefined => {
    if (value === "disabled") {
      return 0;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    try {
      return Math.max(0, parseDurationMs(value, { defaultUnit: "m" }));
    } catch {
      return undefined;
    }
  };
  const currentMs = toInterval(current);
  const desiredMs = toInterval(desired);
  if (currentMs === undefined || desiredMs === undefined || currentMs === desiredMs) {
    return "neutral";
  }
  if (currentMs === 0) {
    return "escalation";
  }
  if (desiredMs === 0) {
    return "reduction";
  }
  return desiredMs < currentMs ? "escalation" : "reduction";
}

function oppositeClassification(
  classification: "escalation" | "reduction",
): "escalation" | "reduction" {
  return classification === "escalation" ? "reduction" : "escalation";
}

function classifyDenyToolSet(current: unknown, desired: unknown): CapabilityClassification {
  if (!Array.isArray(current) || !Array.isArray(desired)) {
    return "escalation";
  }
  const desiredTools = new Set(
    desired.filter((value): value is string => typeof value === "string"),
  );
  if (current.some((value) => typeof value === "string" && !desiredTools.has(value))) {
    return "escalation";
  }
  const currentTools = new Set(
    current.filter((value): value is string => typeof value === "string"),
  );
  return desired.some((value) => typeof value === "string" && !currentTools.has(value))
    ? "reduction"
    : "neutral";
}

function classifyCapabilitySources(current: unknown, desired: unknown): CapabilityClassification {
  if (!Array.isArray(current) || !Array.isArray(desired)) {
    return "escalation";
  }
  const currentSources = new Set(current);
  return desired.some((source) => !currentSources.has(source)) ? "escalation" : "reduction";
}

function classifyCapabilityFallback(path: string): CapabilityClassification {
  return path.startsWith("sandbox.") ||
    path.startsWith("tools.") ||
    path.startsWith("heartbeat.") ||
    path.startsWith("memory.search.")
    ? "escalation"
    : "neutral";
}

type AgentCapabilityCompare =
  | { kind: "ranked"; rank: Record<string, number> }
  | { kind: "toolset" }
  | { kind: "deny-toolset" }
  | { kind: "bool"; whenTrue: "escalation" | "reduction" }
  | { kind: "interval"; lowerIs: "escalation" | "reduction" }
  | { kind: "heartbeat-every" }
  | { kind: "sources" }
  | { kind: "fallback" };

type AgentCapabilityRule = {
  /** !currentAgentExists && desired defined escalates before any other check. */
  missingAgentEscalates?: boolean;
  /** Classification when desired is undefined (before the generic reduction). */
  missingDesired?: "escalation" | "reduction";
  /** Classification when current is undefined (before the generic escalation). */
  missingCurrent?: "escalation" | "reduction";
  compare: AgentCapabilityCompare;
};

// Declarative classification rules for agent capability fields. The field walk
// in update-capability-changes.ts is the single source of which fields exist;
// each field names its compare here, and the pre-check columns mirror the
// historical evaluation order exactly. New fields without a rule fall through
// to the prefix-based fallback, preserving the original default.
const toolsetRule: AgentCapabilityRule = {
  missingAgentEscalates: true,
  missingDesired: "escalation",
  missingCurrent: "reduction",
  compare: { kind: "toolset" },
};

const AGENT_CAPABILITY_RULES: Record<string, AgentCapabilityRule> = {
  "tools.profile": toolsetRule,
  "tools.allow": toolsetRule,
  "tools.deny": { ...toolsetRule, compare: { kind: "deny-toolset" } },
  "tools.alsoAllow": {
    ...toolsetRule,
    missingDesired: "reduction",
    missingCurrent: "escalation",
  },
  "tools.fs.workspaceOnly": {
    compare: { kind: "bool", whenTrue: "reduction" },
  },
  "memory.search.enabled": {
    compare: { kind: "bool", whenTrue: "escalation" },
  },
  "memory.search.rememberAcrossConversations": {
    compare: { kind: "bool", whenTrue: "escalation" },
  },
  "memory.search.sources": {
    compare: { kind: "sources" },
  },
  "sandbox.mode": {
    compare: { kind: "ranked", rank: { all: 0, "non-main": 1, off: 2 } },
  },
  "sandbox.scope": {
    compare: { kind: "ranked", rank: { session: 0, agent: 1, shared: 2 } },
  },
  "sandbox.workspaceAccess": {
    compare: { kind: "ranked", rank: { none: 0, ro: 1, rw: 2 } },
  },
  "heartbeat.every": {
    compare: { kind: "heartbeat-every" },
  },
  "heartbeat.isolatedSession": {
    compare: { kind: "bool", whenTrue: "reduction" },
  },
  "heartbeat.timeoutSeconds": {
    compare: { kind: "interval", lowerIs: "reduction" },
  },
  "heartbeat.activeHours": {
    compare: { kind: "fallback" },
  },
};

function applyCapabilityCompare(
  path: string,
  compare: AgentCapabilityCompare | undefined,
  current: unknown,
  desired: unknown,
): CapabilityClassification {
  switch (compare?.kind) {
    case "ranked":
      return compareRankedCapability(current, desired, compare.rank);
    case "toolset":
      // Non-array values historically fell through to the tools.* prefix
      // fallback (escalation), not to classifyToolSet's neutral default.
      return Array.isArray(current) && Array.isArray(desired)
        ? classifyToolSet(current, desired)
        : classifyCapabilityFallback(path);
    case "deny-toolset":
      return classifyDenyToolSet(current, desired);
    case "bool":
      return desired === true ? compare.whenTrue : oppositeClassification(compare.whenTrue);
    case "interval": {
      if (typeof current === "number" && typeof desired === "number" && desired < current) {
        return compare.lowerIs;
      }
      return oppositeClassification(compare.lowerIs);
    }
    case "heartbeat-every":
      return classifyHeartbeatEvery(current, desired);
    case "sources":
      return classifyCapabilitySources(current, desired);
    default:
      // Includes the explicit "fallback" compare and unknown future kinds:
      // both resolve through the prefix-based default.
      return classifyCapabilityFallback(path);
  }
}

export function classifyAgentCapability(
  path: string,
  current: unknown,
  desired: unknown,
  currentAgentExists: boolean,
): CapabilityClassification {
  const rule = AGENT_CAPABILITY_RULES[path];
  if (rule?.missingAgentEscalates && !currentAgentExists && desired !== undefined) {
    return "escalation";
  }
  if (rule?.missingDesired && desired === undefined) {
    return rule.missingDesired;
  }
  if (rule?.missingCurrent && current === undefined) {
    return rule.missingCurrent;
  }
  if (desired === undefined) {
    return "reduction";
  }
  if (current === undefined) {
    return "escalation";
  }
  return applyCapabilityCompare(path, rule?.compare, current, desired);
}
