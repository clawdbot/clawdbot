import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { normalizeToolName } from "./tool-policy-shared.js";

const ACP_UNSUPPORTED_INHERITED_TOOL_DENY = [
  "apply_patch",
  "edit",
  "exec",
  "fs_delete",
  "fs_move",
  "fs_write",
  "process",
  "read",
  "shell",
  "spawn",
  "write",
] as const;

// Inherited allowlists are rebuilt from the effective OpenClaw tool surface.
// ACP-only aliases can appear in explicit deny policies, but not in that
// effective allowlist unless a plugin happens to expose matching tool names.
const ACP_REQUIRED_INHERITED_TOOL_ALLOW = [
  "apply_patch",
  "edit",
  "exec",
  "process",
  "read",
  "write",
] as const;

export function normalizeInheritedToolDenylist(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = normalizeToolName(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function inheritedToolDenyPatch(value: unknown): { inheritedToolDeny?: string[] } {
  const inheritedToolDeny = normalizeInheritedToolDenylist(value);
  return inheritedToolDeny.length > 0 ? { inheritedToolDeny } : {};
}

export function normalizeInheritedToolAllowlist(value: unknown): string[] {
  return normalizeInheritedToolDenylist(value);
}

export function inheritedToolAllowPatch(value: unknown): { inheritedToolAllow?: string[] } {
  const inheritedToolAllow = normalizeInheritedToolAllowlist(value);
  return inheritedToolAllow.length > 0 ? { inheritedToolAllow } : {};
}

export function findAcpUnsupportedInheritedToolDeny(value: unknown): string | undefined {
  const inheritedToolDeny = normalizeInheritedToolDenylist(value);
  if (inheritedToolDeny.length === 0) {
    return undefined;
  }
  return ACP_UNSUPPORTED_INHERITED_TOOL_DENY.find(
    (toolName) => !isToolAllowedByPolicyName(toolName, { deny: inheritedToolDeny }),
  );
}

export function findAcpUnsupportedInheritedToolAllow(value: unknown): string | undefined {
  const inheritedToolAllow = normalizeInheritedToolAllowlist(value);
  if (inheritedToolAllow.length === 0) {
    return undefined;
  }
  return ACP_REQUIRED_INHERITED_TOOL_ALLOW.find(
    (toolName) => !isToolAllowedByPolicyName(toolName, { allow: inheritedToolAllow }),
  );
}

export function formatAcpInheritedToolDenyError(toolName: string): string {
  return `runtime="acp" is unavailable because the requester denies ${toolName}. Use runtime="subagent".`;
}

export function formatAcpInheritedToolAllowError(toolName: string): string {
  return `runtime="acp" is unavailable because the requester does not allow ${toolName}. Use runtime="subagent".`;
}
