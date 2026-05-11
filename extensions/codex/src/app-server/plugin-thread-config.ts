import crypto from "node:crypto";
import {
  defaultCodexAppInventoryCache,
  type CodexAppInventoryCache,
  type CodexAppInventoryRequest,
} from "./app-inventory-cache.js";
import {
  resolveCodexPluginsPolicy,
  type ResolvedCodexPluginPolicy,
  type ResolvedCodexPluginsPolicy,
} from "./config.js";
import {
  ensureCodexPluginActivation,
  type CodexPluginActivationResult,
} from "./plugin-activation.js";
import {
  readCodexPluginInventory,
  type CodexPluginInventory,
  type CodexPluginInventoryDiagnostic,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import type { JsonObject, JsonValue } from "./protocol.js";

export type PluginAppPolicyContextEntry = {
  configKey: string;
  marketplaceName: ResolvedCodexPluginPolicy["marketplaceName"];
  pluginName: string;
  allowDestructiveActions: boolean;
  mcpServerNames: string[];
};

export type PluginAppPolicyContext = {
  fingerprint: string;
  apps: Record<string, PluginAppPolicyContextEntry>;
  pluginAppIds: Record<string, string[]>;
};

export type CodexPluginThreadConfigDiagnostic =
  | CodexPluginInventoryDiagnostic
  | {
      code: "plugin_activation_failed" | "app_not_ready";
      plugin?: ResolvedCodexPluginPolicy;
      message: string;
    };

export type CodexPluginThreadConfig = {
  enabled: boolean;
  configPatch?: JsonObject;
  fingerprint: string;
  inputFingerprint: string;
  policyContext: PluginAppPolicyContext;
  inventory?: CodexPluginInventory;
  diagnostics: CodexPluginThreadConfigDiagnostic[];
};

export type BuildCodexPluginThreadConfigParams = {
  pluginConfig?: unknown;
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey: string;
  nowMs?: number;
};

const CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION = 1;
const CODEX_PLUGIN_THREAD_CONFIG_FINGERPRINT_VERSION = 1;

export function shouldBuildCodexPluginThreadConfig(pluginConfig?: unknown): boolean {
  return resolveCodexPluginsPolicy(pluginConfig).configured;
}

export function buildCodexPluginThreadConfigInputFingerprint(params: {
  pluginConfig?: unknown;
  appCacheKey?: string;
}): string {
  const policy = resolveCodexPluginsPolicy(params.pluginConfig);
  return fingerprintJson({
    version: CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION,
    policy: policyFingerprint(policy),
    appCacheKey: params.appCacheKey ?? null,
  });
}

export async function buildCodexPluginThreadConfig(
  params: BuildCodexPluginThreadConfigParams,
): Promise<CodexPluginThreadConfig> {
  const appCache = params.appCache ?? defaultCodexAppInventoryCache;
  let inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
    pluginConfig: params.pluginConfig,
    appCacheKey: params.appCacheKey,
  });
  const policy = resolveCodexPluginsPolicy(params.pluginConfig);
  if (!policy.enabled) {
    return emptyPluginThreadConfig({
      enabled: false,
      inputFingerprint,
      configPatch: buildDisabledAppsConfigPatch(),
    });
  }

  let inventory = await readCodexPluginInventory({
    pluginConfig: params.pluginConfig,
    policy,
    request: params.request,
    appCache,
    appCacheKey: params.appCacheKey,
    nowMs: params.nowMs,
  });
  if (shouldWaitForInitialAppInventory(params, policy, inventory)) {
    await refreshAppInventoryNow(params, appCache);
    inventory = await readCodexPluginInventory({
      pluginConfig: params.pluginConfig,
      policy,
      request: params.request,
      appCache,
      appCacheKey: params.appCacheKey,
      nowMs: params.nowMs,
    });
    inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: params.pluginConfig,
      appCacheKey: params.appCacheKey,
    });
  }
  const activationDiagnostics: CodexPluginThreadConfigDiagnostic[] = [];
  const activationResults: CodexPluginActivationResult[] = [];
  for (const record of inventory.records) {
    if (!record.activationRequired) {
      continue;
    }
    const activation = await ensureCodexPluginActivation({
      identity: record.policy,
      request: params.request,
      appCache,
      appCacheKey: params.appCacheKey,
    });
    activationResults.push(activation);
    if (!activation.ok) {
      activationDiagnostics.push({
        code: "plugin_activation_failed",
        plugin: record.policy,
        message: activation.diagnostics.map((item) => item.message).join(" ") || activation.reason,
      });
    }
  }
  if (activationResults.some((activation) => activation.ok && activation.installAttempted)) {
    await refreshAppInventoryNow(params, appCache, { forceRefetch: true });
    inventory = await readCodexPluginInventory({
      pluginConfig: params.pluginConfig,
      policy,
      request: params.request,
      appCache,
      appCacheKey: params.appCacheKey,
      nowMs: params.nowMs,
    });
    inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: params.pluginConfig,
      appCacheKey: params.appCacheKey,
    });
  }

  const diagnostics: CodexPluginThreadConfigDiagnostic[] = [
    ...inventory.diagnostics,
    ...activationDiagnostics,
  ];
  const apps: JsonObject = {
    _default: {
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    },
  };
  const policyApps: Record<string, PluginAppPolicyContextEntry> = {};
  const pluginAppIds: Record<string, string[]> = {};
  for (const record of inventory.records) {
    if (record.activationRequired) {
      const activation = activationResults.find(
        (item) => item.identity.configKey === record.policy.configKey,
      );
      if (!activation?.ok) {
        continue;
      }
    }
    if (record.appOwnership !== "proven") {
      continue;
    }
    pluginAppIds[record.policy.configKey] = [...record.ownedAppIds].toSorted();
    for (const app of record.apps) {
      if (!app.accessible || !app.enabled) {
        diagnostics.push({
          code: "app_not_ready",
          plugin: record.policy,
          message: `${app.id} is not accessible or enabled for ${record.policy.pluginName}.`,
        });
        continue;
      }
      const appConfig: JsonObject = {
        enabled: true,
        destructive_enabled: record.policy.allowDestructiveActions,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      };
      apps[app.id] = appConfig;
      policyApps[app.id] = {
        configKey: record.policy.configKey,
        marketplaceName: record.policy.marketplaceName,
        pluginName: record.policy.pluginName,
        allowDestructiveActions: record.policy.allowDestructiveActions,
        mcpServerNames: [...(record.detail?.mcpServers ?? [])].toSorted(),
      };
    }
  }

  const configPatch = { apps };
  const policyContext = buildPluginAppPolicyContext(policyApps, pluginAppIds);
  return {
    enabled: true,
    configPatch,
    fingerprint: fingerprintJson({
      version: CODEX_PLUGIN_THREAD_CONFIG_FINGERPRINT_VERSION,
      inputFingerprint,
      configPatch,
      policyContext,
    }),
    inputFingerprint,
    policyContext,
    inventory,
    diagnostics,
  };
}

export function mergeCodexThreadConfigs(
  ...configs: Array<JsonObject | undefined>
): JsonObject | undefined {
  let merged: JsonObject | undefined;
  for (const config of configs) {
    if (!config) {
      continue;
    }
    merged = mergeJsonObjects(merged ?? {}, config);
  }
  return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

export function isCodexPluginThreadBindingStale(params: {
  codexPluginsEnabled: boolean;
  bindingFingerprint?: string;
  bindingInputFingerprint?: string;
  currentInputFingerprint?: string;
  hasBindingPolicyContext?: boolean;
}): boolean {
  if (!params.codexPluginsEnabled) {
    return Boolean(
      params.bindingFingerprint || params.bindingInputFingerprint || params.hasBindingPolicyContext,
    );
  }
  if (
    !params.bindingFingerprint ||
    !params.bindingInputFingerprint ||
    !params.hasBindingPolicyContext
  ) {
    return true;
  }
  return params.bindingInputFingerprint !== params.currentInputFingerprint;
}

function emptyPluginThreadConfig(params: {
  enabled: boolean;
  inputFingerprint: string;
  configPatch?: JsonObject;
}): CodexPluginThreadConfig {
  const policyContext = buildPluginAppPolicyContext({}, {});
  return {
    enabled: params.enabled,
    fingerprint: fingerprintJson({
      version: CODEX_PLUGIN_THREAD_CONFIG_FINGERPRINT_VERSION,
      inputFingerprint: params.inputFingerprint,
      configPatch: params.configPatch ?? null,
      policyContext,
    }),
    inputFingerprint: params.inputFingerprint,
    ...(params.configPatch ? { configPatch: params.configPatch } : {}),
    policyContext,
    diagnostics: [],
  };
}

function buildDisabledAppsConfigPatch(): JsonObject {
  return {
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
  };
}

function buildPluginAppPolicyContext(
  apps: Record<string, PluginAppPolicyContextEntry>,
  pluginAppIds: Record<string, string[]>,
): PluginAppPolicyContext {
  return {
    fingerprint: fingerprintJson({ version: 1, apps, pluginAppIds }),
    apps,
    pluginAppIds,
  };
}

function shouldWaitForInitialAppInventory(
  params: BuildCodexPluginThreadConfigParams,
  policy: ResolvedCodexPluginsPolicy,
  inventory: CodexPluginInventory,
): boolean {
  return Boolean(
    params.appCacheKey &&
    policy.pluginPolicies.some((plugin) => plugin.enabled) &&
    inventory.appInventory?.state === "missing",
  );
}

async function refreshAppInventoryNow(
  params: BuildCodexPluginThreadConfigParams,
  appCache: CodexAppInventoryCache,
  options: { forceRefetch?: boolean } = {},
): Promise<void> {
  const appCacheKey = params.appCacheKey;
  if (!appCacheKey) {
    return;
  }
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as Awaited<ReturnType<CodexAppInventoryRequest>>;
  try {
    await appCache.refreshNow({
      key: appCacheKey,
      request,
      nowMs: params.nowMs,
      forceRefetch: options.forceRefetch,
    });
  } catch {
    // Keep the thread fail-closed if app/list refresh is unavailable.
  }
}

function policyFingerprint(policy: ResolvedCodexPluginsPolicy): JsonValue {
  return {
    enabled: policy.enabled,
    allowDestructiveActions: policy.allowDestructiveActions,
    plugins: policy.pluginPolicies.map((plugin) => ({
      configKey: plugin.configKey,
      marketplaceName: plugin.marketplaceName,
      pluginName: plugin.pluginName,
      enabled: plugin.enabled,
      allowDestructiveActions: plugin.allowDestructiveActions,
    })),
  };
}

function mergeJsonObjects(left: JsonObject, right: JsonObject): JsonObject {
  const merged: JsonObject = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    merged[key] =
      isPlainJsonObject(existing) && isPlainJsonObject(value)
        ? mergeJsonObjects(existing, value)
        : value;
  }
  return merged;
}

function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fingerprintJson(value: JsonValue): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: JsonValue | undefined): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
