import {
  applyMigrationConfigPatchItem,
  applyMigrationManualItem,
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  MIGRATION_REASON_TARGET_EXISTS,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { childRecord, isRecord, readJsonObject, sanitizeName } from "./helpers.js";
import type { ClaudeSource } from "./source.js";

type MappedMcpSource = {
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  servers: Record<string, unknown>;
};

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
        (!params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, ["mcp", "servers"], patch));
      items.push(
        createMigrationConfigPatchItem({
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
        createMigrationManualItem({
          id: `manual:hooks:${sanitizeName(settingsPath)}`,
          source: settingsPath,
          message: "Claude hooks were found but are not enabled automatically.",
          recommendation: "Review hook commands before recreating equivalent OpenClaw automation.",
        }),
      );
    }
    if (settingsPath && settings.permissions !== undefined) {
      items.push(
        createMigrationManualItem({
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
        createMigrationManualItem({
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

export async function applyConfigItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  return applyMigrationConfigPatchItem(ctx, item);
}

export function applyManualItem(item: MigrationItem): MigrationItem {
  return applyMigrationManualItem(item);
}
