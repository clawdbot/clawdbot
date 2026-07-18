import { normalizeToolName } from "../tool-policy.js";

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
export const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName;
}

/**
 * Derives the loopback MCP grant allowlist from a selectable-backend MCP
 * permission list. Wildcards keep the full session-scoped surface; entries for
 * other MCP servers are not loopback-governed and drop out. A non-wildcard
 * list that leaves no loopback names fails closed (empty allowlist).
 */
export function resolveLoopbackToolsAllowFromMcpPermissions(
  mcp: readonly string[] | undefined,
): string[] | undefined {
  if (!mcp) {
    return undefined;
  }
  const names = new Set<string>();
  for (const entry of mcp) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*" || trimmed === `${OPENCLAW_MCP_TOOL_PREFIX}*`) {
      return undefined;
    }
    if (trimmed.startsWith("mcp__") && !trimmed.startsWith(OPENCLAW_MCP_TOOL_PREFIX)) {
      continue;
    }
    const name = normalizeToolName(stripOpenClawMcpToolPrefix(trimmed));
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

/** CLI backends cannot enforce runtime caps; keep only real restrictions. */
export function resolveCliRuntimeToolsAllow(
  toolsAllow?: string[],
  toolsAllowIsDefault?: boolean,
): string[] | undefined {
  if (toolsAllow === undefined || toolsAllowIsDefault) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
