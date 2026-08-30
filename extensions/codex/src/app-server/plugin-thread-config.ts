/**
 * Builds Codex thread config patches that expose only policy-approved apps
 * for native Codex turns.
 */
import crypto from "node:crypto";
import {
  defaultCodexAppInventoryCache,
  type CodexAppInventoryCache,
} from "./app-inventory-cache.js";
import {
  resolveCodexPluginsPolicy,
  type CodexPluginDestructiveApprovalMode,
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
  type CodexPluginOwnedApp,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import type { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import {
  collectCodexPluginOwnedAppIds,
  collectCodexReservedPluginAppIds,
  readCodexConfigForAppAdmission,
  readCodexThreadAdmissibleAccountApps,
  refreshCodexPluginAppInventory,
  resolveCodexExplicitAppEnablement,
  resolveCodexPluginAppThreadAdmission,
  resolveCodexThreadConfigAppsForRecord,
  shouldForceRefreshCodexNotReadyPluginApps,
  toCodexPluginOwnedAccountApp,
  type CodexPluginThreadAppAdmissionConfig,
  type CodexPluginThreadAppAdmissionDiagnostic,
} from "./plugin-thread-app-admission.js";
import { isJsonObject, type CodexConfigEdit, type JsonObject, type JsonValue } from "./protocol.js";

/** Policy context for one app id exposed by a configured Codex plugin. */
export type PluginAppPolicyContextEntry = {
  source?: "plugin";
  configKey: string;
  marketplaceName: ResolvedCodexPluginPolicy["marketplaceName"];
  pluginName: string;
  allowDestructiveActions: boolean;
  destructiveApprovalMode?: CodexPluginDestructiveApprovalMode;
  mcpServerNames: string[];
};

/** Policy context for one account-connected app admitted without a plugin package. */
type AccountAppPolicyContextEntry = {
  source: "account";
  appName: string;
  allowDestructiveActions: boolean;
  destructiveApprovalMode?: CodexPluginDestructiveApprovalMode;
  mcpServerNames: string[];
};

/** Policy context for any app exposed to a native Codex thread. */
export type CodexAppPolicyContextEntry = PluginAppPolicyContextEntry | AccountAppPolicyContextEntry;

/** Stable app-to-plugin ownership context persisted with Codex thread bindings. */
export type PluginAppPolicyContext = {
  fingerprint: string;
  apps: Record<string, CodexAppPolicyContextEntry>;
  pluginAppIds: Record<string, string[]>;
};

/** Diagnostic emitted while building app config for a native Codex thread. */
type CodexPluginThreadConfigDiagnostic =
  | CodexPluginInventoryDiagnostic
  | CodexPluginThreadAppAdmissionDiagnostic
  | {
      code:
        | "account_app_ownership_unavailable"
        | "plugin_activation_failed"
        | "plugin_config_timeout"
        | "app_not_ready"
        | "approval_overrides_clear_failed";
      plugin?: ResolvedCodexPluginPolicy;
      message: string;
    };

/** Complete Codex thread config patch plus inventory and policy fingerprints. */
export type CodexPluginThreadConfig = {
  enabled: boolean;
  configPatch?: JsonObject;
  /** Modern app IDs that must be attested against the effective Codex thread. */
  provisionalAppIds?: readonly string[];
  fingerprint: string;
  inputFingerprint: string;
  policyContext: PluginAppPolicyContext;
  inventory?: CodexPluginInventory;
  diagnostics: CodexPluginThreadConfigDiagnostic[];
};

/** Inputs for building a Codex thread app/plugin config patch. */
type BuildCodexPluginThreadConfigParams = {
  pluginConfig?: unknown;
  request: CodexPluginRuntimeRequest;
  configCwd?: string;
  appCache?: CodexAppInventoryCache;
  appCacheKey: string;
  metadataCache?: CodexPluginMetadataCache;
  nowMs?: number;
};

const CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION = 3;
const CODEX_PLUGIN_THREAD_CONFIG_FINGERPRINT_VERSION = 2;

/** Returns true when plugin config exists and thread config may need app patches. */
export function shouldBuildCodexPluginThreadConfig(pluginConfig?: unknown): boolean {
  return resolveCodexPluginsPolicy(pluginConfig).configured;
}

/** Fingerprints policy and app-cache identity before runtime inventory is read. */
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

/** Builds the deny-all app patch used when plugin discovery exceeds its turn budget. */
export function buildCodexPluginThreadConfigTimeoutFallback(params: {
  pluginConfig?: unknown;
  appCacheKey: string;
  message: string;
}): CodexPluginThreadConfig {
  const inputFingerprint = buildCodexPluginThreadConfigInputFingerprint(params);
  const fallback = emptyPluginThreadConfig({
    enabled: true,
    inputFingerprint,
    configPatch: buildDisabledAppsConfigPatch(),
  });
  return {
    ...fallback,
    diagnostics: [{ code: "plugin_config_timeout", message: params.message }],
  };
}

/** Builds the Codex apps config patch and policy context for a native thread. */
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

  let inventory =
    policy.pluginPolicies.length > 0
      ? await readCodexPluginInventory({
          pluginConfig: params.pluginConfig,
          policy,
          request: params.request,
          appCache,
          appCacheKey: params.appCacheKey,
          configCwd: params.configCwd,
          metadataCache: params.metadataCache,
          nowMs: params.nowMs,
          suppressAppInventoryRefresh: true,
        })
      : emptyCodexPluginInventory(policy);
  const appInventoryRefreshDeferredForActivation =
    inventory.records.some((record) => record.activationRequired) &&
    shouldRefreshMissingAppInventory(params, policy, inventory);
  if (shouldWaitForInitialAppInventory(params, policy, inventory)) {
    await refreshCodexPluginAppInventory(params, appCache, {
      // OpenClaw is missing its process-local snapshot, but Codex may already
      // have a current inventory. Avoid rebuilding the entire remote catalog
      // during thread startup; post-install and readiness repair still force.
      forceRefetch: false,
      reason: "initial_missing",
      targetAppIds: collectCodexPluginOwnedAppIds(inventory),
    });
    inventory = await readCodexPluginInventory({
      pluginConfig: params.pluginConfig,
      policy,
      request: params.request,
      appCache,
      appCacheKey: params.appCacheKey,
      configCwd: params.configCwd,
      metadataCache: params.metadataCache,
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
      configCwd: params.configCwd,
      metadataCache: params.metadataCache,
      deferAppInventoryRefresh: true,
      targetAppIds: record.ownedAppIds,
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
  const postInstallRefreshRequired = activationResults.some(
    (activation) => activation.ok && activation.installAttempted,
  );
  // Activation can become unnecessary or fail before it refreshes apps. Rebuild the
  // deferred missing snapshot so unrelated active plugin apps are not silently erased.
  const deferredMissingRefreshRequired =
    appInventoryRefreshDeferredForActivation &&
    !postInstallRefreshRequired &&
    shouldRefreshMissingAppInventory(params, policy, inventory);
  if (postInstallRefreshRequired || deferredMissingRefreshRequired) {
    await refreshCodexPluginAppInventory(params, appCache, {
      forceRefetch: true,
      reason: postInstallRefreshRequired ? "post_install" : "deferred_missing",
      targetAppIds: collectCodexPluginOwnedAppIds(inventory),
    });
    inventory = await readCodexPluginInventory({
      pluginConfig: params.pluginConfig,
      policy,
      request: params.request,
      appCache,
      appCacheKey: params.appCacheKey,
      configCwd: params.configCwd,
      metadataCache: params.metadataCache,
      nowMs: params.nowMs,
    });
    inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: params.pluginConfig,
      appCacheKey: params.appCacheKey,
    });
  }
  if (shouldForceRefreshCodexNotReadyPluginApps(params, policy, inventory)) {
    await refreshCodexPluginAppInventory(params, appCache, {
      forceRefetch: true,
      reason: "not_ready_plugin_apps",
      targetAppIds: collectCodexPluginOwnedAppIds(inventory),
    });
    inventory = await readCodexPluginInventory({
      pluginConfig: params.pluginConfig,
      policy,
      request: params.request,
      appCache,
      appCacheKey: params.appCacheKey,
      configCwd: params.configCwd,
      metadataCache: params.metadataCache,
      nowMs: params.nowMs,
    });
    inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: params.pluginConfig,
      appCacheKey: params.appCacheKey,
    });
  }

  const accountAppsResult: Awaited<ReturnType<typeof readCodexThreadAdmissibleAccountApps>> =
    policy.allowAllPlugins
      ? await readCodexThreadAdmissibleAccountApps(params, appCache)
      : { apps: [] };

  const diagnostics: CodexPluginThreadConfigDiagnostic[] = [
    ...inventory.diagnostics,
    ...activationDiagnostics,
    ...(accountAppsResult.diagnostic ? [accountAppsResult.diagnostic] : []),
  ];
  const provisionalAppIds = new Set<string>();
  const apps: JsonObject = {
    _default: {
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    },
  };
  const policyApps: Record<string, CodexAppPolicyContextEntry> = {};
  const pluginAppIds: Record<string, string[]> = {};
  let configForAppAdmission: Promise<CodexPluginThreadAppAdmissionConfig | undefined> | undefined;
  const pluginOwnedAppIds = collectCodexReservedPluginAppIds({
    policy,
    inventory,
    accountApps: accountAppsResult.apps,
  });
  const unresolvedDisabledPluginOwnership = policy.allowAllPlugins
    ? policy.pluginPolicies.find((pluginPolicy) => {
        const record = inventory.records.find(
          (candidate) => candidate.policy.configKey === pluginPolicy.configKey,
        );
        const disabledByMarketplacePolicy =
          record?.summary.availability === "DISABLED_BY_ADMIN" ||
          record?.summary.installPolicy === "NOT_AVAILABLE";
        const unresolvedPluginIdentity =
          !record &&
          inventory.diagnostics.some(
            (diagnostic) =>
              diagnostic.plugin?.configKey === pluginPolicy.configKey &&
              (diagnostic.code === "plugin_disabled" ||
                diagnostic.code === "plugin_missing" ||
                diagnostic.code === "marketplace_missing"),
          );
        return (
          (!pluginPolicy.enabled || disabledByMarketplacePolicy || unresolvedPluginIdentity) &&
          !record?.detail
        );
      })
    : undefined;
  if (unresolvedDisabledPluginOwnership) {
    // Codex omits disabled plugin ownership from app/read display names. A
    // broad account policy cannot safely proceed without authoritative detail.
    diagnostics.push({
      code: "account_app_ownership_unavailable",
      plugin: unresolvedDisabledPluginOwnership,
      message: `Could not verify disabled Codex plugin app ownership for ${unresolvedDisabledPluginOwnership.pluginName}; account apps were not exposed.`,
    });
  }
  for (const record of inventory.records) {
    if (!record.policy.enabled) {
      continue;
    }
    const activation = activationResults.find(
      (item) => item.identity.configKey === record.policy.configKey,
    );
    if (activation?.ok === false || (record.activationRequired && !activation?.ok)) {
      continue;
    }
    if (record.appOwnership !== "proven") {
      continue;
    }
    pluginAppIds[record.policy.configKey] = [...record.ownedAppIds].toSorted();
    for (const app of resolveCodexThreadConfigAppsForRecord({ record, inventory })) {
      const admission = resolveCodexPluginAppThreadAdmission(app, inventory);
      const admissionConfig =
        admission === "blocked"
          ? undefined
          : await (configForAppAdmission ??= readCodexConfigForAppAdmission(params));
      if (
        !admissionConfig ||
        resolveCodexExplicitAppEnablement(admissionConfig.layers, app.id) === false
      ) {
        diagnostics.push({
          code: "app_not_ready",
          plugin: record.policy,
          message: `${app.id} is not accessible for ${record.policy.pluginName}.`,
        });
        continue;
      }
      if (
        record.policy.destructiveApprovalMode === "ask" &&
        !(await clearPersistedAppToolApprovalOverrides({
          request: params.request,
          configCwd: params.configCwd,
          config: admissionConfig.config,
          plugin: record.policy,
          app,
          diagnostics,
        }))
      ) {
        continue;
      }
      provisionalAppIds.add(app.id);
      apps[app.id] = buildEnabledAppConfig(record.policy);
      policyApps[app.id] = {
        configKey: record.policy.configKey,
        marketplaceName: record.policy.marketplaceName,
        pluginName: record.policy.pluginName,
        allowDestructiveActions: record.policy.allowDestructiveActions,
        destructiveApprovalMode: record.policy.destructiveApprovalMode,
        mcpServerNames: [...(record.detail?.mcpServers ?? [])].toSorted(),
      };
    }
  }

  for (const app of unresolvedDisabledPluginOwnership ? [] : accountAppsResult.apps) {
    // An explicit plugin policy is more specific than the account-wide policy.
    // Reserve proven ownership even when activation/readiness fails so a broad
    // account policy cannot re-admit an app that the explicit path excluded.
    if (pluginOwnedAppIds.has(app.id)) {
      continue;
    }
    configForAppAdmission ??= readCodexConfigForAppAdmission(params);
    const admissionConfig = await configForAppAdmission;
    if (!admissionConfig) {
      diagnostics.push({
        code: "account_app_config_unavailable",
        message: "Codex account app configuration was unavailable; account apps were not exposed.",
      });
      break;
    }
    if (resolveCodexExplicitAppEnablement(admissionConfig.layers, app.id) === false) {
      continue;
    }
    const accountApp = toCodexPluginOwnedAccountApp(app);
    if (
      policy.destructiveApprovalMode === "ask" &&
      !(await clearPersistedAppToolApprovalOverrides({
        request: params.request,
        configCwd: params.configCwd,
        config: admissionConfig.config,
        app: accountApp,
        diagnostics,
      }))
    ) {
      continue;
    }
    // Global callability does not prove this thread's workspace/managed
    // policy. Attest only apps that also passed destructive-approval checks.
    provisionalAppIds.add(app.id);
    apps[app.id] = buildEnabledAppConfig(policy);
    policyApps[app.id] = {
      source: "account",
      appName: app.name,
      allowDestructiveActions: policy.allowDestructiveActions,
      destructiveApprovalMode: policy.destructiveApprovalMode,
      mcpServerNames: [],
    };
  }

  const configPatch = { apps };
  const policyContext = buildPluginAppPolicyContext(policyApps, pluginAppIds);
  return {
    enabled: true,
    configPatch,
    ...(provisionalAppIds.size > 0
      ? { provisionalAppIds: Array.from(provisionalAppIds).toSorted() }
      : {}),
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

/** Deep-merges optional Codex thread config patches, returning undefined when empty. */
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

/** Detects when a stored thread binding no longer matches current plugin policy inputs. */
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

function buildEnabledAppConfig(policy: {
  allowDestructiveActions: boolean;
  destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
}): JsonObject {
  return {
    enabled: true,
    destructive_enabled: policy.allowDestructiveActions,
    open_world_enabled: true,
    default_tools_approval_mode: "auto",
    ...(policy.destructiveApprovalMode === "ask" ? { approvals_reviewer: "user" } : {}),
  };
}

/** Rebuilds the safe per-thread apps patch persisted with a Codex thread binding. */
export function buildCodexPluginAppsConfigPatchFromPolicyContext(
  policyContext: PluginAppPolicyContext,
): JsonObject {
  const apps: JsonObject = {
    _default: {
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    },
  };
  for (const [appId, policy] of Object.entries(policyContext.apps).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    apps[appId] = {
      enabled: true,
      destructive_enabled: policy.allowDestructiveActions,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
      ...(policy.destructiveApprovalMode === "ask" ? { approvals_reviewer: "user" } : {}),
    };
  }
  return { apps };
}

function buildPluginAppPolicyContext(
  apps: Record<string, CodexAppPolicyContextEntry>,
  pluginAppIds: Record<string, string[]>,
): PluginAppPolicyContext {
  return {
    fingerprint: fingerprintJson({ version: 2, apps, pluginAppIds }),
    apps,
    pluginAppIds,
  };
}

async function clearPersistedAppToolApprovalOverrides(params: {
  request: CodexPluginRuntimeRequest;
  configCwd?: string;
  config: JsonObject;
  plugin?: ResolvedCodexPluginPolicy;
  app: CodexPluginOwnedApp;
  diagnostics: CodexPluginThreadConfigDiagnostic[];
}): Promise<boolean> {
  try {
    const overrideNames = readPersistedAppToolApprovalOverrideNames(params.config, params.app);
    if (overrideNames.length === 0) {
      return true;
    }
    const edits = overrideNames.map(
      (toolName): CodexConfigEdit => ({
        keyPath: `apps.${quoteConfigKeyPathSegment(params.app.id)}.tools.${quoteConfigKeyPathSegment(
          toolName,
        )}.approval_mode`,
        value: null,
        mergeStrategy: "replace",
      }),
    );
    const response = await params.request("config/batchWrite", { edits });
    if (
      !isJsonObject(response) ||
      (response.status !== "ok" && response.status !== "okOverridden")
    ) {
      throw new Error("Codex did not confirm the approval override batch");
    }
    if (response.status === "okOverridden") {
      throw new Error(
        `approval override for ${overrideNames.join(", ")} is controlled by another config layer`,
      );
    }
    const confirmed = await params.request("config/read", {
      includeLayers: false,
      ...(params.configCwd ? { cwd: params.configCwd } : {}),
    });
    if (!isJsonObject(confirmed) || !isJsonObject(confirmed.config)) {
      throw new Error("Codex did not confirm effective app approval configuration");
    }
    const remainingOverrideNames = readPersistedAppToolApprovalOverrideNames(
      confirmed.config,
      params.app,
    );
    if (remainingOverrideNames.length > 0) {
      throw new Error(
        `effective approval overrides remain for ${remainingOverrideNames.join(", ")}`,
      );
    }
    return true;
  } catch (error) {
    params.diagnostics.push({
      code: "approval_overrides_clear_failed",
      ...(params.plugin ? { plugin: params.plugin } : {}),
      message: `Could not clear durable Codex app approval overrides for ${params.app.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return false;
  }
}

function readPersistedAppToolApprovalOverrideNames(
  config: JsonObject,
  app: CodexPluginOwnedApp,
): string[] {
  const appsRoot = config.apps;
  const appConfig = isJsonObject(appsRoot) ? appsRoot[app.id] : undefined;
  const tools = isJsonObject(appConfig) ? appConfig.tools : undefined;
  if (!isJsonObject(tools)) {
    return [];
  }
  return Object.entries(tools)
    .filter(([toolName]) => !app.readOnlyToolConfigKeys?.includes(toolName))
    .filter(([, value]) => hasPersistedToolApprovalOverride(value))
    .map(([toolName]) => toolName)
    .toSorted();
}

function hasPersistedToolApprovalOverride(value: JsonValue): boolean {
  return isJsonObject(value) && value.approval_mode !== undefined;
}

function quoteConfigKeyPathSegment(segment: string): string {
  return `"${segment.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

function shouldWaitForInitialAppInventory(
  params: BuildCodexPluginThreadConfigParams,
  policy: ResolvedCodexPluginsPolicy,
  inventory: CodexPluginInventory,
): boolean {
  // Install/enable first so the initial app snapshot observes newly activated plugin apps.
  if (inventory.records.some((record) => record.activationRequired)) {
    return false;
  }
  return shouldRefreshMissingAppInventory(params, policy, inventory);
}

function shouldRefreshMissingAppInventory(
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

function emptyCodexPluginInventory(policy: ResolvedCodexPluginsPolicy): CodexPluginInventory {
  return {
    policy,
    records: [],
    diagnostics: [],
  };
}

function policyFingerprint(policy: ResolvedCodexPluginsPolicy): JsonValue {
  return {
    enabled: policy.enabled,
    allowAllPlugins: policy.allowAllPlugins,
    allowDestructiveActions: policy.allowDestructiveActions,
    destructiveApprovalMode: policy.destructiveApprovalMode,
    plugins: policy.pluginPolicies.map((plugin) => ({
      configKey: plugin.configKey,
      marketplaceName: plugin.marketplaceName,
      pluginName: plugin.pluginName,
      enabled: plugin.enabled,
      allowDestructiveActions: plugin.allowDestructiveActions,
      destructiveApprovalMode: plugin.destructiveApprovalMode,
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
  // Fingerprints must be process-stable across object insertion order so prompt
  // cache and thread-binding comparisons do not churn between runs.
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
