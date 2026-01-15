import { createJiti } from "jiti";

import type { ClawdbotConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging.js";
import { resolveUserPath } from "../utils.js";
import { discoverClawdbotPlugins } from "./discovery.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
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
  entries: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
};

const registryCache = new Map<string, PluginRegistry>();

const defaultLogger = () => createSubsystemLogger("plugins");

const normalizeList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
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
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow),
    deny: normalizeList(config?.deny),
    loadPaths: normalizeList(config?.load?.paths),
    entries: normalizePluginEntries(config?.entries),
  };
};

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}

function resolveEnableState(
  id: string,
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
  const entry = config.entries[id];
  if (entry?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
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
    channelIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    httpHandlers: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
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

  const { registry, createApi } = createPluginRegistry({
    logger,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverClawdbotPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  pushDiagnostics(registry.diagnostics, discovery.diagnostics);

  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
  });

  for (const candidate of discovery.candidates) {
    const enableState = resolveEnableState(candidate.idHint, normalized);
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
      continue;
    }

    let mod: ClawdbotPluginModule | null = null;
    try {
      mod = jiti(candidate.source) as ClawdbotPluginModule;
    } catch (err) {
      record.status = "error";
      record.error = String(err);
      registry.plugins.push(record);
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

    const validatedConfig = validatePluginConfig({
      schema: definition?.configSchema,
      value: entry?.config,
    });

    if (!validatedConfig.ok) {
      record.status = "error";
      record.error = `invalid config: ${validatedConfig.errors?.join(", ")}`;
      registry.plugins.push(record);
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
    } catch (err) {
      record.status = "error";
      record.error = String(err);
      registry.plugins.push(record);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin failed during register: ${String(err)}`,
      });
    }
  }

  if (cacheEnabled) {
    registryCache.set(cacheKey, registry);
  }
  setActivePluginRegistry(registry, cacheKey);
  return registry;
}
