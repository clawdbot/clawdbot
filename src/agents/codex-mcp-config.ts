/**
 * Projects enabled bundle MCP servers into Codex app-server thread config.
 * The projection keeps loopback approval defaults and header env placeholders
 * compatible with Codex's MCP config shape.
 */
import crypto from "node:crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import { isRecord } from "../utils.js";
import {
  decodeHeaderEnvPlaceholder,
  normalizeBundleMcpServerConfig,
  normalizeMcpStringRecord,
} from "./bundle-mcp-adapter.js";
import { prepareOwnedBundleMcpDataDirs } from "./bundle-mcp-config.js";
import type {
  CodexBundleMcpThreadConfig,
  CodexMcpServersConfig,
  LoadCodexBundleMcpThreadConfigParams,
} from "./codex-mcp-config.types.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { resolveProjectedMcpCodexToolApprovalMode } from "./mcp-codex-tool-approval.js";
import { partitionMcpServersByConnectionScope } from "./mcp-connection-resolver.js";

function assertCodexExactToolFilters(
  serverName: string,
  fieldName: "include" | "exclude",
  patterns: string[],
): void {
  const wildcard = patterns.find((pattern) => pattern.includes("*"));
  if (!wildcard) {
    return;
  }
  const codexFieldName = fieldName === "include" ? "enabled_tools" : "disabled_tools";
  throw new Error(
    `Cannot project mcp.servers.${serverName}.toolFilter.${fieldName} pattern "${wildcard}" into Codex ${codexFieldName}: Codex MCP projection only supports exact tool names.`,
  );
}

function applyCodexToolFilter(
  next: Record<string, unknown>,
  name: string,
  server: BundleMcpServerConfig,
): void {
  if (!isRecord(server.toolFilter)) {
    return;
  }
  const include = normalizeTrimmedStringList(server.toolFilter.include);
  const exclude = normalizeTrimmedStringList(server.toolFilter.exclude);
  assertCodexExactToolFilters(name, "include", include);
  assertCodexExactToolFilters(name, "exclude", exclude);
  if (include.length > 0) {
    next.enabled_tools = include;
  }
  if (exclude.length > 0) {
    next.disabled_tools = exclude;
  }
}

/** Adds exact session denials to a server's configured filter before Codex projection. */
export function applyCodexSessionMcpToolDenials(
  name: string,
  server: BundleMcpServerConfig,
  toolOverrides?: Pick<SessionToolOverrides, "mcpToolsDeny">,
): BundleMcpServerConfig {
  const denialMap = toolOverrides?.mcpToolsDeny;
  const denied = denialMap && Object.hasOwn(denialMap, name) ? denialMap[name] : undefined;
  if (!denied?.length) {
    return server;
  }
  const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : {};
  const existing = normalizeTrimmedStringList(toolFilter.exclude);
  return {
    ...server,
    toolFilter: {
      ...toolFilter,
      exclude: [...new Set([...existing, ...denied])].toSorted(),
    },
  };
}

/** Normalizes one bundle MCP server into Codex's mcp_servers shape. */
export function normalizeCodexMcpServerConfig(
  name: string,
  server: BundleMcpServerConfig,
): Record<string, unknown> {
  const next = normalizeBundleMcpServerConfig(server);
  applyCodexToolFilter(next, name, server);
  const defaultToolsApprovalMode = resolveProjectedMcpCodexToolApprovalMode(name, server);
  if (defaultToolsApprovalMode) {
    next.default_tools_approval_mode = defaultToolsApprovalMode;
  }
  const httpHeaders = normalizeMcpStringRecord(server.headers);
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

/**
 * Build Codex `mcp_servers` config from normalized bundle MCP config.
 * Requester-scoped servers are excluded: harness-native MCP clients are
 * session-shared and must never dial placeholder or requester-bound URLs.
 */
export function buildCodexMcpServersConfig(config: BundleMcpConfig): CodexMcpServersConfig {
  const { staticServers } = partitionMcpServersByConnectionScope(config.mcpServers);
  return Object.fromEntries(
    Object.entries(staticServers).map(([name, server]) => [
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
export function loadCodexBundleMcpThreadConfigCore(
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
      staticServerNames: [],
      userStaticServerNames: [],
    };
  }
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
  const serverOverrides = params.toolOverrides?.mcpServers;
  const effectiveConfig: BundleMcpConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(bundleMcp.config.mcpServers)
        .filter(([name]) => {
          const override =
            serverOverrides && Object.hasOwn(serverOverrides, name)
              ? serverOverrides[name]
              : undefined;
          return (
            override !== false && (override === true || configuredMcp[name]?.enabled !== false)
          );
        })
        .map(([name, server]) => [
          name,
          applyCodexSessionMcpToolDenials(name, server, params.toolOverrides),
        ]),
    ),
  };
  const enabledConfiguredMcp = Object.fromEntries(
    Object.entries(configuredMcp).filter(([name, server]) => {
      const override =
        serverOverrides && Object.hasOwn(serverOverrides, name) ? serverOverrides[name] : undefined;
      return override !== false && (override === true || server.enabled !== false);
    }),
  );
  // The native thread projection has separate bundle and owner-config paths,
  // but scheduled ownership covers their one merged static execution surface.
  const { staticServers: configuredStaticServers } = partitionMcpServersByConnectionScope({
    ...effectiveConfig.mcpServers,
    ...enabledConfiguredMcp,
  });
  const { staticServers: userStaticServers } =
    partitionMcpServersByConnectionScope(enabledConfiguredMcp);
  const staticServerNames = Object.keys(configuredStaticServers).toSorted((left, right) =>
    left.localeCompare(right),
  );
  const userStaticServerNames = Object.keys(userStaticServers).toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (params.preparationOnly && Object.keys(bundleMcp.prepareDataDirsByServer ?? {}).length) {
    throw new Error(
      "Native fork preparation cannot provision plugin data directories. Complete plugin setup before retrying.",
    );
  }
  const preparedDataDirs = prepareOwnedBundleMcpDataDirs({
    config: effectiveConfig,
    prepareDataDirsByServer: bundleMcp.prepareDataDirsByServer ?? {},
  });
  const diagnostics = [...bundleMcp.diagnostics, ...preparedDataDirs.diagnostics];
  const mcpServers = buildCodexMcpServersConfig(preparedDataDirs.config);
  if (Object.keys(mcpServers).length === 0) {
    return {
      diagnostics,
      evaluated: true,
      staticServerNames,
      userStaticServerNames,
    };
  }
  return {
    configPatch: {
      mcp_servers: mcpServers,
    },
    diagnostics,
    evaluated: true,
    fingerprint: fingerprintCodexMcpServersConfig(mcpServers),
    staticServerNames,
    userStaticServerNames,
  };
}
