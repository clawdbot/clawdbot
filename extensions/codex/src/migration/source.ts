// Codex plugin module implements source behavior.
import path from "node:path";
import {
  defaultCodexAppInventoryCache,
  type CodexAppInventoryRequest,
} from "../app-server/app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import type { CodexAppServerStartOptions } from "../app-server/config.js";
import { buildCodexPluginAppCacheKey } from "../app-server/plugin-app-cache-key.js";
import {
  pluginReadParams,
  type CodexPluginMarketplaceRef,
} from "../app-server/plugin-inventory.js";
import type { CodexGetAccountResponse, v2 } from "../app-server/protocol.js";
import { requestCodexAppServerJson } from "../app-server/request.js";
import { exists, isDirectory, resolveHomePath, resolveUserHomeDir } from "./helpers.js";
import {
  discoverCodexMemorySources,
  discoverPluginDirs,
  discoverSkillDirs,
  type CodexMemorySource,
  type CodexPluginMigrationAppFact,
  type CodexPluginMigrationBlockCode,
  type CodexPluginSource,
  type CodexSkillSource,
} from "./source-files.js";

export type { CodexPluginSource } from "./source-files.js";

type CodexArchiveSource = {
  id: string;
  path: string;
  relativePath: string;
  message?: string;
};

export type CodexSource = {
  root: string;
  confidence: "low" | "medium" | "high";
  codexHome: string;
  codexSkillsDir?: string;
  personalAgentsSkillsDir?: string;
  configPath?: string;
  authPath?: string;
  modelsCachePath?: string;
  hooksPath?: string;
  memoriesDir?: string;
  memoryFiles: CodexMemorySource[];
  skills: CodexSkillSource[];
  plugins: CodexPluginSource[];
  pluginDiscoveryError?: string;
  archivePaths: CodexArchiveSource[];
};

type CodexSourceDiscoveryOptions = {
  input?: string;
  memoryOnly?: boolean;
  evaluatePluginMigrationEligibility?: boolean;
  verifyPluginApps?: boolean;
};

type SourceAppServerRequestOptions = {
  startOptions: CodexAppServerStartOptions;
};

type PluginReadResult =
  | {
      ok: true;
      detail: v2.PluginDetail;
    }
  | {
      ok: false;
      error: string;
    };

function defaultCodexHome(): string {
  const configuredHome = process.env.CODEX_HOME;
  // Codex preserves nonempty CODEX_HOME verbatim; --from remains trimmed below as CLI convenience.
  return resolveHomePath(
    configuredHome !== undefined && configuredHome.length > 0 ? configuredHome : "~/.codex",
  );
}

function personalAgentsSkillsDir(): string {
  return path.join(resolveUserHomeDir(), ".agents", "skills");
}

async function discoverInstalledCuratedPlugins(
  codexHome: string,
  options: CodexSourceDiscoveryOptions = {},
): Promise<{
  plugins: CodexPluginSource[];
  error?: string;
}> {
  const startOptions = sourceCodexAppServerStartOptions(codexHome);
  const requestOptions = { startOptions };
  try {
    const response = await requestSourceCodexAppServerJson<v2.PluginListResponse>(requestOptions, {
      method: "plugin/list",
      requestParams: { cwds: [] } satisfies v2.PluginListParams,
    });
    const marketplace = response.marketplaces.find(
      (entry) => entry.name === CODEX_PLUGINS_MARKETPLACE_NAME,
    );
    if (!marketplace) {
      return {
        plugins: [],
        error: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found in source plugin inventory.`,
      };
    }
    const plugins = marketplace.plugins
      .filter((plugin) => plugin.installed)
      .map((plugin) => buildInstalledPluginSource(plugin))
      .filter((plugin): plugin is CodexPluginSource => plugin !== undefined);
    const withEligibility =
      options.evaluatePluginMigrationEligibility === true
        ? await withPluginMigrationEligibility({
            plugins,
            marketplace: marketplaceRef(marketplace),
            requestOptions,
            verifyPluginApps: options.verifyPluginApps === true,
          })
        : plugins;
    const sorted = withEligibility.toSorted((a, b) =>
      (a.pluginName ?? a.name).localeCompare(b.pluginName ?? b.name),
    );
    return { plugins: sorted };
  } catch (error) {
    return {
      plugins: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceCodexAppServerStartOptions(codexHome: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource: "managed",
    managedCommandOrder: "desktop-first",
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
    env: {
      CODEX_HOME: codexHome,
      HOME: path.dirname(codexHome),
    },
  };
}

async function requestSourceCodexAppServerJson<T>(
  options: SourceAppServerRequestOptions,
  params: {
    method: string;
    requestParams?: unknown;
  },
): Promise<T> {
  return await requestCodexAppServerJson<T>({
    method: params.method,
    requestParams: params.requestParams,
    timeoutMs: 60_000,
    startOptions: options.startOptions,
    authProfileId: null,
    isolated: true,
  });
}

function buildInstalledPluginSource(plugin: v2.PluginSummary): CodexPluginSource | undefined {
  const pluginName = pluginNameFromSummary(plugin);
  if (!pluginName) {
    return undefined;
  }
  return {
    name: plugin.name,
    pluginName,
    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    source: `${CODEX_PLUGINS_MARKETPLACE_NAME}/${pluginName}`,
    sourceKind: "app-server",
    migratable: true,
    installed: plugin.installed,
    enabled: plugin.enabled,
  };
}

function marketplaceRef(marketplace: v2.PluginMarketplaceEntry): CodexPluginMarketplaceRef {
  return {
    name: CODEX_PLUGINS_MARKETPLACE_NAME,
    ...(marketplace.path ? { path: marketplace.path } : {}),
    ...(!marketplace.path ? { remoteMarketplaceName: marketplace.name } : {}),
  };
}

async function withPluginMigrationEligibility(params: {
  plugins: CodexPluginSource[];
  marketplace: CodexPluginMarketplaceRef;
  requestOptions: SourceAppServerRequestOptions;
  verifyPluginApps: boolean;
}): Promise<CodexPluginSource[]> {
  const pending: Array<{ plugin: CodexPluginSource; apps: CodexPluginMigrationAppFact[] }> = [];
  const evaluated: CodexPluginSource[] = [];

  for (const plugin of params.plugins) {
    if (plugin.enabled !== true) {
      evaluated.push({
        ...plugin,
        migratable: false,
        migrationBlock: { code: "plugin_disabled" },
        message: `Codex plugin "${plugin.pluginName ?? plugin.name}" is installed in Codex but disabled; enable it in Codex before migrating it to OpenClaw.`,
      });
      continue;
    }

    const detail = await readPluginDetail(params.requestOptions, params.marketplace, plugin);
    if (!detail.ok) {
      evaluated.push({
        ...plugin,
        migratable: false,
        migrationBlock: { code: "plugin_read_unavailable", error: detail.error },
        message: `Codex plugin "${plugin.pluginName ?? plugin.name}" detail could not be read: ${detail.error}`,
      });
      continue;
    }

    if (detail.detail.apps.length === 0) {
      evaluated.push({
        ...plugin,
        migratable: true,
      });
      continue;
    }

    const apps = detail.detail.apps
      .map(sourcePluginAppFact)
      .toSorted((left, right) => left.id.localeCompare(right.id));
    pending.push({ plugin, apps });
  }

  if (pending.length === 0) {
    return evaluated;
  }

  let sourceAccount: Awaited<ReturnType<typeof readSourceCodexAccount>> | undefined;
  try {
    sourceAccount = await readSourceCodexAccount(params.requestOptions);
  } catch (error) {
    if (!params.verifyPluginApps) {
      const message = error instanceof Error ? error.message : String(error);
      for (const { plugin, apps } of pending) {
        evaluated.push({
          ...plugin,
          migratable: false,
          migrationBlock: { code: "codex_account_unavailable", apps, error: message },
          message: `Codex plugin "${plugin.pluginName ?? plugin.name}" owns apps, but the source Codex app-server account could not be read: ${message}`,
        });
      }
      return evaluated;
    }
  }
  if (sourceAccount && sourceAccount !== "chatgpt") {
    for (const { plugin, apps } of pending) {
      evaluated.push({
        ...plugin,
        migratable: false,
        migrationBlock: { code: "codex_subscription_required", apps },
        message: codexSubscriptionRequiredMessage(plugin),
      });
    }
    return evaluated;
  }

  if (!params.verifyPluginApps) {
    for (const { plugin, apps } of pending) {
      evaluated.push({
        ...plugin,
        apps,
        migratable: true,
      });
    }
    return evaluated;
  }

  const snapshot = await refreshSourceAppInventory(params.requestOptions).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const { plugin, apps } of pending) {
        evaluated.push({
          ...plugin,
          migratable: false,
          migrationBlock: {
            code: "app_inventory_unavailable",
            apps,
            error: message,
          },
          message: `Codex plugin "${plugin.pluginName ?? plugin.name}" owns apps, but source app inventory could not be read: ${message}`,
        });
      }
      return undefined;
    },
  );
  if (!snapshot) {
    return evaluated;
  }

  const appInfoById = new Map(snapshot.apps.map((app) => [app.id, app] as const));
  for (const { plugin, apps: declaredApps } of pending) {
    const apps = declaredApps
      .map((app) => sourcePluginAppFactWithInventory(app, appInfoById.get(app.id)))
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const blockCode = migrationBlockCodeForApps(apps);
    if (!blockCode) {
      evaluated.push({ ...plugin, apps, migratable: true });
      continue;
    }
    evaluated.push({
      ...plugin,
      migratable: false,
      migrationBlock: { code: blockCode, apps },
      message: appInventoryBlockMessage(plugin, apps, blockCode),
    });
  }

  return evaluated;
}

async function readSourceCodexAccount(
  options: SourceAppServerRequestOptions,
): Promise<"chatgpt" | "non_chatgpt" | "missing"> {
  const response = await requestSourceCodexAppServerJson<CodexGetAccountResponse>(options, {
    method: "account/read",
    requestParams: { refreshToken: false },
  });
  if (
    !response.account ||
    typeof response.account !== "object" ||
    Array.isArray(response.account)
  ) {
    return "missing";
  }
  const type = response.account.type;
  return type === "chatgpt" ? "chatgpt" : "non_chatgpt";
}

async function readPluginDetail(
  options: SourceAppServerRequestOptions,
  marketplace: CodexPluginMarketplaceRef,
  plugin: CodexPluginSource,
): Promise<PluginReadResult> {
  try {
    const response = await requestSourceCodexAppServerJson<v2.PluginReadResponse>(options, {
      method: "plugin/read",
      requestParams: pluginReadParams(marketplace, plugin.pluginName ?? plugin.name),
    });
    return { ok: true, detail: response.plugin };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function refreshSourceAppInventory(
  options: SourceAppServerRequestOptions,
): Promise<Awaited<ReturnType<typeof defaultCodexAppInventoryCache.refreshNow>>> {
  const key = buildCodexPluginAppCacheKey({
    appServer: { start: options.startOptions },
  });
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    await requestSourceCodexAppServerJson<v2.AppsListResponse>(options, {
      method,
      requestParams,
    });
  return await defaultCodexAppInventoryCache.refreshNow({
    key,
    request,
    forceRefetch: true,
  });
}

function sourcePluginAppFact(app: v2.AppSummary): CodexPluginMigrationAppFact {
  return {
    id: app.id,
    name: app.name,
    needsAuth: app.needsAuth,
  };
}

function sourcePluginAppFactWithInventory(
  app: CodexPluginMigrationAppFact,
  info: v2.AppInfo | undefined,
): CodexPluginMigrationAppFact {
  if (!info) {
    return app;
  }
  return {
    ...app,
    isAccessible: info.isAccessible,
    isEnabled: info.isEnabled,
  };
}

function migrationBlockCodeForApps(
  apps: readonly CodexPluginMigrationAppFact[],
): CodexPluginMigrationBlockCode | undefined {
  if (apps.some((app) => app.isAccessible === false)) {
    return "app_inaccessible";
  }
  if (apps.some((app) => app.isEnabled === false)) {
    return "app_disabled";
  }
  if (apps.some((app) => app.isAccessible === undefined || app.isEnabled === undefined)) {
    return "app_missing";
  }
  return undefined;
}

function appInventoryBlockMessage(
  plugin: CodexPluginSource,
  apps: readonly CodexPluginMigrationAppFact[],
  code: CodexPluginMigrationBlockCode,
): string {
  const status =
    code === "app_inaccessible" ? "inaccessible" : code === "app_disabled" ? "disabled" : "missing";
  const blocking =
    apps.find((app) =>
      code === "app_inaccessible"
        ? app.isAccessible === false
        : code === "app_disabled"
          ? app.isEnabled === false
          : app.isAccessible === undefined || app.isEnabled === undefined,
    ) ?? apps[0];
  const appLabel = blocking ? ` app "${blocking.name}"` : " an owned app";
  return `Codex plugin "${plugin.pluginName ?? plugin.name}" owns${appLabel} but the source app inventory reports it is ${status}; authenticate or enable the app in Codex before migrating it to OpenClaw.`;
}

export function codexPluginMigrationSubscriptionWarning(): string {
  return "Codex app-backed plugin migration requires the Codex app-server source account to be logged in with a ChatGPT subscription account. Log in to the Codex app with subscription auth; OpenClaw auth or API-key auth does not satisfy Codex app connector access.";
}

function codexSubscriptionRequiredMessage(plugin: CodexPluginSource): string {
  return `Codex plugin "${plugin.pluginName ?? plugin.name}" owns apps, but ${codexPluginMigrationSubscriptionWarning()}`;
}

function pluginNameFromSummary(summary: v2.PluginSummary): string | undefined {
  const candidates = [summary.id, summary.name];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const withoutMarketplaceSuffix = trimmed.endsWith(`@${CODEX_PLUGINS_MARKETPLACE_NAME}`)
      ? trimmed.slice(0, -`@${CODEX_PLUGINS_MARKETPLACE_NAME}`.length)
      : trimmed;
    const pathSegment = withoutMarketplaceSuffix.split("/").at(-1)?.trim();
    const normalized = pathSegment?.toLowerCase().replaceAll(/\s+/gu, "-");
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export async function discoverCodexSource(
  inputOrOptions?: string | CodexSourceDiscoveryOptions,
): Promise<CodexSource> {
  const options =
    typeof inputOrOptions === "string" || inputOrOptions === undefined
      ? { input: inputOrOptions }
      : inputOrOptions;
  const codexHome = resolveHomePath(options.input?.trim() || defaultCodexHome());
  const codexSkillsDir = path.join(codexHome, "skills");
  const agentsSkillsDir = personalAgentsSkillsDir();
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const modelsCachePath = path.join(codexHome, "models_cache.json");
  const hooksPath = path.join(codexHome, "hooks", "hooks.json");
  const { memoriesDir, memoryFiles } = await discoverCodexMemorySources(codexHome);
  const codexSkills = options.memoryOnly
    ? []
    : await discoverSkillDirs({
        root: codexSkillsDir,
        sourceLabel: "Codex skill",
        excludeSystem: true,
      });
  const personalAgentSkills = options.memoryOnly
    ? []
    : await discoverSkillDirs({
        root: agentsSkillsDir,
        sourceLabel: "personal AgentSkill",
      });
  const sourcePluginDiscovery: { plugins: CodexPluginSource[]; error?: string } = options.memoryOnly
    ? { plugins: [] }
    : await discoverInstalledCuratedPlugins(codexHome, options);
  const sourcePluginNames = new Set(
    sourcePluginDiscovery.plugins.flatMap((plugin) =>
      plugin.pluginName ? [plugin.pluginName] : [],
    ),
  );
  const cachedPlugins = (options.memoryOnly ? [] : await discoverPluginDirs(codexHome)).filter(
    (plugin) => {
      const normalizedName = sanitizePluginName(plugin.name);
      return !sourcePluginNames.has(normalizedName);
    },
  );
  const plugins = [...sourcePluginDiscovery.plugins, ...cachedPlugins].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
  const archivePaths: CodexArchiveSource[] = [];
  if (!options.memoryOnly && (await exists(configPath))) {
    archivePaths.push({
      id: "archive:config.toml",
      path: configPath,
      relativePath: "config.toml",
      message: "Codex config is archived for manual review; it is not activated automatically",
    });
  }
  if (!options.memoryOnly && (await exists(hooksPath))) {
    archivePaths.push({
      id: "archive:hooks/hooks.json",
      path: hooksPath,
      relativePath: "hooks/hooks.json",
      message:
        "Codex native hooks are archived for manual review because they can execute commands",
    });
  }
  const skills = [...codexSkills, ...personalAgentSkills].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
  const hasAuth = !options.memoryOnly && (await exists(authPath));
  const high = Boolean(
    memoryFiles.length || codexSkills.length || plugins.length || archivePaths.length || hasAuth,
  );
  const medium = personalAgentSkills.length > 0;
  return {
    root: codexHome,
    confidence: high ? "high" : medium ? "medium" : "low",
    codexHome,
    ...((await isDirectory(codexSkillsDir)) ? { codexSkillsDir } : {}),
    ...((await isDirectory(agentsSkillsDir)) ? { personalAgentsSkillsDir: agentsSkillsDir } : {}),
    ...((await exists(configPath)) ? { configPath } : {}),
    ...(hasAuth ? { authPath } : {}),
    ...((await exists(modelsCachePath)) ? { modelsCachePath } : {}),
    ...((await exists(hooksPath)) ? { hooksPath } : {}),
    ...(memoriesDir ? { memoriesDir } : {}),
    memoryFiles,
    skills,
    plugins,
    ...(sourcePluginDiscovery.error ? { pluginDiscoveryError: sourcePluginDiscovery.error } : {}),
    archivePaths,
  };
}

export function hasCodexSource(source: CodexSource): boolean {
  return source.confidence !== "low";
}

function sanitizePluginName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, "-");
}
