import {
  createMigrationItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
  MIGRATION_REASON_TARGET_EXISTS,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { childRecord, isRecord, readJsonObject, sanitizeName } from "./helpers.js";
import type { ClaudeSource } from "./source.js";

type ConfigPatchDetails = {
  path: string[];
  value: unknown;
};

type MappedMcpSource = {
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  servers: Record<string, unknown>;
};

const CONFIG_RUNTIME_UNAVAILABLE = "config runtime unavailable";
const MISSING_CONFIG_PATCH = "missing config patch";

class ConfigPatchConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ConfigPatchConflictError";
  }
}

function readPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function mergeValue(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) {
    return structuredClone(right);
  }
  const next: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    next[key] = mergeValue(next[key], value);
  }
  return next;
}

function writePath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (!leaf) {
    return;
  }
  current[leaf] = mergeValue(current[leaf], value);
}

function hasPatchConflict(
  config: MigrationProviderContext["config"],
  path: readonly string[],
  value: unknown,
): boolean {
  if (!isRecord(value)) {
    return readPath(config as Record<string, unknown>, path) !== undefined;
  }
  const existing = readPath(config as Record<string, unknown>, path);
  if (!isRecord(existing)) {
    return false;
  }
  return Object.keys(value).some((key) => existing[key] !== undefined);
}

function createConfigPatchItem(params: {
  id: string;
  target: string;
  path: string[];
  value: unknown;
  message: string;
  conflict?: boolean;
  reason?: string;
  source?: string;
  details?: Record<string, unknown>;
}): MigrationItem {
  return createMigrationItem({
    id: params.id,
    kind: "config",
    action: "merge",
    source: params.source,
    target: params.target,
    status: params.conflict ? "conflict" : "planned",
    reason: params.conflict ? (params.reason ?? MIGRATION_REASON_TARGET_EXISTS) : undefined,
    message: params.message,
    details: { ...params.details, path: params.path, value: params.value },
  });
}

function createManualItem(params: {
  id: string;
  source: string;
  message: string;
  recommendation: string;
}): MigrationItem {
  return createMigrationItem({
    id: params.id,
    kind: "manual",
    action: "manual",
    source: params.source,
    status: "skipped",
    message: params.message,
    reason: params.recommendation,
  });
}

function mapMcpServers(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!name.trim() || !isRecord(value)) {
      continue;
    }
    const next: Record<string, unknown> = {};
    for (const key of [
      "command",
      "args",
      "env",
      "cwd",
      "workingDirectory",
      "url",
      "type",
      "transport",
      "headers",
      "connectionTimeoutMs",
    ]) {
      if (value[key] !== undefined) {
        next[key] = value[key];
      }
    }
    if (Object.keys(next).length > 0) {
      mapped[name] = next;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

async function collectMcpSources(source: ClaudeSource): Promise<MappedMcpSource[]> {
  const sources: MappedMcpSource[] = [];
  const projectMcp = await readJsonObject(source.projectMcpPath);
  const projectServers = mapMcpServers(projectMcp.mcpServers ?? projectMcp);
  if (projectServers && source.projectMcpPath) {
    sources.push({
      sourceId: "project-mcp",
      sourceLabel: "project .mcp.json",
      sourcePath: source.projectMcpPath,
      servers: projectServers,
    });
  }

  const claudeJson = await readJsonObject(source.userClaudeJsonPath);
  const userServers = mapMcpServers(claudeJson.mcpServers);
  if (userServers && source.userClaudeJsonPath) {
    sources.push({
      sourceId: "user-claude-json",
      sourceLabel: "user ~/.claude.json",
      sourcePath: source.userClaudeJsonPath,
      servers: userServers,
    });
  }

  if (source.projectDir) {
    const projectRecord = childRecord(childRecord(claudeJson, "projects"), source.projectDir);
    const projectScopedServers = mapMcpServers(projectRecord.mcpServers);
    if (projectScopedServers && source.userClaudeJsonPath) {
      sources.push({
        sourceId: "user-claude-json-project",
        sourceLabel: "project entry in ~/.claude.json",
        sourcePath: source.userClaudeJsonPath,
        servers: projectScopedServers,
      });
    }
  }

  const desktopConfig = await readJsonObject(source.desktopConfigPath);
  const desktopServers = mapMcpServers(desktopConfig.mcpServers);
  if (desktopServers && source.desktopConfigPath) {
    sources.push({
      sourceId: "desktop",
      sourceLabel: "Claude Desktop config",
      sourcePath: source.desktopConfigPath,
      servers: desktopServers,
    });
  }
  return sources;
}

export async function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  source: ClaudeSource;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  const mcpSources = await collectMcpSources(params.source);
  const counts = new Map<string, number>();
  for (const mcpSource of mcpSources) {
    for (const name of Object.keys(mcpSource.servers)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  for (const mcpSource of mcpSources) {
    for (const [name, value] of Object.entries(mcpSource.servers)) {
      const patch = { [name]: value };
      const duplicate = (counts.get(name) ?? 0) > 1;
      const conflict =
        duplicate ||
        (!params.ctx.overwrite && hasPatchConflict(params.ctx.config, ["mcp", "servers"], patch));
      items.push(
        createConfigPatchItem({
          id: `config:mcp-server:${sanitizeName(mcpSource.sourceId)}:${sanitizeName(name)}`,
          source: mcpSource.sourcePath,
          target: `mcp.servers.${name}`,
          path: ["mcp", "servers"],
          value: patch,
          message: `Import Claude MCP server "${name}" from ${mcpSource.sourceLabel}.`,
          conflict,
          reason: duplicate
            ? `multiple Claude MCP sources define "${name}"`
            : MIGRATION_REASON_TARGET_EXISTS,
          details: { sourceLabel: mcpSource.sourceLabel },
        }),
      );
    }
  }

  for (const settingsPath of [
    params.source.userSettingsPath,
    params.source.userLocalSettingsPath,
    params.source.projectSettingsPath,
    params.source.projectLocalSettingsPath,
  ]) {
    const settings = await readJsonObject(settingsPath);
    if (settingsPath && settings.hooks !== undefined) {
      items.push(
        createManualItem({
          id: `manual:hooks:${sanitizeName(settingsPath)}`,
          source: settingsPath,
          message: "Claude hooks were found but are not enabled automatically.",
          recommendation: "Review hook commands before recreating equivalent OpenClaw automation.",
        }),
      );
    }
    if (settingsPath && settings.permissions !== undefined) {
      items.push(
        createManualItem({
          id: `manual:permissions:${sanitizeName(settingsPath)}`,
          source: settingsPath,
          message: "Claude permission settings were found but are not translated automatically.",
          recommendation:
            "Review deny and allow rules manually. Do not import broad allow rules without a policy review.",
        }),
      );
    }
    if (settingsPath && settings.env !== undefined) {
      items.push(
        createManualItem({
          id: `manual:env:${sanitizeName(settingsPath)}`,
          source: settingsPath,
          message: "Claude environment defaults were found but are not copied automatically.",
          recommendation:
            "Move non-secret values manually and store credentials through OpenClaw credential flows.",
        }),
      );
    }
  }

  return items;
}

function readConfigPatchDetails(item: MigrationItem): ConfigPatchDetails | undefined {
  const path = item.details?.path;
  if (
    !Array.isArray(path) ||
    !path.every((segment): segment is string => typeof segment === "string")
  ) {
    return undefined;
  }
  return { path, value: item.details?.value };
}

export async function applyConfigItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const details = readConfigPatchDetails(item);
  if (!details) {
    return markMigrationItemError(item, MISSING_CONFIG_PATCH);
  }
  const configApi = ctx.runtime?.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return markMigrationItemError(item, CONFIG_RUNTIME_UNAVAILABLE);
  }
  try {
    const currentConfig = configApi.current() as MigrationProviderContext["config"];
    if (!ctx.overwrite && hasPatchConflict(currentConfig, details.path, details.value)) {
      return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
    }
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        if (!ctx.overwrite && hasPatchConflict(draft, details.path, details.value)) {
          throw new ConfigPatchConflictError(MIGRATION_REASON_TARGET_EXISTS);
        }
        writePath(draft as Record<string, unknown>, details.path, details.value);
      },
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    if (err instanceof ConfigPatchConflictError) {
      return markMigrationItemConflict(item, err.reason);
    }
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}

export function applyManualItem(item: MigrationItem): MigrationItem {
  return markMigrationItemSkipped(item, item.reason ?? "manual follow-up required");
}
