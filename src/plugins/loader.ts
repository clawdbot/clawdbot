import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import type { ClawdbotConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging.js";
import { resolveUserPath } from "../utils.js";
import { discoverClawdbotPlugins } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import { setActivePluginRegistry } from "./runtime.js";
import type {
  ClawdbotPluginConfigSchema,
  ClawdbotPluginDefinition,
  ClawdbotPluginModule,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: ClawdbotConfig;
  workspaceDir?: string;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  cache?: boolean;
};

type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
  };
  entries: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
};

const registryCache = new Map<string, PluginRegistry>();

const defaultLogger = () => createSubsystemLogger("plugins");

const normalizeList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
};

const normalizeSlotValue = (value: unknown): string | null | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "none") return null;
  return trimmed;
};

const normalizePluginEntries = (entries: unknown): NormalizedPluginsConfig["entries"] => {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.trim()) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      normalized[key] = {};
      continue;
    }
    const entry = value as Record<string, unknown>;
    normalized[key] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      config:
        entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
          ? (entry.config as Record<string, unknown>)
          : undefined,
    };
  }
  return normalized;
};

const normalizePluginsConfig = (config?: ClawdbotConfig["plugins"]): NormalizedPluginsConfig => {
  const memorySlot = normalizeSlotValue(config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow),
    deny: normalizeList(config?.deny),
    loadPaths: normalizeList(config?.load?.paths),
    slots: {
      memory: memorySlot ?? "memory-core",
    },
    entries: normalizePluginEntries(config?.entries),
  };
};

const resolvePluginSdkAlias = (): string | null => {
  try {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const distCandidate = path.join(cursor, "dist", "plugin-sdk", "index.js");
      if (fs.existsSync(distCandidate)) return distCandidate;
      const srcCandidate = path.join(cursor, "src", "plugin-sdk", "index.ts");
      if (fs.existsSync(srcCandidate)) return srcCandidate;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    // ignore
  }
  return null;
};

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}

function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (params.kind !== "memory") return { enabled: true };
  if (params.slot === null) {
    return { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return {
      enabled: false,
      reason: `memory slot set to "${params.slot}"`,
    };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return {
      enabled: false,
      reason: `memory slot already filled by "${params.selectedId}"`,
    };
  }
  return { enabled: true, selected: true };
}

function resolveEnableState(
  id: string,
  origin: PluginRecord["origin"],
  config: NormalizedPluginsConfig,
): { enabled: boolean; reason?: string } {
  if (!config.enabled) {
    return { enabled: false, reason: "plugins disabled" };
  }
  if (config.deny.includes(id)) {
    return { enabled: false, reason: "blocked by denylist" };
  }
  if (config.allow.length > 0 && !config.allow.includes(id)) {
    return { enabled: false, reason: "not in allowlist" };
  }
  if (config.slots.memory === id) {
    return { enabled: true };
  }
  const entry = config.entries[id];
  if (entry?.enabled === true) {
    return { enabled: true };
  }
  if (entry?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }
  if (origin === "bundled") {
    return { enabled: false, reason: "bundled (disabled by default)" };
  }
  return { enabled: true };
}

function validatePluginConfig(params: {
  schema?: ClawdbotPluginConfigSchema;
  value?: Record<string, unknown>;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) return { ok: true, value: params.value };

  if (typeof schema.validate === "function") {
    const result = schema.validate(params.value);
    if (result.ok) {
      return { ok: true, value: result.value as Record<string, unknown> };
    }
    return { ok: false, errors: result.errors };
  }

  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(params.value);
    if (result.success) {
      return { ok: true, value: result.data as Record<string, unknown> };
    }
    const issues = result.error?.issues ?? [];
    const errors = issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    });
    return { ok: false, errors };
  }

  if (typeof schema.parse === "function") {
    try {
      const parsed = schema.parse(params.value);
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (err) {
      return { ok: false, errors: [String(err)] };
    }
  }

  return { ok: true, value: params.value };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: ClawdbotPluginDefinition;
  register?: ClawdbotPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as ClawdbotPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as ClawdbotPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  configSchema: boolean;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
  };
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

export function loadClawdbotPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const cfg = options.config ?? {};
  const logger = options.logger ?? defaultLogger();
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      setActivePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  const runtime = createPluginRuntime();
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverClawdbotPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  pushDiagnostics(registry.diagnostics, discovery.diagnostics);

  const pluginSdkAlias = resolvePluginSdkAlias();
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    ...(pluginSdkAlias ? { alias: { "clawdbot/plugin-sdk": pluginSdkAlias } } : {}),
  });

  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  let memorySlotMatched = false;

  for (const candidate of discovery.candidates) {
    const existingOrigin = seenIds.get(candidate.idHint);
    if (existingOrigin) {
      const record = createPluginRecord({
        id: candidate.idHint,
        name: candidate.packageName ?? candidate.idHint,
        description: candidate.packageDescription,
        version: candidate.packageVersion,
        source: candidate.source,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: false,
        configSchema: false,
      });
      record.status = "disabled";
      record.error = `overridden by ${existingOrigin} plugin`;
      registry.plugins.push(record);
      continue;
    }

    const enableState = resolveEnableState(candidate.idHint, candidate.origin, normalized);
    const entry = normalized.entries[candidate.idHint];
    const record = createPluginRecord({
      id: candidate.idHint,
      name: candidate.packageName ?? candidate.idHint,
      description: candidate.packageDescription,
      version: candidate.packageVersion,
      source: candidate.source,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: enableState.enabled,
      configSchema: false,
    });

    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      registry.plugins.push(record);
      seenIds.set(candidate.idHint, candidate.origin);
      continue;
    }

    let mod: ClawdbotPluginModule | null = null;
    try {
      mod = jiti(candidate.source) as ClawdbotPluginModule;
    } catch (err) {
      record.status = "error";
      record.error = String(err);
      registry.plugins.push(record);
      seenIds.set(candidate.idHint, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `failed to load plugin: ${String(err)}`,
      });
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const definition = resolved.definition;
    const register = resolved.register;

    if (definition?.id && definition.id !== record.id) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
      });
    }

    record.name = definition?.name ?? record.name;
    record.description = definition?.description ?? record.description;
    record.version = definition?.version ?? record.version;
    record.kind = definition?.kind;
    record.configSchema = Boolean(definition?.configSchema);
    record.configUiHints =
      definition?.configSchema &&
      typeof definition.configSchema === "object" &&
      (definition.configSchema as { uiHints?: unknown }).uiHints &&
      typeof (definition.configSchema as { uiHints?: unknown }).uiHints === "object" &&
      !Array.isArray((definition.configSchema as { uiHints?: unknown }).uiHints)
        ? ((definition.configSchema as { uiHints?: unknown }).uiHints as Record<
            string,
            PluginConfigUiHint
          >)
        : undefined;
    record.configJsonSchema =
      definition?.configSchema &&
      typeof definition.configSchema === "object" &&
      (definition.configSchema as { jsonSchema?: unknown }).jsonSchema &&
      typeof (definition.configSchema as { jsonSchema?: unknown }).jsonSchema === "object" &&
      !Array.isArray((definition.configSchema as { jsonSchema?: unknown }).jsonSchema)
        ? ((definition.configSchema as { jsonSchema?: unknown }).jsonSchema as Record<
            string,
            unknown
          >)
        : undefined;

    if (record.kind === "memory" && memorySlot === record.id) {
      memorySlotMatched = true;
    }

    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });

    if (!memoryDecision.enabled) {
      record.enabled = false;
      record.status = "disabled";
      record.error = memoryDecision.reason;
      registry.plugins.push(record);
      seenIds.set(candidate.idHint, candidate.origin);
      continue;
    }

    if (memoryDecision.selected && record.kind === "memory") {
      selectedMemoryPluginId = record.id;
    }

    const validatedConfig = validatePluginConfig({
      schema: definition?.configSchema,
      value: entry?.config,
    });

    if (!validatedConfig.ok) {
      record.status = "error";
      record.error = `invalid config: ${validatedConfig.errors?.join(", ")}`;
      registry.plugins.push(record);
      seenIds.set(candidate.idHint, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    if (typeof register !== "function") {
      record.status = "error";
      record.error = "plugin export missing register/activate";
      registry.plugins.push(record);
      seenIds.set(candidate.idHint, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    const api = createApi(record, {
      config: cfg,
      pluginConfig: validatedConfig.value,
    });

    try {
      const result = register(api);
      if (result && typeof (result as Promise<void>).then === "function") {
        registry.diagnostics.push({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: "plugin register returned a promise; async registration is ignored",
        });
      }
      registry.plugins.push(record);
      seenIds.set(candidate.idHint, candidate.origin);
    } catch (err) {
      record.status = "error";
      record.error = String(err);
      registry.plugins.push(record);
      seenIds.set(candidate.idHint, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin failed during register: ${String(err)}`,
      });
    }
  }

  if (typeof memorySlot === "string" && !memorySlotMatched) {
    registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
    });
  }

  if (cacheEnabled) {
    registryCache.set(cacheKey, registry);
  }
  setActivePluginRegistry(registry, cacheKey);
  initializeGlobalHookRunner(registry);
  return registry;
}
