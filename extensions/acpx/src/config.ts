import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { z } from "openclaw/plugin-sdk/zod";
import { AcpxPluginConfigSchema, DEFAULT_ACPX_TIMEOUT_SECONDS } from "./config-schema.js";
import type {
  AcpxPluginConfig,
  AcpxPermissionMode,
  AcpxNonInteractivePermissionPolicy,
  McpServerConfig,
  AcpxMcpServer,
  ResolvedAcpxPluginConfig,
} from "./config-schema.js";
export {
  ACPX_NON_INTERACTIVE_POLICIES,
  ACPX_PERMISSION_MODES,
  type AcpxMcpServer,
  type AcpxNonInteractivePermissionPolicy,
  type AcpxPermissionMode,
  type AcpxPluginConfig,
  type McpServerConfig,
  type ResolvedAcpxPluginConfig,
  createAcpxPluginConfigSchema,
} from "./config-schema.js";

export const ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME = "openclaw-plugin-tools";

function isAcpxPluginRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "openclaw.plugin.json")) &&
    fs.existsSync(path.join(dir, "package.json"))
  );
}

function resolveNearestAcpxPluginRoot(moduleUrl: string): string {
  let cursor = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 3; i += 1) {
    // Bundled entries live at the plugin root while source files still live under src/.
    if (isAcpxPluginRoot(cursor)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

function resolveWorkspaceAcpxPluginRoot(currentRoot: string): string | null {
  if (
    path.basename(currentRoot) !== "acpx" ||
    path.basename(path.dirname(currentRoot)) !== "extensions" ||
    path.basename(path.dirname(path.dirname(currentRoot))) !== "dist"
  ) {
    return null;
  }
  const workspaceRoot = path.resolve(currentRoot, "..", "..", "..", "extensions", "acpx");
  return isAcpxPluginRoot(workspaceRoot) ? workspaceRoot : null;
}

function resolveRepoAcpxPluginRoot(currentRoot: string): string | null {
  const workspaceRoot = path.join(currentRoot, "extensions", "acpx");
  return isAcpxPluginRoot(workspaceRoot) ? workspaceRoot : null;
}

function resolveAcpxPluginRootFromOpenClawLayout(moduleUrl: string): string | null {
  let cursor = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 5; i += 1) {
    const candidates = [
      path.join(cursor, "extensions", "acpx"),
      path.join(cursor, "dist", "extensions", "acpx"),
      path.join(cursor, "dist-runtime", "extensions", "acpx"),
    ];
    for (const candidate of candidates) {
      if (isAcpxPluginRoot(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}
export function resolveAcpxPluginRoot(moduleUrl: string = import.meta.url): string {
  const resolvedRoot = resolveNearestAcpxPluginRoot(moduleUrl);
  // In a live repo checkout, dist/ can be rebuilt out from under the running gateway.
  // Prefer the stable source plugin root when a built extension is running beside it.
  return (
    resolveWorkspaceAcpxPluginRoot(resolvedRoot) ??
    resolveRepoAcpxPluginRoot(resolvedRoot) ??
    // Shared dist/dist-runtime chunks can load this module outside the plugin tree.
    // Scan common OpenClaw layouts before falling back to the nearest path guess.
    resolveAcpxPluginRootFromOpenClawLayout(moduleUrl) ??
    resolvedRoot
  );
}

export const ACPX_PLUGIN_ROOT = resolveAcpxPluginRoot();

const DEFAULT_PERMISSION_MODE: AcpxPermissionMode = "approve-reads";
const DEFAULT_NON_INTERACTIVE_POLICY: AcpxNonInteractivePermissionPolicy = "fail";
const DEFAULT_QUEUE_OWNER_TTL_SECONDS = 0.1;
const DEFAULT_STRICT_WINDOWS_CMD_WRAPPER = true;

type ParseResult =
  | { ok: true; value: AcpxPluginConfig | undefined }
  | { ok: false; message: string };

function formatAcpxConfigIssue(issue: z.ZodIssue | undefined): string {
  if (!issue) {
    return "invalid config";
  }
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return `unknown config key: ${issue.keys[0]}`;
  }
  if (issue.code === "invalid_type" && issue.path.length === 0) {
    return "expected config object";
  }
  return issue.message;
}

function parseAcpxPluginConfig(value: unknown): ParseResult {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = AcpxPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, message: formatAcpxConfigIssue(parsed.error.issues[0]) };
  }
  return {
    ok: true,
    value: parsed.data as AcpxPluginConfig,
  };
}

function resolveOpenClawRoot(currentRoot: string): string {
  if (
    path.basename(currentRoot) === "acpx" &&
    path.basename(path.dirname(currentRoot)) === "extensions"
  ) {
    const parent = path.dirname(path.dirname(currentRoot));
    if (path.basename(parent) === "dist") {
      return path.dirname(parent);
    }
    return parent;
  }
  return path.resolve(currentRoot, "..");
}

export function resolvePluginToolsMcpServerConfig(
  moduleUrl: string = import.meta.url,
): McpServerConfig {
  const pluginRoot = resolveAcpxPluginRoot(moduleUrl);
  const openClawRoot = resolveOpenClawRoot(pluginRoot);
  const distEntry = path.join(openClawRoot, "dist", "mcp", "plugin-tools-serve.js");
  if (fs.existsSync(distEntry)) {
    return {
      command: process.execPath,
      args: [distEntry],
    };
  }
  const sourceEntry = path.join(openClawRoot, "src", "mcp", "plugin-tools-serve.ts");
  return {
    command: process.execPath,
    args: ["--import", "tsx", sourceEntry],
  };
}

function resolveConfiguredMcpServers(params: {
  mcpServers?: Record<string, McpServerConfig>;
  pluginToolsMcpBridge: boolean;
  moduleUrl?: string;
}): Record<string, McpServerConfig> {
  const resolved = { ...params.mcpServers };
  if (!params.pluginToolsMcpBridge) {
    return resolved;
  }
  if (resolved[ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME]) {
    throw new Error(
      `mcpServers.${ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME} is reserved when pluginToolsMcpBridge=true`,
    );
  }
  resolved[ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME] = resolvePluginToolsMcpServerConfig(params.moduleUrl);
  return resolved;
}

export function toAcpMcpServers(mcpServers: Record<string, McpServerConfig>): AcpxMcpServer[] {
  return Object.entries(mcpServers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
      name: envName,
      value,
    })),
  }));
}

export function resolveAcpxPluginConfig(params: {
  rawConfig: unknown;
  workspaceDir?: string;
  moduleUrl?: string;
}): ResolvedAcpxPluginConfig {
  const parsed = parseAcpxPluginConfig(params.rawConfig);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  const normalized = parsed.value ?? {};
  const workspaceDir = params.workspaceDir?.trim() || process.cwd();
  const fallbackCwd = workspaceDir;
  const cwd = path.resolve(normalized.cwd?.trim() || fallbackCwd);
  const stateDir = path.resolve(normalized.stateDir?.trim() || path.join(workspaceDir, "state"));
  const pluginToolsMcpBridge = normalized.pluginToolsMcpBridge === true;
  const mcpServers = resolveConfiguredMcpServers({
    mcpServers: normalized.mcpServers,
    pluginToolsMcpBridge,
    moduleUrl: params.moduleUrl,
  });
  const agents = Object.fromEntries(
    Object.entries(normalized.agents ?? {}).map(([name, entry]) => [
      normalizeLowercaseStringOrEmpty(name),
      entry.command.trim(),
    ]),
  );

  return {
    cwd,
    stateDir,
    permissionMode: normalized.permissionMode ?? DEFAULT_PERMISSION_MODE,
    nonInteractivePermissions:
      normalized.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE_POLICY,
    pluginToolsMcpBridge,
    strictWindowsCmdWrapper:
      normalized.strictWindowsCmdWrapper ?? DEFAULT_STRICT_WINDOWS_CMD_WRAPPER,
    timeoutSeconds: normalized.timeoutSeconds ?? DEFAULT_ACPX_TIMEOUT_SECONDS,
    queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds ?? DEFAULT_QUEUE_OWNER_TTL_SECONDS,
    legacyCompatibilityConfig: {
      strictWindowsCmdWrapper: normalized.strictWindowsCmdWrapper,
      queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds,
    },
    mcpServers,
    agents,
  };
}
