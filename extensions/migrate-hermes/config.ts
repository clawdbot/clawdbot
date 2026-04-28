import {
  createMigrationItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
  MIGRATION_REASON_TARGET_EXISTS,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { childRecord, isRecord, readString, readStringArray } from "./helpers.js";

type HermesProviderConfig = {
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  models: string[];
};

type ConfigPatchDetails = {
  path: string[];
  value: unknown;
};

const CONFIG_RUNTIME_UNAVAILABLE = "config runtime unavailable";
const MISSING_CONFIG_PATCH = "missing config patch";

class ConfigPatchConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ConfigPatchConflictError";
  }
}

function envKeyForProvider(providerId: string): string {
  return `${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_API_KEY`;
}

function splitProviderModel(modelRef: string | undefined): { provider?: string; model?: string } {
  if (!modelRef) {
    return {};
  }
  const slash = modelRef.indexOf("/");
  if (slash > 0 && slash < modelRef.length - 1) {
    return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
  }
  return { model: modelRef };
}

function modelDefinition(modelId: string, baseUrl?: string): Record<string, unknown> {
  return {
    id: modelId,
    name: modelId,
    api: baseUrl ? "openai-completions" : "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...(baseUrl ? { baseUrl } : {}),
    metadataSource: "models-add",
  };
}

function providerConfig(entry: HermesProviderConfig): Record<string, unknown> {
  const models = entry.models.length > 0 ? entry.models : [`${entry.id}/default`];
  return {
    baseUrl: entry.baseUrl ?? "",
    ...(entry.apiKeyEnv
      ? { apiKey: { source: "env", provider: "default", id: entry.apiKeyEnv } }
      : {}),
    api: "openai-completions",
    models: models.map((modelId) => modelDefinition(modelId, entry.baseUrl)),
  };
}

export function collectHermesProviders(
  config: Record<string, unknown>,
  modelRef?: string,
): HermesProviderConfig[] {
  const collected: HermesProviderConfig[] = [];
  for (const [id, raw] of Object.entries(childRecord(config, "providers"))) {
    if (!isRecord(raw)) {
      continue;
    }
    const baseUrl =
      readString(raw.base_url) ??
      readString(raw.baseUrl) ??
      readString(raw.url) ??
      readString(raw.api);
    const apiKeyEnv =
      readString(raw.api_key_env) ??
      readString(raw.apiKeyEnv) ??
      readString(raw.env) ??
      envKeyForProvider(id);
    const models = [
      ...readStringArray(raw.models),
      ...Object.keys(childRecord(raw, "models")),
      readString(raw.model),
    ].filter((value): value is string => Boolean(value));
    collected.push({ id, baseUrl, apiKeyEnv, models: [...new Set(models)] });
  }

  const customProviders = config.custom_providers;
  if (Array.isArray(customProviders)) {
    for (const raw of customProviders) {
      if (!isRecord(raw)) {
        continue;
      }
      const id = readString(raw.name) ?? readString(raw.id);
      if (!id) {
        continue;
      }
      const baseUrl = readString(raw.base_url) ?? readString(raw.baseUrl) ?? readString(raw.url);
      const apiKeyEnv = readString(raw.api_key_env) ?? readString(raw.apiKeyEnv);
      const models = [
        ...readStringArray(raw.models),
        ...Object.keys(childRecord(raw, "models")),
        readString(raw.model),
      ].filter((value): value is string => Boolean(value));
      collected.push({ id, baseUrl, apiKeyEnv, models: [...new Set(models)] });
    }
  }

  const defaultRef = splitProviderModel(modelRef);
  if (defaultRef.provider && !collected.some((entry) => entry.id === defaultRef.provider)) {
    collected.push({
      id: defaultRef.provider,
      apiKeyEnv: envKeyForProvider(defaultRef.provider),
      models: defaultRef.model ? [defaultRef.model] : [],
    });
  }
  return collected;
}

function mapMcpServers(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
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

function mapSkillEntries(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries: Record<string, unknown> = {};
  for (const [skillKey, value] of Object.entries(
    childRecord(childRecord(config, "skills"), "config"),
  )) {
    if (isRecord(value)) {
      entries[skillKey] = { config: value };
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
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
}): MigrationItem {
  return createMigrationItem({
    id: params.id,
    kind: "config",
    action: "merge",
    target: params.target,
    status: params.conflict ? "conflict" : "planned",
    reason: params.conflict ? MIGRATION_REASON_TARGET_EXISTS : undefined,
    message: params.message,
    details: { path: params.path, value: params.value },
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

export function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  config: Record<string, unknown>;
  modelRef?: string;
  hasMemoryFiles?: boolean;
}): MigrationItem[] {
  const items: MigrationItem[] = [];
  const memory = childRecord(params.config, "memory");
  const memoryProvider = readString(memory.provider);

  if (params.hasMemoryFiles || memoryProvider) {
    items.push(
      createConfigPatchItem({
        id: "config:memory",
        target: "memory",
        path: ["memory"],
        value: { backend: "builtin" },
        message: "Use OpenClaw built-in file memory for imported Hermes memory files.",
        conflict:
          !params.ctx.overwrite &&
          hasPatchConflict(params.ctx.config, ["memory"], { backend: true }),
      }),
    );
    items.push(
      createConfigPatchItem({
        id: "config:memory-plugin-slot",
        target: "plugins.slots",
        path: ["plugins", "slots"],
        value: { memory: "memory-core" },
        message: "Select the default OpenClaw memory plugin for imported file memory.",
        conflict:
          !params.ctx.overwrite &&
          hasPatchConflict(params.ctx.config, ["plugins", "slots"], { memory: true }),
      }),
    );
  }

  if (memoryProvider === "honcho") {
    const value = {
      honcho: {
        enabled: true,
        config: childRecord(memory, "honcho"),
      },
    };
    items.push(
      createConfigPatchItem({
        id: "config:memory-plugin:honcho",
        target: "plugins.entries.honcho",
        path: ["plugins", "entries"],
        value,
        message: "Preserve Hermes Honcho memory settings as a plugin entry for manual activation.",
        conflict:
          !params.ctx.overwrite &&
          hasPatchConflict(params.ctx.config, ["plugins", "entries"], value),
      }),
    );
    items.push(
      createManualItem({
        id: "manual:memory-provider:honcho",
        source: "config.yaml:memory.provider",
        message:
          "Hermes used Honcho memory. OpenClaw keeps built-in memory selected until the matching plugin is installed and reviewed.",
        recommendation:
          "Install or review the Honcho memory plugin before selecting it for plugins.slots.memory.",
      }),
    );
  } else if (memoryProvider && !["builtin", "file", "files"].includes(memoryProvider)) {
    items.push(
      createManualItem({
        id: `manual:memory-provider:${memoryProvider}`,
        source: "config.yaml:memory.provider",
        message: `Hermes memory provider "${memoryProvider}" does not have a known OpenClaw mapping.`,
        recommendation: "Install or configure an equivalent OpenClaw memory plugin manually.",
      }),
    );
  }

  const providers = collectHermesProviders(params.config, params.modelRef);
  if (providers.length > 0) {
    const value = Object.fromEntries(providers.map((entry) => [entry.id, providerConfig(entry)]));
    items.push(
      createConfigPatchItem({
        id: "config:model-providers",
        target: "models.providers",
        path: ["models", "providers"],
        value,
        message: "Import Hermes provider and custom endpoint config.",
        conflict:
          !params.ctx.overwrite &&
          hasPatchConflict(params.ctx.config, ["models", "providers"], value),
      }),
    );
  }

  const mcpConfig = params.config.mcp;
  const rawMcpServers =
    params.config.mcp_servers ??
    (isRecord(mcpConfig) && isRecord(mcpConfig.servers) ? mcpConfig.servers : mcpConfig);
  const mcpServers = mapMcpServers(rawMcpServers);
  if (mcpServers) {
    items.push(
      createConfigPatchItem({
        id: "config:mcp-servers",
        target: "mcp.servers",
        path: ["mcp", "servers"],
        value: mcpServers,
        message: "Import Hermes MCP server definitions.",
        conflict:
          !params.ctx.overwrite &&
          hasPatchConflict(params.ctx.config, ["mcp", "servers"], mcpServers),
      }),
    );
  }

  const skillEntries = mapSkillEntries(params.config);
  if (skillEntries) {
    items.push(
      createConfigPatchItem({
        id: "config:skill-entries",
        target: "skills.entries",
        path: ["skills", "entries"],
        value: skillEntries,
        message: "Import Hermes skill config values.",
        conflict:
          !params.ctx.overwrite &&
          hasPatchConflict(params.ctx.config, ["skills", "entries"], skillEntries),
      }),
    );
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
