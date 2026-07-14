/**
 * Builds Codex thread config patches that expose only policy-approved apps
 * for native Codex turns.
 */
import crypto from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  defaultCodexAppInventoryCache,
  serializeCodexAppInventoryError,
  type CodexAppInventorySnapshot,
  type CodexAppInventoryCache,
  type CodexAppInventoryRequest,
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
  type CodexPluginInventoryRecord,
  type CodexPluginOwnedApp,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import { isJsonObject, type JsonObject, type JsonValue, type v2 } from "./protocol.js";

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
  | {
      code:
        | "plugin_activation_failed"
        | "app_not_ready"
        | "account_app_inventory_unavailable"
        | "approval_overrides_clear_failed";
      plugin?: ResolvedCodexPluginPolicy;
      message: string;
    };

/** Complete Codex thread config patch plus inventory and policy fingerprints. */
export type CodexPluginThreadConfig = {
  enabled: boolean;
  configPatch?: JsonObject;
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
          nowMs: params.nowMs,
          suppressAppInventoryRefresh: true,
        })
      : emptyCodexPluginInventory(policy);
  const appInventoryRefreshDeferredForActivation =
    inventory.records.some((record) => record.activationRequired) &&
    shouldRefreshMissingAppInventory(params, policy, inventory);
  if (shouldWaitForInitialAppInventory(params, policy, inventory)) {
    await refreshAppInventoryNow(params, appCache, {
      // OpenClaw is missing its process-local snapshot, but Codex may already
      // have a current inventory. Avoid rebuilding the entire remote catalog
      // during thread startup; post-install and readiness repair still force.
      forceRefetch: false,
      reason: "initial_missing",
      targetAppIds: collectInventoryOwnedAppIds(inventory),
    });
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
    await refreshAppInventoryNow(params, appCache, {
      forceRefetch: true,
      reason: postInstallRefreshRequired ? "post_install" : "deferred_missing",
      targetAppIds: collectInventoryOwnedAppIds(inventory),
    });
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
  if (shouldForceRefreshForNotReadyPluginApps(params, policy, inventory)) {
    await refreshAppInventoryNow(params, appCache, {
      forceRefetch: true,
      reason: "not_ready_plugin_apps",
      targetAppIds: collectInventoryOwnedAppIds(inventory),
    });
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

  const accountAppsResult: Awaited<ReturnType<typeof readAccessibleAccountApps>> =
    policy.allowAllPlugins ? await readAccessibleAccountApps(params, appCache) : { apps: [] };

  const diagnostics: CodexPluginThreadConfigDiagnostic[] = [
    ...inventory.diagnostics,
    ...activationDiagnostics,
    ...(accountAppsResult.diagnostic ? [accountAppsResult.diagnostic] : []),
  ];
  const apps: JsonObject = {
    _default: {
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    },
  };
  const policyApps: Record<string, CodexAppPolicyContextEntry> = {};
  const pluginAppIds: Record<string, string[]> = {};
  const pluginOwnedAppIds = new Set(
    inventory.records.flatMap((record) =>
      record.appOwnership === "proven" ? record.ownedAppIds : [],
    ),
  );
  for (const record of inventory.records) {
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
    for (const app of resolveThreadConfigAppsForRecord({ record, inventory })) {
      if (!isPluginAppReadyForThreadStart(app)) {
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
          plugin: record.policy,
          app,
          diagnostics,
        }))
      ) {
        continue;
      }
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

  for (const app of accountAppsResult.apps) {
    // An explicit plugin policy is more specific than the account-wide policy.
    // Reserve proven ownership even when activation/readiness fails so a broad
    // account policy cannot re-admit an app that the explicit path excluded.
    if (pluginOwnedAppIds.has(app.id)) {
      continue;
    }
    const accountApp = toOwnedAccountApp(app);
    if (
      policy.destructiveApprovalMode === "ask" &&
      !(await clearPersistedAppToolApprovalOverrides({
        request: params.request,
        configCwd: params.configCwd,
        app: accountApp,
        diagnostics,
      }))
    ) {
      continue;
    }
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
  plugin?: ResolvedCodexPluginPolicy;
  app: CodexPluginOwnedApp;
  diagnostics: CodexPluginThreadConfigDiagnostic[];
}): Promise<boolean> {
  try {
    const overrideNames = await readPersistedAppToolApprovalOverrideNames(params);
    for (const toolName of overrideNames) {
      const response = await params.request("config/value/write", {
        keyPath: `apps.${quoteConfigKeyPathSegment(params.app.id)}.tools.${quoteConfigKeyPathSegment(
          toolName,
        )}.approval_mode`,
        value: null,
        mergeStrategy: "replace",
      });
      if (isOverriddenConfigWriteResponse(response)) {
        throw new Error(`approval override for ${toolName} is controlled by another config layer`);
      }
    }
    const remainingOverrideNames = await readPersistedAppToolApprovalOverrideNames(params);
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

async function readPersistedAppToolApprovalOverrideNames(params: {
  request: CodexPluginRuntimeRequest;
  configCwd?: string;
  app: CodexPluginOwnedApp;
}): Promise<string[]> {
  const response = await params.request("config/read", {
    includeLayers: false,
    ...(params.configCwd ? { cwd: params.configCwd } : {}),
  });
  const config = isJsonObject(response) ? response.config : undefined;
  const appsRoot = isJsonObject(config) ? config.apps : undefined;
  const nestedApps = isJsonObject(appsRoot) ? appsRoot.apps : undefined;
  const appConfig = isJsonObject(appsRoot)
    ? (appsRoot[params.app.id] ??
      (isJsonObject(nestedApps) ? nestedApps[params.app.id] : undefined))
    : undefined;
  const tools = isJsonObject(appConfig) ? appConfig.tools : undefined;
  if (!isJsonObject(tools)) {
    return [];
  }
  return Object.entries(tools)
    .filter(([, value]) => hasPersistedToolApprovalOverride(value))
    .map(([toolName]) => toolName)
    .toSorted();
}

function hasPersistedToolApprovalOverride(value: JsonValue): boolean {
  return (
    isJsonObject(value) && (value.approval_mode !== undefined || value.approvalMode !== undefined)
  );
}

function isOverriddenConfigWriteResponse(response: unknown): boolean {
  return isJsonObject(response) && response.status === "okOverridden";
}

function quoteConfigKeyPathSegment(segment: string): string {
  return `"${segment.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

function shouldWaitForInitialAppInventory(
  params: BuildCodexPluginThreadConfigParams,
  policy: ResolvedCodexPluginsPolicy,
  inventory: CodexPluginInventory,
): boolean {
  // Install/enable first so the initial app/list can observe newly activated plugin apps.
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

async function refreshAppInventoryNow(
  params: BuildCodexPluginThreadConfigParams,
  appCache: CodexAppInventoryCache,
  options: { forceRefetch?: boolean; reason?: string; targetAppIds?: readonly string[] } = {},
): Promise<CodexAppInventorySnapshot | undefined> {
  const appCacheKey = params.appCacheKey;
  if (!appCacheKey) {
    return undefined;
  }
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as Awaited<ReturnType<CodexAppInventoryRequest>>;
  try {
    const snapshot = await appCache.refreshNow({
      key: appCacheKey,
      request,
      nowMs: params.nowMs,
      forceRefetch: options.forceRefetch,
      targetAppIds: options.targetAppIds,
    });
    return snapshot;
  } catch (error) {
    embeddedAgentLog.warn("codex plugin thread config app inventory refresh failed", {
      reason: options.reason,
      forceRefetch: options.forceRefetch === true,
      error: serializeCodexAppInventoryError(error),
    });
    // Keep building from the diagnostic inventory state; app exposure remains scoped below.
    return undefined;
  }
}

function collectInventoryOwnedAppIds(inventory: CodexPluginInventory): string[] {
  return Array.from(
    new Set(inventory.records.flatMap((record) => record.ownedAppIds).filter(Boolean)),
  ).toSorted();
}

function emptyCodexPluginInventory(policy: ResolvedCodexPluginsPolicy): CodexPluginInventory {
  return {
    policy,
    records: [],
    diagnostics: [],
  };
}

async function readAccessibleAccountApps(
  params: BuildCodexPluginThreadConfigParams,
  appCache: CodexAppInventoryCache,
): Promise<{
  apps: v2.AppInfo[];
  diagnostic?: CodexPluginThreadConfigDiagnostic;
}> {
  // Account-wide mode needs a complete inventory. A plugin-targeted cache fill can
  // stop once its known app ids are found, so always traverse all app/list pages here.
  const snapshot = await refreshAppInventoryNow(params, appCache, {
    forceRefetch: false,
    reason: "account_apps_all",
    targetAppIds: [],
  });
  if (!snapshot) {
    return {
      apps: [],
      diagnostic: {
        code: "account_app_inventory_unavailable",
        message: "Codex account app inventory was unavailable; account apps were not exposed.",
      },
    };
  }
  return {
    apps: snapshot.apps
      .filter((app) => app.isAccessible)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

function toOwnedAccountApp(app: v2.AppInfo): CodexPluginOwnedApp {
  return {
    id: app.id,
    name: app.name,
    accessible: app.isAccessible,
    enabled: app.isEnabled,
    needsAuth: !app.isAccessible,
  };
}

function resolveThreadConfigAppsForRecord(params: {
  record: CodexPluginInventoryRecord;
  inventory: CodexPluginInventory;
}): CodexPluginOwnedApp[] {
  if (params.inventory.appInventory?.state === "missing") {
    return [];
  }
  return params.record.apps;
}

function isPluginAppReadyForThreadStart(app: CodexPluginOwnedApp): boolean {
  // `app/list` is the source of truth for inventory and access posture, but
  // OpenClaw owns the per-thread enablement decision. A listed app that is
  // accessible can be re-enabled for this thread via `config.apps[app.id]`.
  return app.accessible;
}

function shouldForceRefreshForNotReadyPluginApps(
  params: BuildCodexPluginThreadConfigParams,
  policy: ResolvedCodexPluginsPolicy,
  inventory: CodexPluginInventory,
): boolean {
  if (!params.appCacheKey || !policy.pluginPolicies.some((plugin) => plugin.enabled)) {
    return false;
  }
  if (inventory.appInventory?.state === "missing") {
    return false;
  }
  return inventory.records.some(
    (record) =>
      record.appOwnership === "proven" &&
      record.ownedAppIds.length > 0 &&
      (record.apps.length === 0 || record.apps.some((app) => !app.accessible)),
  );
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
