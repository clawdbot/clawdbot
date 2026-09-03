/**
 * Builds Codex thread config patches that expose only policy-approved apps
 * for native Codex turns.
 */
import crypto from "node:crypto";
import { defaultCodexAppInventoryCache, CodexAppInventoryCache } from "./app-inventory-cache.js";
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
  clearPersistedAppApprovalOverrides,
  type CodexAppApprovalOverrideDiagnostic,
} from "./plugin-app-approval-overrides.js";
import {
  readCodexPluginInventory,
  type CodexPluginInventory,
  type CodexPluginInventoryDiagnostic,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import type { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import {
  collectCodexPluginOwnedAppIds,
  collectCodexReservedPluginAppIds,
  readCodexConfigForAppAdmission,
  readCodexThreadAdmissibleAccountApps,
  refreshCodexPluginAppInventory,
  resolveCodexPluginThreadAppCacheKey,
  resolveCodexExplicitAppEnablement,
  resolveCodexPluginAppThreadAdmission,
  resolveCodexThreadConfigAppsForRecord,
  shouldForceRefreshCodexNotReadyPluginApps,
  toCodexPluginOwnedAccountApp,
  type CodexPluginThreadAppAdmissionConfig,
  type CodexPluginThreadAppAdmissionDiagnostic,
} from "./plugin-thread-app-admission.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

/** Policy context for one app id exposed by a configured Codex plugin. */
export type PluginAppPolicyContextEntry = {
  source?: "plugin";
  configKey: string;
  marketplaceName: ResolvedCodexPluginPolicy["marketplaceName"];
  pluginName: string;
  allowDestructiveActions: boolean;
  allowOpenWorld?: boolean;
  destructiveApprovalMode?: CodexPluginDestructiveApprovalMode;
  mcpServerNames: string[];
};

/** Policy context for one account-connected app admitted without a plugin package. */
type AccountAppPolicyContextEntry = {
  source: "account";
  appName: string;
  allowDestructiveActions: boolean;
  allowOpenWorld?: boolean;
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
  | CodexAppApprovalOverrideDiagnostic
  | {
      code:
        | "account_app_ownership_unavailable"
        | "plugin_activation_failed"
        | "plugin_config_timeout"
        | "app_not_ready";
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
  threadId?: string;
  appCache?: CodexAppInventoryCache;
  appCacheKey: string;
  metadataCache?: CodexPluginMetadataCache;
  nowMs?: number;
};

// Admission changes must rebuild existing bindings too, or older bindings can
// bypass updated app approval checks after the gateway has been upgraded.
const CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION = 5;
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
  const threadAppCacheKey = resolveCodexPluginThreadAppCacheKey(params);
  const threadRequest: CodexPluginRuntimeRequest = (method, requestParams) =>
    params.request(
      method,
      (method === "app/installed" || method === "app/read") &&
        params.threadId &&
        isJsonObject(requestParams)
        ? { ...requestParams, threadId: params.threadId }
        : requestParams,
    );
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
          request: threadRequest,
          appCache,
          appCacheKey: threadAppCacheKey,
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
      request: threadRequest,
      appCache,
      appCacheKey: threadAppCacheKey,
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
      request: threadRequest,
      appCache,
      appCacheKey: threadAppCacheKey,
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
      request: threadRequest,
      appCache,
      appCacheKey: threadAppCacheKey,
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
      request: threadRequest,
      appCache,
      appCacheKey: threadAppCacheKey,
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
  // A deny-all thread needs no native settings; read them only before admitting an app.
  let appAdmissionConfig: Promise<CodexPluginThreadAppAdmissionConfig> | undefined;
  const getAdmissionConfig = () =>
    (appAdmissionConfig ??= requireCodexConfigForAppAdmission(params));

  const diagnostics: CodexPluginThreadConfigDiagnostic[] = [
    ...inventory.diagnostics,
    ...activationDiagnostics,
    ...(accountAppsResult.diagnostic ? [accountAppsResult.diagnostic] : []),
  ];
  const provisionalAppIds = new Set<string>();
  const { apps } = buildDisabledAppsConfigPatch();
  const policyApps: Record<string, CodexAppPolicyContextEntry> = {};
  const pluginAppIds: Record<string, string[]> = {};
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
      const admissionConfig = admission === "blocked" ? undefined : await getAdmissionConfig();
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
        !(await clearPersistedAppApprovalOverrides({
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
        allowOpenWorld: true,
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
    const admissionConfig = await getAdmissionConfig();
    if (resolveCodexExplicitAppEnablement(admissionConfig.layers, app.id) === false) {
      continue;
    }
    const accountApp = toCodexPluginOwnedAccountApp(app);
    if (
      policy.destructiveApprovalMode === "ask" &&
      !(await clearPersistedAppApprovalOverrides({
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
      allowOpenWorld: true,
      destructiveApprovalMode: policy.destructiveApprovalMode,
      mcpServerNames: [],
    };
  }

  const configPatch =
    Object.keys(policyApps).length === 0
      ? buildDisabledAppsConfigPatch()
      : disableUnlistedCodexApps({ apps }, (await getAdmissionConfig()).config);
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

export function buildDisabledAppsConfigPatch(): JsonObject & { apps: JsonObject } {
  return {
    "features.apps": false,
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
  };
}

async function requireCodexConfigForAppAdmission(
  params: Parameters<typeof readCodexConfigForAppAdmission>[0],
): Promise<CodexPluginThreadAppAdmissionConfig> {
  const config = await readCodexConfigForAppAdmission(params);
  if (!config) {
    throw new Error(
      "Could not verify the Codex app allowlist. No native thread was started; retry when native app configuration is available.",
    );
  }
  return config;
}

export function disableUnlistedCodexApps(
  configPatch: { apps: JsonObject },
  nativeConfig: Record<string, unknown>,
): JsonObject & { apps: JsonObject } {
  const apps = { ...configPatch.apps };
  // Native app.enabled wins over _default. Bindings store admitted apps only,
  // so every configured app outside that allowlist needs an explicit denial.
  for (const id of Object.keys(isJsonObject(nativeConfig.apps) ? nativeConfig.apps : {})) {
    if (id !== "_default" && !Object.hasOwn(apps, id)) {
      apps[id] = { enabled: false };
    }
  }
  return { ...configPatch, apps };
}

function buildEnabledAppConfig(policy: {
  allowDestructiveActions: boolean;
  allowOpenWorld?: boolean;
  destructiveApprovalMode?: CodexPluginDestructiveApprovalMode;
}): JsonObject {
  return {
    enabled: true,
    destructive_enabled: policy.allowDestructiveActions,
    open_world_enabled: policy.allowOpenWorld !== false,
    default_tools_approval_mode: "auto",
    ...(policy.destructiveApprovalMode === "ask" ? { approvals_reviewer: "user" } : {}),
  };
}

/** Rebuilds the safe per-thread apps patch persisted with a Codex thread binding. */
export function buildCodexPluginAppsConfigPatchFromPolicyContext(
  policyContext: PluginAppPolicyContext,
): JsonObject & { apps: JsonObject } {
  const disabledConfigPatch = buildDisabledAppsConfigPatch();
  const { apps } = disabledConfigPatch;
  for (const [appId, policy] of Object.entries(policyContext.apps).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    apps[appId] = buildEnabledAppConfig(policy);
  }
  return Object.keys(policyContext.apps).length > 0 ? { apps } : disabledConfigPatch;
}

/** Rechecks durable ask overrides before a side thread replays its bound app policy. */
export async function refreshCodexPluginAppApprovalPolicy(params: {
  policyContext: PluginAppPolicyContext;
  request: CodexPluginRuntimeRequest;
  configCwd?: string;
}): Promise<
  Pick<CodexPluginThreadConfig, "policyContext" | "diagnostics"> & { configPatch: JsonObject }
> {
  if (Object.keys(params.policyContext.apps).length === 0) {
    return {
      policyContext: params.policyContext,
      configPatch: buildDisabledAppsConfigPatch(),
      diagnostics: [],
    };
  }
  const targetAppIds = Object.entries(params.policyContext.apps)
    .filter(([, app]) => app.destructiveApprovalMode === "ask")
    .map(([id]) => id)
    .toSorted();
  const diagnostics: CodexPluginThreadConfigDiagnostic[] = [];
  // A persisted binding can be replayed before any normal turn after restart.
  // Fresh targeted inventory retains the current non-read-only tool scope.
  const readParams = { ...params, appCacheKey: "approval-policy-replay" };
  const [inventory, admissionConfig] = await Promise.all([
    targetAppIds.length > 0
      ? refreshCodexPluginAppInventory(readParams, new CodexAppInventoryCache(), { targetAppIds })
      : undefined,
    requireCodexConfigForAppAdmission(readParams),
  ]);
  const configPatch = disableUnlistedCodexApps(
    buildCodexPluginAppsConfigPatchFromPolicyContext(params.policyContext),
    admissionConfig.config,
  );
  const currentApps = new Map(
    inventory?.apps.map((app) => [app.id, toCodexPluginOwnedAccountApp(app)]),
  );
  const apps = { ...params.policyContext.apps };
  for (const id of targetAppIds) {
    const app = currentApps.get(id);
    if (!app) {
      diagnostics.push({
        code: "approval_overrides_clear_failed",
        message: `Could not verify current Codex app approval policy for ${id}; the app was not exposed.`,
      });
    } else if (
      await clearPersistedAppApprovalOverrides({
        ...params,
        config: admissionConfig.config,
        app,
        diagnostics,
      })
    ) {
      continue;
    }
    delete apps[id];
    // Native app.enabled wins over apps._default.enabled; omission cannot revoke it.
    configPatch.apps[id] = { enabled: false };
  }
  return {
    policyContext: buildPluginAppPolicyContext(
      apps,
      Object.fromEntries(
        Object.entries(params.policyContext.pluginAppIds).map(([key, ids]) => [
          key,
          ids.filter((id) => Object.hasOwn(apps, id)),
        ]),
      ),
    ),
    configPatch,
    diagnostics,
  };
}

export function buildPluginAppPolicyContext(
  apps: Record<string, CodexAppPolicyContextEntry>,
  pluginAppIds: Record<string, string[]>,
): PluginAppPolicyContext {
  return {
    fingerprint: fingerprintJson({ version: 2, apps, pluginAppIds }),
    apps,
    pluginAppIds,
  };
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
      isJsonObject(existing) && isJsonObject(value) ? mergeJsonObjects(existing, value) : value;
  }
  return merged;
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
