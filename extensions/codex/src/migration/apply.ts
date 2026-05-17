import path from "node:path";
import {
  applyMigrationManualItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
  writeMigrationConfigPath,
} from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMigrationFileItem,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { defaultCodexAppInventoryCache } from "../app-server/app-inventory-cache.js";
import {
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerEnvApiKeyCacheKey,
} from "../app-server/auth-bridge.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  type ResolvedCodexPluginPolicy,
} from "../app-server/config.js";
import {
  ensureCodexPluginActivation,
  type CodexPluginActivationResult,
} from "../app-server/plugin-activation.js";
import { buildCodexPluginAppCacheKey } from "../app-server/plugin-app-cache-key.js";
import type { v2 } from "../app-server/protocol.js";
import { requestCodexAppServerJson } from "../app-server/request.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndWait,
  getSharedCodexAppServerClient,
} from "../app-server/shared-client.js";
import { buildCodexMigrationPlan } from "./plan.js";
import {
  buildCodexPluginsConfigValue,
  CODEX_PLUGIN_CONFIG_ITEM_ID,
  CODEX_PLUGIN_CONFIG_PATH,
  hasCodexPluginConfigConflict,
  readCodexPluginMigrationConfigEntry,
  type CodexPluginMigrationConfigEntry,
} from "./plan.js";
import { resolveCodexMigrationTargets } from "./targets.js";

const CODEX_PLUGIN_AUTH_REQUIRED_REASON = "auth_required";
const CODEX_PLUGIN_NOT_SELECTED_REASON = "not selected for migration";
const CODEX_CONFIG_PATCH_MODE_RETURN = "return";
const CODEX_PLUGIN_LOAD_WARNING =
  "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.";
const TARGET_CODEX_MARKETPLACE_DISCOVERY_POLL_MS = 250;
const TARGET_CODEX_MARKETPLACE_DISCOVERY_TIMEOUT_MS = 30_000;
const TARGET_CODEX_MARKETPLACE_DISCOVERY_TIMEOUT_ENV =
  "OPENCLAW_CODEX_MIGRATION_PLUGIN_LIST_TIMEOUT_MS";

export type CodexMigrationTargetAppServerPreparation = {
  dispose: () => Promise<void>;
};

class CodexPluginConfigConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CodexPluginConfigConflictError";
  }
}

function shouldReturnCodexPluginConfigPatch(ctx: MigrationProviderContext): boolean {
  return ctx.providerOptions?.configPatchMode === CODEX_CONFIG_PATCH_MODE_RETURN;
}

export function prepareTargetCodexAppServer(
  ctx: MigrationProviderContext,
): CodexMigrationTargetAppServerPreparation {
  const appServer = resolveTargetCodexAppServer(ctx);
  const targets = resolveCodexMigrationTargets(ctx);
  let warmedClient: Awaited<ReturnType<typeof getSharedCodexAppServerClient>> | undefined;
  const ready = getSharedCodexAppServerClient({
    startOptions: appServer.start,
    timeoutMs: 60_000,
    agentDir: targets.agentDir,
    config: ctx.config,
  }).then(
    (client) => {
      warmedClient = client;
    },
    () => undefined,
  );
  return {
    async dispose() {
      await ready;
      await clearSharedCodexAppServerClientIfCurrentAndWait(warmedClient, {
        exitTimeoutMs: 2_000,
        forceKillDelayMs: 250,
      });
    },
  };
}

export async function applyCodexMigrationPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildCodexMigrationPlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "codex");
  const items: MigrationItem[] = [];
  const runtime = withCachedMigrationConfigRuntime(
    params.ctx.runtime ?? params.runtime,
    params.ctx.config,
  );
  const applyCtx = { ...params.ctx, runtime };
  for (const item of plan.items) {
    if (item.status !== "planned") {
      items.push(item);
      continue;
    }
    if (item.id === CODEX_PLUGIN_CONFIG_ITEM_ID) {
      items.push(await applyCodexPluginConfigItem(applyCtx, item, items));
    } else if (item.kind === "plugin" && item.action === "install") {
      items.push(await applyCodexPluginInstallItem(applyCtx, item));
    } else if (item.kind === "manual") {
      items.push(applyMigrationManualItem(item));
    } else if (item.action === "archive") {
      items.push(await archiveMigrationItem(item, reportDir));
    } else {
      items.push(await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite }));
    }
  }
  const result: MigrationApplyResult = {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    backupPath: params.ctx.backupPath,
    reportDir,
  };
  if (items.some(isCodexPluginLoadWarningItem)) {
    result.warnings = [...new Set([...(result.warnings ?? []), CODEX_PLUGIN_LOAD_WARNING])];
    result.nextSteps = [...new Set([CODEX_PLUGIN_LOAD_WARNING, ...(result.nextSteps ?? [])])];
  }
  await writeMigrationReport(result, { title: "Codex Migration Report" });
  return result;
}

async function applyCodexPluginInstallItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  const policy = readCodexPluginPolicy(item);
  if (!policy) {
    return {
      ...markMigrationItemError(item, "invalid Codex plugin migration item"),
      details: { ...item.details, code: "invalid_plugin_item" },
    };
  }
  try {
    const appCacheKey = await buildTargetCodexPluginAppCacheKey(ctx);
    const appServer = resolveTargetCodexAppServer(ctx);
    const result = await ensureCodexPluginActivation({
      identity: policy,
      installEvenIfActive: true,
      request: async (method, requestParams) =>
        await requestTargetCodexAppServerJson({
          method,
          requestParams,
          timeoutMs: 60_000,
          startOptions: appServer.start,
          agentDir: resolveCodexMigrationTargets(ctx).agentDir,
          config: ctx.config,
          isolated: false,
        }),
      appCache: defaultCodexAppInventoryCache,
      appCacheKey,
    });
    const baseDetails = {
      ...item.details,
      code: result.reason,
      activationReason: result.reason,
      ...codexPluginActivationReportState(result),
      installAttempted: result.installAttempted,
      diagnostics: result.diagnostics.map((diagnostic) => diagnostic.message),
    };
    if (result.ok) {
      return {
        ...item,
        status: "migrated",
        ...(result.reason === "already_active" ? { reason: "already active" } : {}),
        details: baseDetails,
      };
    }
    if (result.reason === CODEX_PLUGIN_AUTH_REQUIRED_REASON) {
      return {
        ...item,
        status: "skipped",
        reason: CODEX_PLUGIN_AUTH_REQUIRED_REASON,
        details: {
          ...baseDetails,
          appsNeedingAuth: sanitizeAppsNeedingAuth(result.installResponse?.appsNeedingAuth ?? []),
        },
      };
    }
    if (result.reason === "plugin_missing" || result.reason === "marketplace_missing") {
      return {
        ...item,
        status: "warning",
        reason: result.reason,
        message: `Codex plugin "${policy.pluginName}" could not be migrated automatically`,
        details: {
          ...baseDetails,
          warningReason: CODEX_PLUGIN_LOAD_WARNING,
        },
      };
    }
    return {
      ...item,
      status: "error",
      reason: result.reason,
      details: baseDetails,
    };
  } catch (error) {
    if (isCodexPluginInventoryLoadError(error)) {
      return {
        ...item,
        status: "warning",
        reason: "plugin_inventory_unavailable",
        message: `Codex plugin "${policy.pluginName}" could not be migrated automatically`,
        details: {
          ...item.details,
          code: "plugin_inventory_unavailable",
          warningReason: CODEX_PLUGIN_LOAD_WARNING,
          diagnostic: formatCodexMigrationError(error),
        },
      };
    }
    return {
      ...item,
      status: "error",
      reason: formatCodexMigrationError(error),
      details: {
        ...item.details,
        code: "plugin_install_failed",
      },
    };
  }
}

function isCodexPluginInventoryLoadError(error: unknown): boolean {
  const message = formatCodexMigrationError(error);
  return message.includes("codex app-server plugin/list timed out");
}

function formatCodexMigrationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveTargetCodexAppServer(ctx: MigrationProviderContext) {
  return resolveCodexAppServerRuntimeOptions({
    pluginConfig: readCodexPluginConfig(ctx.config),
  });
}

async function requestTargetCodexAppServerJson(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs: number;
  startOptions: ReturnType<typeof resolveTargetCodexAppServer>["start"];
  agentDir: string;
  config: MigrationProviderContext["config"];
  isolated?: boolean;
}): Promise<unknown> {
  if (params.method !== "plugin/list") {
    return await requestCodexAppServerJson(params);
  }

  const deadline = Date.now() + params.timeoutMs;
  const discoveryTimeoutMs = targetCodexMarketplaceDiscoveryTimeoutMs();
  const discoveryDeadline = Math.min(deadline, Date.now() + discoveryTimeoutMs);
  let lastResponse: unknown;
  let attempt = 0;
  do {
    attempt += 1;
    const remainingMs = Math.max(1, discoveryDeadline - Date.now());
    lastResponse = await requestCodexAppServerJson({
      ...params,
      timeoutMs: remainingMs,
    });
    if (hasOpenAiCuratedMarketplace(lastResponse)) {
      return lastResponse;
    }
    if (Date.now() >= discoveryDeadline) {
      return lastResponse;
    }
    const waitMs = Math.min(
      TARGET_CODEX_MARKETPLACE_DISCOVERY_POLL_MS,
      discoveryDeadline - Date.now(),
    );
    await sleep(waitMs);
  } while (Date.now() < discoveryDeadline);

  return lastResponse;
}

function hasOpenAiCuratedMarketplace(response: unknown): boolean {
  if (!response || typeof response !== "object" || !("marketplaces" in response)) {
    return false;
  }
  const marketplaces = (response as { marketplaces?: unknown }).marketplaces;
  return (
    Array.isArray(marketplaces) &&
    marketplaces.some(
      (marketplace) =>
        marketplace &&
        typeof marketplace === "object" &&
        (marketplace as { name?: unknown }).name === CODEX_PLUGINS_MARKETPLACE_NAME,
    )
  );
}

function targetCodexMarketplaceDiscoveryTimeoutMs(): number {
  const configured = Number(process.env[TARGET_CODEX_MARKETPLACE_DISCOVERY_TIMEOUT_ENV]);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return TARGET_CODEX_MARKETPLACE_DISCOVERY_TIMEOUT_MS;
}

function isCodexPluginLoadWarningItem(item: MigrationItem): boolean {
  return (
    item.kind === "plugin" &&
    item.action === "install" &&
    item.status === "warning" &&
    item.details?.warningReason === CODEX_PLUGIN_LOAD_WARNING
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildTargetCodexPluginAppCacheKey(ctx: MigrationProviderContext): Promise<string> {
  const targets = resolveCodexMigrationTargets(ctx);
  const appServer = resolveTargetCodexAppServer(ctx);
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    agentDir: targets.agentDir,
    config: ctx.config,
  });
  const accountId = await resolveCodexAppServerAuthAccountCacheKey({
    authProfileId,
    agentDir: targets.agentDir,
    config: ctx.config,
  });
  const envApiKeyFingerprint = authProfileId
    ? undefined
    : resolveCodexAppServerEnvApiKeyCacheKey({
        startOptions: appServer.start,
      });
  return buildCodexPluginAppCacheKey({
    appServer,
    agentDir: targets.agentDir,
    authProfileId,
    accountId,
    envApiKeyFingerprint,
  });
}

async function applyCodexPluginConfigItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  appliedItems: readonly MigrationItem[],
): Promise<MigrationItem> {
  const entries = appliedItems
    .map(readAppliedPluginConfigEntry)
    .filter((entry): entry is CodexPluginMigrationConfigEntry => entry !== undefined);
  if (entries.length === 0) {
    return markMigrationItemSkipped(item, "no selected Codex plugins");
  }
  const returnPatch = shouldReturnCodexPluginConfigPatch(ctx);
  const configApi = ctx.runtime?.config;
  const currentConfig = returnPatch
    ? ctx.config
    : (configApi?.current?.() as MigrationProviderContext["config"] | undefined);
  if (!currentConfig) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  const value = buildCodexPluginsConfigValue(entries, { config: currentConfig });
  if (!ctx.overwrite && hasCodexPluginConfigConflict(currentConfig, value)) {
    return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
  }
  const migratedItem: MigrationItem = {
    ...item,
    status: "migrated",
    details: {
      ...item.details,
      path: [...CODEX_PLUGIN_CONFIG_PATH],
      value,
    },
  };
  if (returnPatch) {
    return migratedItem;
  }
  if (!configApi?.mutateConfigFile) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  try {
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        if (!ctx.overwrite && hasCodexPluginConfigConflict(draft, value)) {
          throw new CodexPluginConfigConflictError(MIGRATION_REASON_TARGET_EXISTS);
        }
        writeMigrationConfigPath(draft as Record<string, unknown>, CODEX_PLUGIN_CONFIG_PATH, value);
      },
    });
    return migratedItem;
  } catch (error) {
    if (error instanceof CodexPluginConfigConflictError) {
      return markMigrationItemConflict(item, error.reason);
    }
    return markMigrationItemError(item, error instanceof Error ? error.message : String(error));
  }
}

function readAppliedPluginConfigEntry(
  item: MigrationItem,
): CodexPluginMigrationConfigEntry | undefined {
  if (item.status === "migrated") {
    return readCodexPluginMigrationConfigEntry(item, true);
  }
  if (
    item.status === "skipped" &&
    item.reason !== CODEX_PLUGIN_NOT_SELECTED_REASON &&
    item.reason === CODEX_PLUGIN_AUTH_REQUIRED_REASON
  ) {
    return readCodexPluginMigrationConfigEntry(item, false);
  }
  return undefined;
}

function readCodexPluginPolicy(item: MigrationItem): ResolvedCodexPluginPolicy | undefined {
  const configKey = item.details?.configKey;
  const marketplaceName = item.details?.marketplaceName;
  const pluginName = item.details?.pluginName;
  if (
    typeof configKey !== "string" ||
    marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME ||
    typeof pluginName !== "string"
  ) {
    return undefined;
  }
  return {
    configKey,
    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    pluginName,
    enabled: true,
    allowDestructiveActions: true,
  };
}

function codexPluginActivationReportState(result: CodexPluginActivationResult): {
  installed?: boolean;
  enabled?: boolean;
} {
  switch (result.reason) {
    case "already_active":
    case "installed":
      return { installed: true, enabled: true };
    case "auth_required":
      return { installed: true, enabled: false };
    case "disabled":
    case "marketplace_missing":
    case "plugin_missing":
      return { installed: false, enabled: false };
    case "refresh_failed":
      return { installed: true, enabled: false };
  }
  const exhaustiveReason: never = result.reason;
  return exhaustiveReason;
}

function sanitizeAppsNeedingAuth(apps: readonly v2.AppSummary[]): Array<{
  id: string;
  name: string;
  needsAuth: boolean;
}> {
  return apps.map((app) => ({
    id: app.id,
    name: app.name,
    needsAuth: app.needsAuth,
  }));
}
