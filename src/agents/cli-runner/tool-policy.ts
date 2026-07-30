import type { RuntimeToolPolicy } from "../../config/sessions/runtime-tool-policy.types.js";
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

/**
 * Convert a per-spawn `RuntimeToolPolicy` to the CLI harness's allow-only list.
 *
 * The CLI harness can only enforce an explicit allow list — it cannot compute
 * the complement of a deny list against the full tool inventory. Therefore:
 * - `undefined` → `undefined` (no restriction).
 * - `"none"` → `[]` (zero tools).
 * - `{ allow: [...] }` without deny → the allow list.
 * - `{ deny: [...] }` without allow → **throw** (CLI can't compute the complement; fail closed).
 * - `{ allow, deny }` → **throw** (CLI can't subtract deny from allow reliably with globs/groups; fail closed).
 */
function resolveCliRuntimeToolPolicyFromSession(
  policy: RuntimeToolPolicy | undefined,
): string[] | undefined {
  if (policy === undefined) {
    return undefined;
  }
  if (policy === "none") {
    return [];
  }
  if (policy.deny && policy.deny.length > 0) {
    throw new Error(
      "CLI-backed native runs cannot enforce a deny-based runtime tool policy. " +
        "Deny-only and allow+deny policies are rejected because the CLI harness " +
        "cannot compute the tool complement. Use an allow-only policy or an embedded runtime.",
    );
  }
  // allow-only (deny is absent or empty)
  return policy.allow ?? [];
}

/**
 * Preserve both the caller's runtime cap and the immutable per-spawn cap.
 *
 * CLI backends receive only one allow list. Two independent non-empty lists
 * cannot be combined safely here because either list may contain groups or
 * patterns whose intersection depends on the backend's concrete tool catalog.
 */
export function resolveCliSessionToolsAllow(params: {
  toolsAllow?: string[];
  toolsAllowIsDefault?: boolean;
  sessionPolicy?: RuntimeToolPolicy;
}): string[] | undefined {
  const runtimeAllow = resolveCliRuntimeToolsAllow(params.toolsAllow, params.toolsAllowIsDefault);
  const sessionAllow = resolveCliRuntimeToolPolicyFromSession(params.sessionPolicy);

  if (runtimeAllow === undefined) {
    return sessionAllow;
  }
  if (sessionAllow === undefined) {
    return runtimeAllow;
  }
  if (runtimeAllow.length === 0 || sessionAllow.length === 0) {
    return [];
  }
  throw new Error(
    "CLI-backed native runs cannot combine an existing runtime tool cap with a per-spawn " +
      "tool policy without risking broader access. Remove one cap or use an embedded runtime.",
  );
}
