import type { ClawdbotConfig } from "../../config/config.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { expandToolGroups } from "../tool-policy.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./constants.js";
import type {
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxToolPolicySource,
} from "./types.js";

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function compilePattern(pattern: string): CompiledPattern {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return { kind: "exact", value: "" };
  if (normalized === "*") return { kind: "all" };
  if (!normalized.includes("*")) return { kind: "exact", value: normalized };
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    kind: "regex",
    value: new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`),
  };
}

function compilePatterns(patterns?: string[]): CompiledPattern[] {
  if (!Array.isArray(patterns)) return [];
  return expandToolGroups(patterns)
    .map(compilePattern)
    .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}

function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") return true;
    if (pattern.kind === "exact" && name === pattern.value) return true;
    if (pattern.kind === "regex" && pattern.value.test(name)) return true;
  }
  return false;
}

export function isToolAllowed(policy: SandboxToolPolicy, name: string) {
  const normalized = name.trim().toLowerCase();
  const deny = compilePatterns(policy.deny);
  if (matchesAny(normalized, deny)) return false;
  const allow = compilePatterns(policy.allow);
  if (allow.length === 0) return true;
  return matchesAny(normalized, allow);
}

export function resolveSandboxToolPolicyForAgent(
  cfg?: ClawdbotConfig,
  agentId?: string,
): SandboxToolPolicyResolved {
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentAllow = agentConfig?.tools?.sandbox?.tools?.allow;
  const agentDeny = agentConfig?.tools?.sandbox?.tools?.deny;
  const globalAllow = cfg?.tools?.sandbox?.tools?.allow;
  const globalDeny = cfg?.tools?.sandbox?.tools?.deny;

  const allowSource = Array.isArray(agentAllow)
    ? ({
        source: "agent",
        key: "agents.list[].tools.sandbox.tools.allow",
      } satisfies SandboxToolPolicySource)
    : Array.isArray(globalAllow)
      ? ({
          source: "global",
          key: "tools.sandbox.tools.allow",
        } satisfies SandboxToolPolicySource)
      : ({
          source: "default",
          key: "tools.sandbox.tools.allow",
        } satisfies SandboxToolPolicySource);

  const denySource = Array.isArray(agentDeny)
    ? ({
        source: "agent",
        key: "agents.list[].tools.sandbox.tools.deny",
      } satisfies SandboxToolPolicySource)
    : Array.isArray(globalDeny)
      ? ({
          source: "global",
          key: "tools.sandbox.tools.deny",
        } satisfies SandboxToolPolicySource)
      : ({
          source: "default",
          key: "tools.sandbox.tools.deny",
        } satisfies SandboxToolPolicySource);

  const deny = Array.isArray(agentDeny)
    ? agentDeny
    : Array.isArray(globalDeny)
      ? globalDeny
      : [...DEFAULT_TOOL_DENY];
  const allow = Array.isArray(agentAllow)
    ? agentAllow
    : Array.isArray(globalAllow)
      ? globalAllow
      : [...DEFAULT_TOOL_ALLOW];

  const expandedDeny = expandToolGroups(deny);
  let expandedAllow = expandToolGroups(allow);

  // `image` is essential for multimodal workflows; always include it in sandboxed
  // sessions unless explicitly denied.
  if (
    !expandedDeny.map((v) => v.toLowerCase()).includes("image") &&
    !expandedAllow.map((v) => v.toLowerCase()).includes("image")
  ) {
    expandedAllow = [...expandedAllow, "image"];
  }

  return {
    allow: expandedAllow,
    deny: expandedDeny,
    sources: {
      allow: allowSource,
      deny: denySource,
    },
  };
}
