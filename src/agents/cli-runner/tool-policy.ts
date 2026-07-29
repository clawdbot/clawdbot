import type { CliBackendToolAvailability } from "../../plugins/cli-backend.types.js";
import { normalizeToolName } from "../tool-policy.js";

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName;
}

/** Builds the public backend contract plus the shipped beta MCP-name projection. */
export function buildCliBackendToolAvailability(availability: {
  native: readonly string[];
  openClaw: readonly string[];
}): CliBackendToolAvailability {
  return {
    native: availability.native,
    openClaw: availability.openClaw,
    mcp: availability.openClaw.map((toolName) => `${OPENCLAW_MCP_TOOL_PREFIX}${toolName}`),
  };
}

/** Keeps only explicit runtime caps for backend-owned exact translation. */
export function resolveCliRuntimeToolsAllow(
  toolsAllow?: string[],
  _toolsAllowIsDefault?: boolean,
): string[] | undefined {
  if (toolsAllow === undefined) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
