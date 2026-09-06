import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { McpCodexToolApprovalMode, McpServerConfig } from "../config/types.mcp.js";

export type McpCodexToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const APPROVAL_MODES = new Set<McpCodexToolApprovalMode>(["auto", "prompt", "approve"]);

function normalizeApprovalMode(value: unknown): McpCodexToolApprovalMode | undefined {
  return typeof value === "string" && APPROVAL_MODES.has(value as McpCodexToolApprovalMode)
    ? (value as McpCodexToolApprovalMode)
    : undefined;
}

function isOpenClawLoopbackServer(name: string, server: McpServerConfig): boolean {
  return (
    name === "openclaw" &&
    typeof server.url === "string" &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url)
  );
}

/** Mirrors the approval default projected into Codex native MCP config. */
export function resolveProjectedMcpCodexToolApprovalMode(
  serverName: string,
  server: McpServerConfig,
  projectedServer?: Record<string, unknown>,
  toolName?: string,
): McpCodexToolApprovalMode | undefined {
  const codex =
    server.codex && typeof server.codex === "object" && !Array.isArray(server.codex)
      ? (server.codex as Record<string, unknown>)
      : {};
  const projectedTools = isRecord(projectedServer?.tools) ? projectedServer.tools : undefined;
  const projectedTool =
    toolName && isRecord(projectedTools?.[toolName]) ? projectedTools[toolName] : undefined;
  return (
    normalizeApprovalMode(projectedTool?.approval_mode) ??
    normalizeApprovalMode(codex.defaultToolsApprovalMode) ??
    normalizeApprovalMode(codex.default_tools_approval_mode) ??
    normalizeApprovalMode(projectedServer?.default_tools_approval_mode) ??
    (isOpenClawLoopbackServer(serverName, server) ? "approve" : undefined)
  );
}

export function normalizeMcpCodexToolAnnotations(value: unknown): McpCodexToolAnnotations {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const result: McpCodexToolAnnotations = {};
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof record[key] === "boolean") {
      result[key] = record[key];
    }
  }
  return result;
}

/** Explicit server policy outranks the prepared session posture. */
export function requiresMcpCodexToolApproval(params: {
  mode?: McpCodexToolApprovalMode;
  fullPermission?: boolean;
  annotations?: McpCodexToolAnnotations;
}): boolean {
  const mode = params.mode ?? (params.fullPermission ? "approve" : "auto");
  if (mode === "approve") {
    return false;
  }
  if (mode === "prompt") {
    return true;
  }
  const annotations = params.annotations ?? {};
  if (annotations.destructiveHint === true) {
    return true;
  }
  if (annotations.readOnlyHint === true) {
    return false;
  }
  return annotations.destructiveHint !== false || annotations.openWorldHint !== false;
}

export function formatMcpCodexApprovalRemedy(serverName?: string): string {
  // Config keys are unbounded; keep model-visible hints short and never emit a CLI option as a name.
  const server = serverName && /^[\w.][\w.-]{0,127}$/.test(serverName) ? serverName : "<server>";
  return `Run openclaw mcp configure ${server} --approval approve for a trusted server, or change the session permission mode.`;
}
