/**
 * Projects enabled bundle MCP servers into Codex app-server thread config.
 * The projection keeps loopback approval defaults and header env placeholders
 * compatible with Codex's MCP config shape.
 */
import crypto from "node:crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import { isRecord } from "../utils.js";
import {
  applyCommonServerConfig,
  decodeHeaderEnvPlaceholder,
  normalizeStringRecord,
} from "./cli-runner/bundle-mcp-adapter-shared.js";
import type {
  CodexBundleMcpThreadConfig,
  CodexMcpServersConfig,
  LoadCodexBundleMcpThreadConfigParams,
} from "./codex-mcp-config.types.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";

export type {
  CodexBundleMcpThreadConfig,
  CodexMcpServersConfig,
  LoadCodexBundleMcpThreadConfigParams,
} from "./codex-mcp-config.types.js";

function isOpenClawLoopbackMcpServer(name: string, server: BundleMcpServerConfig): boolean {
  return (
    name === "openclaw" &&
    typeof server.url === "string" &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url)
  );
}

type CodexMcpToolApprovalMode = "auto" | "prompt" | "approve";

const CODEX_MCP_TOOL_APPROVAL_MODES = new Set<CodexMcpToolApprovalMode>([
  "auto",
  "prompt",
  "approve",
]);

function readCodexProjectionConfig(server: BundleMcpServerConfig): Record<string, unknown> {
  return isRecord(server.codex) ? server.codex : {};
}

function normalizeCodexToolApprovalMode(value: unknown): CodexMcpToolApprovalMode | undefined {
  return typeof value === "string" &&
    CODEX_MCP_TOOL_APPROVAL_MODES.has(value as CodexMcpToolApprovalMode)
    ? (value as CodexMcpToolApprovalMode)
    : undefined;
}

function resolveCodexDefaultToolsApprovalMode(
  server: BundleMcpServerConfig,
): CodexMcpToolApprovalMode | undefined {
  const codex = readCodexProjectionConfig(server);
  return (
    normalizeCodexToolApprovalMode(codex.defaultToolsApprovalMode) ??
    normalizeCodexToolApprovalMode(codex.default_tools_approval_mode)
  );
}

/** Normalizes one bundle MCP server into Codex's mcp_servers shape. */
export function normalizeCodexMcpServerConfig(
  name: string,
  server: BundleMcpServerConfig,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  applyCommonServerConfig(next, server);
  const defaultToolsApprovalMode = resolveCodexDefaultToolsApprovalMode(server);
  if (defaultToolsApprovalMode) {
    next.default_tools_approval_mode = defaultToolsApprovalMode;
  } else if (isOpenClawLoopbackMcpServer(name, server)) {
    // OpenClaw's loopback MCP exposes local tools; Codex should ask for approval
    // unless plugin metadata explicitly selected another approval mode.
    next.default_tools_approval_mode = "approve";
  }
  const httpHeaders = normalizeStringRecord(server.headers);
  if (httpHeaders) {
    const staticHeaders: Record<string, string> = {};
    const envHeaders: Record<string, string> = {};
    for (const [nameLocal, value] of Object.entries(httpHeaders)) {
      const decoded = decodeHeaderEnvPlaceholder(value);
      if (!decoded) {
        staticHeaders[nameLocal] = value;
        continue;
      }
      if (decoded.bearer && normalizeOptionalLowercaseString(nameLocal) === "authorization") {
        // Codex has a dedicated bearer token env field for Authorization headers.
        next.bearer_token_env_var = decoded.envVar;
        continue;
      }
      envHeaders[nameLocal] = decoded.envVar;
    }
    if (Object.keys(staticHeaders).length > 0) {
      next.http_headers = staticHeaders;
    }
    if (Object.keys(envHeaders).length > 0) {
      next.env_http_headers = envHeaders;
    }
  }
  return next;
}

/** Build Codex `mcp_servers` config from normalized bundle MCP config. */
export function buildCodexMcpServersConfig(config: BundleMcpConfig): CodexMcpServersConfig {
  return Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => [
      name,
      normalizeCodexMcpServerConfig(name, server),
    ]),
  );
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJsonValue(child)]),
  );
}

function fingerprintCodexMcpServersConfig(config: CodexMcpServersConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJsonValue(config)))
    .digest("hex");
}

/** Load bundle MCP config for one Codex app-server thread. */
export function loadCodexBundleMcpThreadConfig(
  params: LoadCodexBundleMcpThreadConfigParams,
): CodexBundleMcpThreadConfig {
  const shouldCreateRuntime = shouldCreateBundleMcpRuntimeForAttempt({
    toolsEnabled: params.toolsEnabled ?? true,
    disableTools: params.disableTools,
    toolsAllow: params.toolsAllow,
  });
  if (!shouldCreateRuntime) {
    return {
      diagnostics: [],
      evaluated: true,
    };
  }
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const mcpServers = buildCodexMcpServersConfig(bundleMcp.config);
  if (Object.keys(mcpServers).length === 0) {
    return {
      diagnostics: bundleMcp.diagnostics,
      evaluated: true,
    };
  }
  return {
    configPatch: {
      mcp_servers: mcpServers,
    },
    diagnostics: bundleMcp.diagnostics,
    evaluated: true,
    fingerprint: fingerprintCodexMcpServersConfig(mcpServers),
  };
}
