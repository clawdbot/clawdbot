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
): McpCodexToolApprovalMode | undefined {
  const codex =
    server.codex && typeof server.codex === "object" && !Array.isArray(server.codex)
      ? (server.codex as Record<string, unknown>)
      : {};
  return (
    normalizeApprovalMode(codex.defaultToolsApprovalMode) ??
    normalizeApprovalMode(codex.default_tools_approval_mode) ??
    (isOpenClawLoopbackServer(serverName, server) ? "approve" : undefined)
  );
}

export function resolveMcpCodexToolApprovalMode(
  serverName: string,
  server: McpServerConfig,
): McpCodexToolApprovalMode {
  return resolveProjectedMcpCodexToolApprovalMode(serverName, server) ?? "auto";
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

/** Mirrors Codex `auto` approval semantics for unattended dynamic execution. */
export function requiresMcpCodexToolApproval(params: {
  mode: McpCodexToolApprovalMode;
  annotations?: McpCodexToolAnnotations;
}): boolean {
  if (params.mode === "approve") {
    return false;
  }
  if (params.mode === "prompt") {
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
