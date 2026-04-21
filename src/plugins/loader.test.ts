import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { listAgentHarnessIds } from "../agents/harness/registry.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { getContextEngineFactory, listContextEngineIds } from "../context-engine/registry.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  clearDetachedTaskLifecycleRuntimeRegistration,
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskLifecycleRuntime,
  type DetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime-state.js";
import { withEnv } from "../test-utils/env.js";
import { clearPluginCommands, getPluginCommandSpecs } from "./command-registry-state.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createHookRunner } from "./hooks.js";
import {
  clearPluginInteractiveHandlers,
  resolvePluginInteractiveNamespaceMatch,
} from "./interactive-registry.js";
import {
  __testing,
  clearPluginLoaderCache,
  loadOpenClawPlugins,
  PluginLoadReentryError,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  mkdirSafe,
  type PluginLoadConfig,
  type PluginRegistry,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  listMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryRuntime,
  listActiveMemoryPublicArtifacts,
  listMemoryCorpusSupplements,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSupplement,
  registerMemoryPromptSection,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
} from "./memory-state.js";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  listImportedRuntimePluginIds,
  setActivePluginRegistry,
} from "./runtime.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";
let cachedBundledTelegramDir = "";
let cachedBundledMemoryDir = "";

function createDetachedTaskRuntimeStub(id: string): DetachedTaskLifecycleRuntime {
  const fail = (name: string): never => {
    throw new Error(`detached runtime ${id} should not execute ${name} in this test`);
  };
  return {
    createQueuedTaskRun: () => fail("createQueuedTaskRun"),
    createRunningTaskRun: () => fail("createRunningTaskRun"),
    startTaskRunByRunId: () => fail("startTaskRunByRunId"),
    recordTaskRunProgressByRunId: () => fail("recordTaskRunProgressByRunId"),
    completeTaskRunByRunId: () => fail("completeTaskRunByRunId"),
    failTaskRunByRunId: () => fail("failTaskRunByRunId"),
    setDetachedTaskDeliveryStatusByRunId: () => fail("setDetachedTaskDeliveryStatusByRunId"),
    cancelDetachedTaskRunById: async () => ({
      found: true,
      cancelled: true,
    }),
  };
}

const BUNDLED_TELEGRAM_PLUGIN_BODY = `module.exports = {
  id: "telegram",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "telegram",
        meta: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "telegram channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`;

function simplePluginBody(id: string) {
  return `module.exports = { id: ${JSON.stringify(id)}, register() {} };`;
}

function memoryPluginBody(id: string) {
  return `module.exports = { id: ${JSON.stringify(id)}, kind: "memory", register() {} };`;
}

const RESERVED_ADMIN_PLUGIN_METHOD = "config.plugin.inspect";
const RESERVED_ADMIN_SCOPE_WARNING =
  "gateway method scope coerced to operator.admin for reserved core namespace";

function writeBundledPlugin(params: {
  id: string;
  body?: string;
  filename?: string;
  bundledDir?: string;
}) {
  const bundledDir = params.bundledDir ?? makeTempDir();
  const plugin = writePlugin({
    id: params.id,
    dir: bundledDir,
    filename: params.filename ?? "index.cjs",
    body: params.body ?? simplePluginBody(params.id),
  });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
  return { bundledDir, plugin };
}

function writeWorkspacePlugin(params: {
  id: string;
  body?: string;
  filename?: string;
  workspaceDir?: string;
}) {
  const workspaceDir = params.workspaceDir ?? makeTempDir();
  const workspacePluginDir = path.join(workspaceDir, ".openclaw", "extensions", params.id);
  mkdirSafe(workspacePluginDir);
  const plugin = writePlugin({
    id: params.id,
    dir: workspacePluginDir,
    filename: params.filename ?? "index.cjs",
    body: params.body ?? simplePluginBody(params.id),
  });
  return { workspaceDir, workspacePluginDir, plugin };
}

function withStateDir<T>(run: (stateDir: string) => T) {
  const stateDir = makeTempDir();
  return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => run(stateDir));
}

function loadBundledMemoryPluginRegistry(options?: {
  packageMeta?: { name: string; version: string; description?: string };
  pluginBody?: string;
  pluginFilename?: string;
}) {
  if (!options && cachedBundledMemoryDir) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = cachedBundledMemoryDir;
    return loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledMemoryDir,
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
        },
      },
    });
  }

  const bundledDir = makeTempDir();
  let pluginDir = bundledDir;
  let pluginFilename = options?.pluginFilename ?? "memory-core.cjs";

  if (options?.packageMeta) {
    pluginDir = path.join(bundledDir, "memory-core");
    pluginFilename = options.pluginFilename ?? "index.js";
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: options.packageMeta.name,
          version: options.packageMeta.version,
          description: options.packageMeta.description,
          openclaw: { extensions: [`./${pluginFilename}`] },
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  writePlugin({
    id: "memory-core",
    body:
      options?.pluginBody ??
      `module.exports = { id: "memory-core", kind: "memory", register() {} };`,
    dir: pluginDir,
    filename: pluginFilename,
  });
  if (!options) {
    cachedBundledMemoryDir = bundledDir;
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: bundledDir,
    config: {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    },
  });
}

function setupBundledTelegramPlugin() {
  if (!cachedBundledTelegramDir) {
    cachedBundledTelegramDir = makeTempDir();
    writePlugin({
      id: "telegram",
      body: BUNDLED_TELEGRAM_PLUGIN_BODY,
      dir: cachedBundledTelegramDir,
      filename: "telegram.cjs",
    });
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = cachedBundledTelegramDir;
}

function expectTelegramLoaded(registry: ReturnType<typeof loadOpenClawPlugins>) {
  const telegram = registry.plugins.find((entry) => entry.id === "telegram");
  expect(telegram?.status).toBe("loaded");
  expect(registry.channels.some((entry) => entry.plugin.id === "telegram")).toBe(true);
}

function loadRegistryFromSinglePlugin(params: {
  plugin: TempPlugin;
  pluginConfig?: Record<string, unknown>;
  includeWorkspaceDir?: boolean;
  options?: Omit<Parameters<typeof loadOpenClawPlugins>[0], "cache" | "workspaceDir" | "config">;
}) {
  const pluginConfig = params.pluginConfig ?? {};
  return loadOpenClawPlugins({
    cache: false,
    ...(params.includeWorkspaceDir === false ? {} : { workspaceDir: params.plugin.dir }),
    ...params.options,
    config: {
      plugins: {
        load: { paths: [params.plugin.file] },
        ...pluginConfig,
      },
    },
  });
}

function loadRegistryFromAllowedPlugins(
  plugins: TempPlugin[],
  options?: Omit<Parameters<typeof loadOpenClawPlugins>[0], "cache" | "config">,
) {
  return loadOpenClawPlugins({
    cache: false,
    ...options,
    config: {
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.file) },
        allow: plugins.map((plugin) => plugin.id),
      },
    },
  });
}

function runRegistryScenarios<
  T extends { assert: (registry: PluginRegistry, scenario: T) => void },
>(scenarios: readonly T[], loadRegistry: (scenario: T) => PluginRegistry) {
  for (const scenario of scenarios) {
    scenario.assert(loadRegistry(scenario), scenario);
  }
}

function runScenarioCases<T>(scenarios: readonly T[], run: (scenario: T) => void) {
  for (const scenario of scenarios) {
    run(scenario);
  }
}

function runSinglePluginRegistryScenarios<
  T extends {
    pluginId: string;
    body: string;
    assert: (registry: PluginRegistry, scenario: T) => void;
  },
>(scenarios: readonly T[], resolvePluginConfig?: (scenario: T) => Record<string, unknown>) {
  runRegistryScenarios(scenarios, (scenario) => {
    const plugin = writePlugin({
      id: scenario.pluginId,
      filename: `${scenario.pluginId}.cjs`,
      body: scenario.body,
    });
    return loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: resolvePluginConfig?.(scenario) ?? { allow: [scenario.pluginId] },
    });
  });
}

function loadRegistryFromScenarioPlugins(plugins: readonly TempPlugin[]) {
  return plugins.length === 1
    ? loadRegistryFromSinglePlugin({
        plugin: plugins[0],
        pluginConfig: {
          allow: [plugins[0].id],
        },
      })
    : loadRegistryFromAllowedPlugins([...plugins]);
}

function expectOpenAllowWarnings(params: {
  warnings: string[];
  pluginId: string;
  expectedWarnings: number;
  label: string;
}) {
  const openAllowWarnings = params.warnings.filter((msg) => msg.includes("plugins.allow is empty"));
  expect(openAllowWarnings, params.label).toHaveLength(params.expectedWarnings);
  if (params.expectedWarnings > 0) {
    expect(
      openAllowWarnings.some((msg) => msg.includes(params.pluginId)),
      params.label,
    ).toBe(true);
  }
}

function expectLoadedPluginProvenance(params: {
  scenario: { label: string };
  registry: PluginRegistry;
  warnings: string[];
  pluginId: string;
  expectWarning: boolean;
  expectedSource?: string;
}) {
  const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
  expect(plugin?.status, params.scenario.label).toBe("loaded");
  if (params.expectedSource) {
    expect(plugin?.source, params.scenario.label).toBe(params.expectedSource);
  }
  expect(
    params.warnings.some(
      (msg) =>
        msg.includes(params.pluginId) &&
        msg.includes("loaded without install/load-path provenance"),
    ),
    params.scenario.label,
  ).toBe(params.expectWarning);
}

function expectRegisteredHttpRoute(
  registry: PluginRegistry,
  scenario: {
    pluginId: string;
    expectedPath: string;
    expectedAuth: string;
    expectedMatch: string;
    label: string;
  },
) {
  const route = registry.httpRoutes.find((entry) => entry.pluginId === scenario.pluginId);
  expect(route, scenario.label).toBeDefined();
  expect(route?.path, scenario.label).toBe(scenario.expectedPath);
  expect(route?.auth, scenario.label).toBe(scenario.expectedAuth);
  expect(route?.match, scenario.label).toBe(scenario.expectedMatch);
  const httpPlugin = registry.plugins.find((entry) => entry.id === scenario.pluginId);
  expect(httpPlugin?.httpRoutes, scenario.label).toBe(1);
}

function expectDuplicateRegistrationResult(
  registry: PluginRegistry,
  scenario: {
    selectCount: (registry: PluginRegistry) => number;
    ownerB: string;
    duplicateMessage: string;
    label: string;
    assertPrimaryOwner?: (registry: PluginRegistry) => void;
  },
) {
  expect(scenario.selectCount(registry), scenario.label).toBe(1);
  scenario.assertPrimaryOwner?.(registry);
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.level === "error" &&
        diag.pluginId === scenario.ownerB &&
        diag.message === scenario.duplicateMessage,
    ),
    scenario.label,
  ).toBe(true);
}

function expectPluginSourcePrecedence(
  registry: PluginRegistry,
  scenario: {
    pluginId: string;
    expectedLoadedOrigin: string;
    expectedDisabledOrigin: string;
    label: string;
    expectedDisabledError?: string;
  },
) {
  const entries = registry.plugins.filter((entry) => entry.id === scenario.pluginId);
  expect(entries, scenario.label).toHaveLength(1);
  const loaded = entries[0];
  expect(loaded?.origin, scenario.label).toBe(scenario.expectedLoadedOrigin);
  expect(loaded?.status, scenario.label).toBe("loaded");
  const expectedWarning =
    scenario.expectedDisabledError ??
    `${scenario.expectedDisabledOrigin} plugin will be overridden by ${scenario.expectedLoadedOrigin} plugin`;
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.level === "warn" &&
        diag.pluginId === scenario.pluginId &&
        diag.message.includes(expectedWarning),
    ),
    scenario.label,
  ).toBe(true);
}

function expectPluginOriginAndStatus(params: {
  registry: PluginRegistry;
  pluginId: string;
  origin: string;
  status: string;
  label: string;
  errorIncludes?: string;
}) {
  const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
  expect(plugin?.origin, params.label).toBe(params.origin);
  expect(plugin?.status, params.label).toBe(params.status);
  if (params.errorIncludes) {
    expect(plugin?.error, params.label).toContain(params.errorIncludes);
  }
}

function expectRegistryErrorDiagnostic(params: {
  registry: PluginRegistry;
  pluginId: string;
  message: string;
}) {
  expect(
    params.registry.diagnostics.some(
      (diag) =>
        diag.level === "error" &&
        diag.pluginId === params.pluginId &&
        diag.message === params.message,
    ),
  ).toBe(true);
}

function createWarningLogger(warnings: string[]) {
  return {
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
  };
}

function createErrorLogger(errors: string[]) {
  return {
    info: () => {},
    warn: () => {},
    error: (msg: string) => errors.push(msg),
    debug: () => {},
  };
}

function createEscapingEntryFixture(params: { id: string; sourceBody: string }) {
  const pluginDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideEntry = path.join(outsideDir, "outside.cjs");
  const linkedEntry = path.join(pluginDir, "entry.cjs");
  fs.writeFileSync(outsideEntry, params.sourceBody, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { pluginDir, outsideEntry, linkedEntry };
}

function resolveLoadedPluginSource(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  pluginId: string,
) {
  return fs.realpathSync(registry.plugins.find((entry) => entry.id === pluginId)?.source ?? "");
}

function expectCachePartitionByPluginSource(params: {
  pluginId: string;
  loadFirst: () => ReturnType<typeof loadOpenClawPlugins>;
  loadSecond: () => ReturnType<typeof loadOpenClawPlugins>;
  expectedFirstSource: string;
  expectedSecondSource: string;
}) {
  const first = params.loadFirst();
  const second = params.loadSecond();

  expect(second).not.toBe(first);
  expect(resolveLoadedPluginSource(first, params.pluginId)).toBe(
    fs.realpathSync(params.expectedFirstSource),
  );
  expect(resolveLoadedPluginSource(second, params.pluginId)).toBe(
    fs.realpathSync(params.expectedSecondSource),
  );
}

function expectCacheMissThenHit(params: {
  loadFirst: () => ReturnType<typeof loadOpenClawPlugins>;
  loadVariant: () => ReturnType<typeof loadOpenClawPlugins>;
}) {
  const first = params.loadFirst();
  const second = params.loadVariant();
  const third = params.loadVariant();

  expect(second).not.toBe(first);
  expect(third).toBe(second);
}

function createSetupEntryChannelPluginFixture(params: {
  id: string;
  label: string;
  packageName: string;
  fullBlurb: string;
  setupBlurb: string;
  configured: boolean;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  useBundledFullEntryContract?: boolean;
  bundledFullEntryId?: string;
  useBundledSetupEntryContract?: boolean;
  bundledSetupEntryId?: string;
  splitBundledSetupSecrets?: boolean;
  bundledSetupRuntimeMarker?: string;
  bundledSetupRuntimeError?: string;
  bundledFullRuntimeMarker?: string;
  requireBundledFullRuntimeBeforeLoad?: boolean;
}) {
  useNoBundledPlugins();
  const pluginDir = makeTempDir();
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  const listAccountIds = params.configured ? '["default"]' : "[]";
  const resolveAccount = params.configured
    ? '({ accountId: "default", token: "configured" })'
    : '({ accountId: "default" })';

  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: params.packageName,
        openclaw: {
          extensions: ["./index.cjs"],
          setupEntry: "./setup-entry.cjs",
          ...(params.startupDeferConfiguredChannelFullLoadUntilAfterListen
            ? {
                startup: {
                  deferConfiguredChannelFullLoadUntilAfterListen: true,
                },
              }
            : {}),
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        channels: [params.id],
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    params.useBundledFullEntryContract
      ? `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  kind: "bundled-channel-entry",
  id: ${JSON.stringify(params.bundledFullEntryId ?? params.id)},
  name: ${JSON.stringify(params.label)},
  description: ${JSON.stringify(params.fullBlurb)},
  loadChannelPlugin: () => {
    ${
      params.requireBundledFullRuntimeBeforeLoad && params.bundledFullRuntimeMarker
        ? `if (!require("node:fs").existsSync(${JSON.stringify(params.bundledFullRuntimeMarker)})) {
      throw new Error("bundled runtime not initialized");
    }`
        : ""
    }
    return {
      id: ${JSON.stringify(params.bundledFullEntryId ?? params.id)},
      meta: {
        id: ${JSON.stringify(params.bundledFullEntryId ?? params.id)},
        label: ${JSON.stringify(params.label)},
        selectionLabel: ${JSON.stringify(params.label)},
        docsPath: ${JSON.stringify(`/channels/${params.bundledFullEntryId ?? params.id}`)},
        blurb: ${JSON.stringify(params.fullBlurb)},
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ${listAccountIds},
        resolveAccount: () => ${resolveAccount},
      },
      outbound: { deliveryMode: "direct" },
    };
  },
  ${
    params.bundledFullRuntimeMarker
      ? `setChannelRuntime: () => {
    require("node:fs").writeFileSync(${JSON.stringify(params.bundledFullRuntimeMarker)}, "loaded", "utf-8");
  },`
      : ""
  }
  register() {},
};`
      : `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: ${JSON.stringify(params.id)},
  register(api) {
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(params.id)},
        meta: {
          id: ${JSON.stringify(params.id)},
          label: ${JSON.stringify(params.label)},
          selectionLabel: ${JSON.stringify(params.label)},
          docsPath: ${JSON.stringify(`/channels/${params.id}`)},
          blurb: ${JSON.stringify(params.fullBlurb)},
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ${listAccountIds},
          resolveAccount: () => ${resolveAccount},
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "setup-entry.cjs"),
    params.useBundledSetupEntryContract
      ? `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin: () => ({
    id: ${JSON.stringify(params.bundledSetupEntryId ?? params.id)},
    meta: {
      id: ${JSON.stringify(params.bundledSetupEntryId ?? params.id)},
      label: ${JSON.stringify(params.label)},
      selectionLabel: ${JSON.stringify(params.label)},
      docsPath: ${JSON.stringify(`/channels/${params.bundledSetupEntryId ?? params.id}`)},
      blurb: ${JSON.stringify(params.setupBlurb)},
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ${listAccountIds},
      resolveAccount: () => ${resolveAccount},
    },
    outbound: { deliveryMode: "direct" },
  }),
  ${
    params.splitBundledSetupSecrets
      ? `loadSetupSecrets: () => ({
    secretTargetRegistryEntries: [
      {
        id: ${JSON.stringify(`channels.${params.id}.setup-token`)},
        targetType: "channel",
      },
    ],
  }),`
      : ""
  }
  ${
    params.bundledSetupRuntimeError
      ? `setChannelRuntime: () => {
    throw new Error(${JSON.stringify(params.bundledSetupRuntimeError)});
  },`
      : params.bundledSetupRuntimeMarker
        ? `setChannelRuntime: () => {
    require("node:fs").writeFileSync(${JSON.stringify(params.bundledSetupRuntimeMarker)}, "loaded", "utf-8");
  },`
        : ""
  }
};`
      : `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: ${JSON.stringify(params.id)},
    meta: {
      id: ${JSON.stringify(params.id)},
      label: ${JSON.stringify(params.label)},
      selectionLabel: ${JSON.stringify(params.label)},
      docsPath: ${JSON.stringify(`/channels/${params.id}`)},
      blurb: ${JSON.stringify(params.setupBlurb)},
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ${listAccountIds},
      resolveAccount: () => ${resolveAccount},
    },
    outbound: { deliveryMode: "direct" },
  },
};`,
    "utf-8",
  );

  return { pluginDir, fullMarker, setupMarker };
}

function createEnvResolvedPluginFixture(pluginId: string) {
  useNoBundledPlugins();
  const openclawHome = makeTempDir();
  const ignoredHome = makeTempDir();
  const stateDir = makeTempDir();
  const pluginDir = path.join(openclawHome, "plugins", pluginId);
  mkdirSafe(pluginDir);
  const plugin = writePlugin({
    id: pluginId,
    dir: pluginDir,
    filename: "index.cjs",
    body: `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
  });
  const env = {
    ...process.env,
    OPENCLAW_HOME: openclawHome,
    HOME: ignoredHome,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  };
  return { plugin, env };
}

function expectEscapingEntryRejected(params: {
  id: string;
  linkKind: "symlink" | "hardlink";
  sourceBody: string;
}) {
  useNoBundledPlugins();
  const { outsideEntry, linkedEntry } = createEscapingEntryFixture({
    id: params.id,
    sourceBody: params.sourceBody,
  });
  try {
    if (params.linkKind === "symlink") {
      fs.symlinkSync(outsideEntry, linkedEntry);
    } else {
      fs.linkSync(outsideEntry, linkedEntry);
    }
  } catch (err) {
    if (params.linkKind === "hardlink" && (err as NodeJS.ErrnoException).code === "EXDEV") {
      return undefined;
    }
    if (params.linkKind === "symlink") {
      return undefined;
    }
    throw err;
  }

  const registry = loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        load: { paths: [linkedEntry] },
        allow: [params.id],
      },
    },
  });

  const record = registry.plugins.find((entry) => entry.id === params.id);
  expect(record?.status).not.toBe("loaded");
  expect(registry.diagnostics.some((entry) => entry.message.includes("escapes"))).toBe(true);
  return registry;
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
  cachedBundledTelegramDir = "";
  cachedBundledMemoryDir = "";
});

describe("loadOpenClawPlugins", () => {
  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "bundled",
      body: `module.exports = { id: "bundled", register() {} };`,
      dir: bundledDir,
      filename: "bundled.cjs",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
        },
      },
    });

    const bundled = registry.plugins.find((entry) => entry.id === "bundled");
    expect(bundled?.status).toBe("disabled");
  });

  it("repairs enabled bundled plugin runtime deps before importing the plugin", () => {
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      id: "discord",
      dir: path.join(bundledDir, "discord"),
      filename: "index.cjs",
      body: `const dep = require("discord-runtime/package.json");
module.exports = {
  id: "discord",
  register() {
    if (dep.name !== "discord-runtime") {
      throw new Error("missing runtime dep");
    }
  },
};`,
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    fs.writeFileSync(
      path.join(plugin.dir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/discord",
          version: "1.0.0",
          dependencies: {
            "discord-runtime": "1.0.0",
          },
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "discord",
          channels: ["discord"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    const installedSpecs: string[] = [];

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
        },
        channels: {
          discord: {
            enabled: true,
          },
        },
      },
      bundledRuntimeDepsInstaller: ({ installRoot, missingSpecs }) => {
        installedSpecs.push(...missingSpecs);
        expect(fs.realpathSync(installRoot)).toBe(fs.realpathSync(plugin.dir));
        fs.mkdirSync(path.join(installRoot, "node_modules", "discord-runtime"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(installRoot, "node_modules", "discord-runtime", "package.json"),
          JSON.stringify({ name: "discord-runtime", version: "1.0.0" }),
          "utf-8",
        );
      },
    });

    expect(installedSpecs).toEqual(["discord-runtime@1.0.0"]);
    expect(registry.plugins.find((entry) => entry.id === "discord")?.status).toBe("loaded");
  });

  it("does not repair disabled bundled plugin runtime deps", () => {
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      id: "discord",
      dir: path.join(bundledDir, "discord"),
      filename: "index.cjs",
      body: `module.exports = { id: "discord", register() {} };`,
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    fs.writeFileSync(
      path.join(plugin.dir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/discord",
          version: "1.0.0",
          dependencies: {
            "discord-runtime": "1.0.0",
          },
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
        },
      },
      bundledRuntimeDepsInstaller: () => {
        throw new Error("disabled plugin deps should not install");
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "discord")?.status).toBe("disabled");
  });

  it("repairs default-enabled bundled plugin runtime deps", () => {
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      id: "openai",
      dir: path.join(bundledDir, "openai"),
      filename: "index.cjs",
      body: `module.exports = { id: "openai", register() {} };`,
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    fs.writeFileSync(
      path.join(plugin.dir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/openai",
          version: "1.0.0",
          dependencies: {
            "openai-runtime": "1.0.0",
          },
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "openai",
          enabledByDefault: true,
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    const installedSpecs: string[] = [];

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
        },
      },
      bundledRuntimeDepsInstaller: ({ missingSpecs }) => {
        installedSpecs.push(...missingSpecs);
      },
    });

    expect(installedSpecs).toEqual(["openai-runtime@1.0.0"]);
    expect(registry.plugins.find((entry) => entry.id === "openai")?.status).toBe("loaded");
  });

  it("installs bundled runtime deps into each plugin root", () => {
    const bundledDir = makeTempDir();
    const alpha = writePlugin({
      id: "alpha",
      dir: path.join(bundledDir, "alpha"),
      filename: "index.cjs",
      body: `module.exports = { id: "alpha", register() {} };`,
    });
    const beta = writePlugin({
      id: "beta",
      dir: path.join(bundledDir, "beta"),
      filename: "index.cjs",
      body: `module.exports = { id: "beta", register() {} };`,
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    for (const [plugin, depName] of [
      [alpha, "alpha-runtime"],
      [beta, "beta-runtime"],
    ] as const) {
      fs.writeFileSync(
        path.join(plugin.dir, "package.json"),
        JSON.stringify(
          {
            name: `@openclaw/${plugin.id}`,
            version: "1.0.0",
            dependencies: {
              [depName]: "1.0.0",
            },
            openclaw: { extensions: ["./index.cjs"] },
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify(
          {
            id: plugin.id,
            enabledByDefault: true,
            configSchema: EMPTY_PLUGIN_SCHEMA,
          },
          null,
          2,
        ),
        "utf-8",
      );
    }
    const calls: Array<{ missingSpecs: string[]; installSpecs: string[] | undefined }> = [];

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
        },
      },
      bundledRuntimeDepsInstaller: ({ installRoot, missingSpecs, installSpecs }) => {
        calls.push({ missingSpecs, installSpecs });
        for (const spec of installSpecs ?? missingSpecs) {
          const name = spec.split("@")[0] || spec;
          fs.mkdirSync(path.join(installRoot, "node_modules", name), { recursive: true });
          fs.writeFileSync(
            path.join(installRoot, "node_modules", name, "package.json"),
            JSON.stringify({ name, version: "1.0.0" }),
            "utf-8",
          );
        }
      },
    });

    expect(registry.plugins.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
    expect(calls).toEqual([
      {
        missingSpecs: ["alpha-runtime@1.0.0"],
        installSpecs: ["alpha-runtime@1.0.0"],
      },
      {
        missingSpecs: ["beta-runtime@1.0.0"],
        installSpecs: ["beta-runtime@1.0.0"],
      },
    ]);
  });

  it("registers standalone text transforms", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "text-shim",
      filename: "text-shim.cjs",
      body: `module.exports = {
        id: "text-shim",
        register(api) {
          api.registerTextTransforms({
            input: [{ from: /red basket/g, to: "blue basket" }],
            output: [{ from: /blue basket/g, to: "red basket" }],
          });
        },
      };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: { allow: ["text-shim"] },
    });

    expect(registry.textTransforms).toHaveLength(1);
    expect(registry.textTransforms[0]).toMatchObject({
      pluginId: "text-shim",
      transforms: {
        input: expect.any(Array),
        output: expect.any(Array),
      },
    });
  });

  it.each([
    {
      name: "loads bundled telegram plugin when enabled",
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        expectTelegramLoaded(registry);
      },
    },
    {
      name: "loads bundled channel plugins when channels.<id>.enabled=true",
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          enabled: true,
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        expectTelegramLoaded(registry);
      },
    },
    {
      name: "lets explicit bundled channel enablement bypass restrictive allowlists",
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          allow: ["browser"],
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        const telegram = registry.plugins.find((entry) => entry.id === "telegram");
        expect(telegram?.status).toBe("loaded");
        expect(telegram?.error).toBeUndefined();
        expect(telegram?.explicitlyEnabled).toBe(true);
      },
    },
    {
      name: "still respects explicit disable via plugins.entries for bundled channels",
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            telegram: { enabled: false },
          },
        },
      } satisfies PluginLoadConfig,
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        const telegram = registry.plugins.find((entry) => entry.id === "telegram");
        expect(telegram?.status).toBe("disabled");
        expect(telegram?.error).toBe("disabled in config");
      },
    },
  ] as const)(
    "handles bundled telegram plugin enablement and override rules: $name",
    ({ config, assert }) => {
      setupBundledTelegramPlugin();
      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: cachedBundledTelegramDir,
        config,
      });
      assert(registry);
    },
  );

  it("marks auto-enabled bundled channels as activated but not explicitly enabled", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        enabled: true,
      },
    } satisfies PluginLoadConfig;
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env: {},
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
    });

    expect(registry.plugins.find((entry) => entry.id === "telegram")).toMatchObject({
      explicitlyEnabled: false,
      activated: true,
      activationSource: "auto",
      activationReason: "telegram configured",
    });
  });

  it("materializes auto-enabled bundled channels into restrictive allowlists", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        allow: ["browser"],
      },
    } satisfies PluginLoadConfig;
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env: {},
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(autoEnabled.config.plugins?.allow).toEqual(["browser", "telegram"]);
    expect(telegram?.status).toBe("loaded");
    expect(telegram?.error).toBeUndefined();
    expect(telegram).toMatchObject({
      explicitlyEnabled: false,
      activated: true,
      activationSource: "auto",
      activationReason: "telegram configured",
    });
  });

  it("preserves all auto-enable reasons in activation metadata", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        enabled: true,
      },
    } satisfies PluginLoadConfig;

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: {
        ...rawConfig,
        plugins: {
          enabled: true,
          entries: {
            telegram: {
              enabled: true,
            },
          },
        },
      },
      activationSourceConfig: rawConfig,
      autoEnabledReasons: {
        telegram: ["telegram configured", "telegram selected for startup"],
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "telegram")).toMatchObject({
      explicitlyEnabled: false,
      activated: true,
      activationSource: "auto",
      activationReason: "telegram configured; telegram selected for startup",
    });
  });

  it("keeps explicit plugin enablement distinct from derived activation", () => {
    const { bundledDir } = writeBundledPlugin({
      id: "demo",
    });
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: true,
          },
        },
      },
    } satisfies PluginLoadConfig;

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: bundledDir,
      config,
      activationSourceConfig: config,
    });

    expect(registry.plugins.find((entry) => entry.id === "demo")).toMatchObject({
      explicitlyEnabled: true,
      activated: true,
      activationSource: "explicit",
      activationReason: "enabled in config",
    });
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const registry = loadBundledMemoryPluginRegistry({
      packageMeta: {
        name: "@openclaw/memory-core",
        version: "1.2.3",
        description: "Memory plugin package",
      },
      pluginBody:
        'module.exports = { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };',
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
    expect(memory?.origin).toBe("bundled");
    expect(memory?.name).toBe("Memory (Core)");
    expect(memory?.version).toBe("1.2.3");
  });
  it.each([
    {
      label: "loads plugins from config paths",
      run: () => {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
        const plugin = writePlugin({
          id: "allowed-config-path",
          filename: "allowed-config-path.cjs",
          body: `module.exports = {
  id: "allowed-config-path",
  register(api) {
    api.registerGatewayMethod("allowed-config-path.ping", ({ respond }) => respond(true, { ok: true }));
  },
};`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["allowed-config-path"],
            },
          },
        });

        const loaded = registry.plugins.find((entry) => entry.id === "allowed-config-path");
        expect(loaded?.status).toBe("loaded");
        expect(Object.keys(registry.gatewayHandlers)).toContain("allowed-config-path.ping");
      },
    },
    {
      label: "coerces reserved gateway method namespaces to operator.admin",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "reserved-gateway-scope",
          filename: "reserved-gateway-scope.cjs",
          body: `module.exports = {
  id: "reserved-gateway-scope",
  register(api) {
    api.registerGatewayMethod(
      ${JSON.stringify(RESERVED_ADMIN_PLUGIN_METHOD)},
      ({ respond }) => respond(true, { ok: true }),
      { scope: "operator.read" },
    );
  },
};`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["reserved-gateway-scope"],
            },
          },
        });

        expect(Object.keys(registry.gatewayHandlers)).toContain(RESERVED_ADMIN_PLUGIN_METHOD);
        expect(registry.gatewayMethodScopes?.[RESERVED_ADMIN_PLUGIN_METHOD]).toBe("operator.admin");
        expect(
          registry.diagnostics.some((diag) =>
            diag.message.includes(
              `${RESERVED_ADMIN_SCOPE_WARNING}: ${RESERVED_ADMIN_PLUGIN_METHOD}`,
            ),
          ),
        ).toBe(true);
      },
    },
    {
      label: "rejects async register functions instead of silently loading them",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "async-register",
          filename: "async-register.cjs",
          body: `module.exports = {
  id: "async-register",
  async register(api) {
    await Promise.resolve();
    api.registerGatewayMethod("async-register.ping", ({ respond }) => respond(true, { ok: true }));
  },
};`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["async-register"],
            },
          },
        });

        const loaded = registry.plugins.find((entry) => entry.id === "async-register");
        expect(loaded?.status).toBe("error");
        expect(loaded?.failurePhase).toBe("register");
        expect(loaded?.error).toContain("plugin register must be synchronous");
        expect(Object.keys(registry.gatewayHandlers)).not.toContain("async-register.ping");
      },
    },
    {
      label: "limits imports to the requested plugin ids",
      run: () => {
        useNoBundledPlugins();
        const allowed = writePlugin({
          id: "allowed-scoped-only",
          filename: "allowed-scoped-only.cjs",
          body: `module.exports = { id: "allowed-scoped-only", register() {} };`,
        });
        const skippedMarker = path.join(makeTempDir(), "skipped-loaded.txt");
        const skipped = writePlugin({
          id: "skipped-scoped-only",
          filename: "skipped-scoped-only.cjs",
          body: `require("node:fs").writeFileSync(${JSON.stringify(skippedMarker)}, "loaded", "utf-8");
module.exports = { id: "skipped-scoped-only", register() { throw new Error("skipped plugin should not load"); } };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [allowed.file, skipped.file] },
              allow: ["allowed-scoped-only", "skipped-scoped-only"],
            },
          },
          onlyPluginIds: ["allowed-scoped-only"],
        });

        expect(registry.plugins.map((entry) => entry.id)).toEqual(["allowed-scoped-only"]);
        expect(fs.existsSync(skippedMarker)).toBe(false);
      },
    },
    {
      label: "can build a manifest-only snapshot without importing plugin modules",
      run: () => {
        useNoBundledPlugins();
        const importedMarker = path.join(makeTempDir(), "manifest-only-imported.txt");
        const plugin = writePlugin({
          id: "manifest-only-plugin",
          filename: "manifest-only-plugin.cjs",
          body: `require("node:fs").writeFileSync(${JSON.stringify(importedMarker)}, "loaded", "utf-8");
module.exports = { id: "manifest-only-plugin", register() { throw new Error("manifest-only snapshot should not register"); } };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          activate: false,
          loadModules: false,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["manifest-only-plugin"],
              entries: {
                "manifest-only-plugin": { enabled: true },
              },
            },
          },
        });

        expect(fs.existsSync(importedMarker)).toBe(false);
        expect(registry.plugins).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "manifest-only-plugin",
              status: "loaded",
            }),
          ]),
        );
      },
    },
    {
      label: "marks a selected memory slot as matched during manifest-only snapshots",
      run: () => {
        useNoBundledPlugins();
        const memoryPlugin = writePlugin({
          id: "memory-demo",
          filename: "memory-demo.cjs",
          body: `module.exports = {
  id: "memory-demo",
  kind: "memory",
  register() {},
};`,
        });
        fs.writeFileSync(
          path.join(memoryPlugin.dir, "openclaw.plugin.json"),
          JSON.stringify(
            {
              id: "memory-demo",
              kind: "memory",
              configSchema: EMPTY_PLUGIN_SCHEMA,
            },
            null,
            2,
          ),
          "utf-8",
        );

        const registry = loadOpenClawPlugins({
          cache: false,
          activate: false,
          loadModules: false,
          config: {
            plugins: {
              load: { paths: [memoryPlugin.file] },
              allow: ["memory-demo"],
              slots: { memory: "memory-demo" },
              entries: {
                "memory-demo": { enabled: true },
              },
            },
          },
        });

        expect(
          registry.diagnostics.some(
            (entry) =>
              entry.message === "memory slot plugin not found or not marked as memory: memory-demo",
          ),
        ).toBe(false);
        expect(registry.plugins).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "memory-demo",
              memorySlotSelected: true,
            }),
          ]),
        );
      },
    },
    {
      label: "tracks plugins as imported when module evaluation throws after top-level execution",
      run: () => {
        useNoBundledPlugins();
        const importMarker = "__openclaw_loader_import_throw_marker";
        Reflect.deleteProperty(globalThis, importMarker);

        const plugin = writePlugin({
          id: "throws-after-import",
          filename: "throws-after-import.cjs",
          body: `globalThis.${importMarker} = (globalThis.${importMarker} ?? 0) + 1;
throw new Error("boom after import");
module.exports = { id: "throws-after-import", register() {} };`,
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          activate: false,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["throws-after-import"],
            },
          },
        });

        try {
          expect(registry.plugins).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "throws-after-import",
                status: "error",
              }),
            ]),
          );
          expect(listImportedRuntimePluginIds()).toContain("throws-after-import");
          expect(Number(Reflect.get(globalThis, importMarker) ?? 0)).toBeGreaterThan(0);
        } finally {
          Reflect.deleteProperty(globalThis, importMarker);
        }
      },
    },
    {
      label: "fails loudly when a plugin reenters the same snapshot load during register",
      run: () => {
        useNoBundledPlugins();
        const marker = "__openclaw_loader_reentry_error";
        const reenterFnMarker = "__openclaw_loader_reentry_fn";
        Reflect.deleteProperty(globalThis, marker);
        Reflect.set(
          globalThis,
          reenterFnMarker,
          (options: Parameters<typeof loadOpenClawPlugins>[0]) => loadOpenClawPlugins(options),
        );
        const pluginDir = makeTempDir();
        const pluginFile = path.join(pluginDir, "reentrant-snapshot.cjs");
        const nestedOptions = {
          cache: false,
          activate: false,
          workspaceDir: pluginDir,
          config: {
            plugins: {
              load: { paths: [pluginFile] },
              allow: ["reentrant-snapshot"],
            },
          },
        } satisfies Parameters<typeof loadOpenClawPlugins>[0];
        writePlugin({
          id: "reentrant-snapshot",
          dir: pluginDir,
          filename: "reentrant-snapshot.cjs",
          body: `module.exports = {
  id: "reentrant-snapshot",
  register() {
    try {
      globalThis.${reenterFnMarker}(${JSON.stringify(nestedOptions)});
    } catch (error) {
      globalThis.${marker} = {
        name: error?.name,
        message: String(error?.message ?? error),
      };
      throw error;
    }
  },
};`,
        });

        const registry = loadOpenClawPlugins(nestedOptions);

        try {
          expect(Reflect.get(globalThis, marker)).toMatchObject({
            name: PluginLoadReentryError.name,
            message: expect.stringContaining("plugin load reentry detected"),
          });
          expect(registry.plugins.find((entry) => entry.id === "reentrant-snapshot")).toMatchObject(
            {
              status: "error",
              error: expect.stringContaining("plugin load reentry detected"),
              failurePhase: "register",
            },
          );
        } finally {
          Reflect.deleteProperty(globalThis, marker);
          Reflect.deleteProperty(globalThis, reenterFnMarker);
        }
      },
    },
    {
      label: "lets resolveRuntimePluginRegistry short-circuit during same snapshot load",
      run: () => {
        useNoBundledPlugins();
        const marker = "__openclaw_runtime_registry_reentry_marker";
        const resolverMarker = "__openclaw_runtime_registry_reentry_fn";
        Reflect.deleteProperty(globalThis, marker);
        Reflect.set(
          globalThis,
          resolverMarker,
          (options: Parameters<typeof resolveRuntimePluginRegistry>[0]) =>
            resolveRuntimePluginRegistry(options),
        );
        const pluginDir = makeTempDir();
        const pluginFile = path.join(pluginDir, "runtime-registry-reentry.cjs");
        const nestedOptions = {
          cache: false,
          activate: false,
          workspaceDir: pluginDir,
          config: {
            plugins: {
              load: { paths: [pluginFile] },
              allow: ["runtime-registry-reentry"],
            },
          },
        } satisfies Parameters<typeof loadOpenClawPlugins>[0];
        writePlugin({
          id: "runtime-registry-reentry",
          dir: pluginDir,
          filename: "runtime-registry-reentry.cjs",
          body: `module.exports = {
  id: "runtime-registry-reentry",
  register() {
    const registry = globalThis.${resolverMarker}(${JSON.stringify(nestedOptions)});
    globalThis.${marker} = registry === undefined ? "undefined" : "loaded";
  },
};`,
        });

        const registry = loadOpenClawPlugins(nestedOptions);

        try {
          expect(Reflect.get(globalThis, marker)).toBe("undefined");
          expect(
            registry.plugins.find((entry) => entry.id === "runtime-registry-reentry"),
          ).toMatchObject({
            status: "loaded",
          });
        } finally {
          Reflect.deleteProperty(globalThis, marker);
          Reflect.deleteProperty(globalThis, resolverMarker);
        }
      },
    },
    {
      label: "keeps scoped plugin loads in a separate cache entry",
      run: () => {
        useNoBundledPlugins();
        const allowed = writePlugin({
          id: "allowed-cache-scope",
          filename: "allowed-cache-scope.cjs",
          body: `module.exports = { id: "allowed-cache-scope", register() {} };`,
        });
        const extra = writePlugin({
          id: "extra-cache-scope",
          filename: "extra-cache-scope.cjs",
          body: `module.exports = { id: "extra-cache-scope", register() {} };`,
        });
        const options = {
          config: {
            plugins: {
              load: { paths: [allowed.file, extra.file] },
              allow: ["allowed-cache-scope", "extra-cache-scope"],
            },
          },
        };

        const full = loadOpenClawPlugins(options);
        const scoped = loadOpenClawPlugins({
          ...options,
          onlyPluginIds: ["allowed-cache-scope"],
        });
        const scopedAgain = loadOpenClawPlugins({
          ...options,
          onlyPluginIds: ["allowed-cache-scope"],
        });

        expect(full.plugins.map((entry) => entry.id).toSorted()).toEqual([
          "allowed-cache-scope",
          "extra-cache-scope",
        ]);
        expect(scoped).not.toBe(full);
        expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-cache-scope"]);
        expect(scopedAgain).toBe(scoped);
      },
    },
    {
      label: "can load a scoped registry without replacing the active global registry",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "allowed-nonactivating-scope",
          filename: "allowed-nonactivating-scope.cjs",
          body: `module.exports = { id: "allowed-nonactivating-scope", register() {} };`,
        });
        const previousRegistry = createEmptyPluginRegistry();
        setActivePluginRegistry(previousRegistry, "existing-registry");
        resetGlobalHookRunner();

        const scoped = loadOpenClawPlugins({
          cache: false,
          activate: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["allowed-nonactivating-scope"],
            },
          },
          onlyPluginIds: ["allowed-nonactivating-scope"],
        });

        expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-nonactivating-scope"]);
        expect(getActivePluginRegistry()).toBe(previousRegistry);
        expect(getActivePluginRegistryKey()).toBe("existing-registry");
        expect(getGlobalHookRunner()).toBeNull();
      },
    },
  ] as const)("handles config-path and scoped plugin loads: $label", ({ run }) => {
    run();
  });

  it("treats an explicit empty plugin scope as scoped-empty instead of unscoped", () => {
    useNoBundledPlugins();
    const allowed = writePlugin({
      id: "allowed-empty-scope",
      filename: "allowed-empty-scope.cjs",
      body: `module.exports = { id: "allowed-empty-scope", register() {} };`,
    });
    const extra = writePlugin({
      id: "extra-empty-scope",
      filename: "extra-empty-scope.cjs",
      body: `module.exports = { id: "extra-empty-scope", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      activate: false,
      config: {
        plugins: {
          load: { paths: [allowed.file, extra.file] },
          allow: ["allowed-empty-scope", "extra-empty-scope"],
        },
      },
      onlyPluginIds: [],
    });

    expect(registry.plugins).toEqual([]);
  });

  it("only publishes plugin commands to the global registry during activating loads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "command-plugin",
      filename: "command-plugin.cjs",
      body: `module.exports = {
        id: "command-plugin",
        register(api) {
          api.registerCommand({
            name: "pair",
            description: "Pair device",
            acceptsArgs: true,
            handler: async ({ args }) => ({ text: \`paired:\${args ?? ""}\` }),
          });
        },
      };`,
    });
    clearPluginCommands();

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["command-plugin"],
        },
      },
      onlyPluginIds: ["command-plugin"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(scoped.commands.map((entry) => entry.command.name)).toEqual(["pair"]);
    expect(getPluginCommandSpecs("telegram")).toEqual([]);

    const active = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["command-plugin"],
        },
      },
      onlyPluginIds: ["command-plugin"],
    });

    expect(active.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
      },
    ]);

    clearPluginCommands();
  });

  it("clears plugin agent harnesses during activating reloads", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "codex-harness",
      filename: "codex-harness.cjs",
      body: `module.exports = {
        id: "codex-harness",
        register(api) {
          api.registerAgentHarness({
            id: "codex",
            label: "Codex",
            supports: () => ({ supported: true }),
            runAttempt: async () => ({ ok: false, error: "unused" }),
          });
        },
      };`,
    });

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["codex-harness"],
        },
      },
      onlyPluginIds: ["codex-harness"],
    });
    expect(listAgentHarnessIds()).toEqual(["codex"]);

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: makeTempDir(),
      config: {
        plugins: {
          allow: [],
        },
      },
    });
    expect(listAgentHarnessIds()).toEqual([]);
  });

  it("does not register internal hooks globally during non-activating loads", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "internal-hook-snapshot",
      filename: "internal-hook-snapshot.cjs",
      body: `module.exports = {
        id: "internal-hook-snapshot",
        register(api) {
          api.registerHook("gateway:startup", () => {}, { name: "snapshot-hook" });
        },
      };`,
    });

    clearInternalHooks();
    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["internal-hook-snapshot"],
        },
      },
      onlyPluginIds: ["internal-hook-snapshot"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "internal-hook-snapshot")?.status).toBe(
      "loaded",
    );
    expect(scoped.hooks.map((entry) => entry.entry.hook.name)).toEqual(["snapshot-hook"]);
    expect(getRegisteredEventKeys()).toEqual([]);

    clearInternalHooks();
  });

  it("replaces prior plugin hook registrations on activating reloads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "internal-hook-reload",
      filename: "internal-hook-reload.cjs",
      body: `module.exports = {
        id: "internal-hook-reload",
        register(api) {
          api.registerHook(
            "gateway:startup",
            (event) => {
              event.messages.push("reload-hook-fired");
            },
            { name: "reload-hook" },
          );
        },
      };`,
    });

    clearInternalHooks();

    const loadOptions = {
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["internal-hook-reload"],
        },
      },
      onlyPluginIds: ["internal-hook-reload"],
    };

    loadOpenClawPlugins(loadOptions);
    loadOpenClawPlugins(loadOptions);

    const event = createInternalHookEvent("gateway", "startup", "gateway:startup");
    await triggerInternalHook(event);
    expect(event.messages.filter((message) => message === "reload-hook-fired")).toHaveLength(1);

    clearInternalHooks();
  });

  it("rolls back global side effects when registration fails", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-side-effects",
      filename: "failing-side-effects.cjs",
      body: `module.exports = {
        id: "failing-side-effects",
        register(api) {
          api.registerHook(
            "gateway:startup",
            (event) => {
              event.messages.push("should-not-run");
            },
            { name: "failing-side-effects-hook" },
          );
          api.registerCommand({
            name: "failme",
            description: "Fail me",
            handler: async () => ({ text: "nope" }),
          });
          api.registerReload({
            onConfigReload: async () => {},
          });
          api.registerNodeHostCommand({
            command: "failme",
            description: "failme",
            run: async () => ({ ok: true }),
          });
          api.registerSecurityAuditCollector({
            id: "failme",
            collect: async () => [],
          });
          api.registerInteractiveHandler({
            channel: "slack",
            namespace: "failme",
            handle: async () => ({ handled: true }),
          });
          api.registerContextEngine("failme-context", () => ({
            info: { id: "failme-context", name: "Failme Context" },
            ingest: async () => {},
            assemble: async () => ({ messages: [] }),
          }));
          throw new Error("boom");
        },
      };`,
    });

    clearInternalHooks();
    clearPluginCommands();
    clearPluginInteractiveHandlers();

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-side-effects"],
        },
      },
      onlyPluginIds: ["failing-side-effects"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-side-effects")?.status).toBe(
      "error",
    );
    expect(getRegisteredEventKeys()).toEqual([]);
    expect(getPluginCommandSpecs()).toEqual([]);
    expect(registry.reloads).toEqual([]);
    expect(registry.nodeHostCommands).toEqual([]);
    expect(registry.securityAuditCollectors).toEqual([]);
    expect(resolvePluginInteractiveNamespaceMatch("slack", "failme:payload")).toBeNull();
    expect(getContextEngineFactory("failme-context")).toBeUndefined();
    expect(listContextEngineIds()).not.toContain("failme-context");

    const event = createInternalHookEvent("gateway", "startup", "gateway:startup");
    await triggerInternalHook(event);
    expect(event.messages).toEqual([]);

    clearInternalHooks();
    clearPluginCommands();
    clearPluginInteractiveHandlers();
  });

  it("can scope bundled provider loads to deepseek without hanging", () => {
    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      pluginSdkResolution: "dist",
      config: {
        plugins: {
          enabled: true,
          allow: ["deepseek"],
        },
      },
      onlyPluginIds: ["deepseek"],
    });

    expect(scoped.plugins.map((entry) => entry.id)).toEqual(["deepseek"]);
    expect(scoped.plugins[0]?.status).toBe("loaded");
    expect(scoped.providers.map((entry) => entry.provider.id)).toEqual(["deepseek"]);
  });

  it("does not replace active memory plugin registries during non-activating loads", () => {
    useNoBundledPlugins();
    registerMemoryEmbeddingProvider({
      id: "active",
      create: async () => ({ provider: null }),
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => null,
    });
    registerMemoryPromptSection(() => ["active memory section"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["active wiki supplement"]);
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "active",
      systemPrompt: "active",
      relativePath: "memory/active.md",
    }));
    const activeRuntime = {
      async getMemorySearchManager() {
        return { manager: null, error: "active" };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    };
    registerMemoryRuntime(activeRuntime);
    const plugin = writePlugin({
      id: "snapshot-memory",
      filename: "snapshot-memory.cjs",
      body: `module.exports = {
        id: "snapshot-memory",
        kind: "memory",
        register(api) {
          api.registerMemoryEmbeddingProvider({
            id: "snapshot",
            create: async () => ({ provider: null }),
          });
          api.registerMemoryPromptSection(() => ["snapshot memory section"]);
          api.registerMemoryFlushPlan(() => ({
            softThresholdTokens: 10,
            forceFlushTranscriptBytes: 20,
            reserveTokensFloor: 30,
            prompt: "snapshot",
            systemPrompt: "snapshot",
            relativePath: "memory/snapshot.md",
          }));
          api.registerMemoryRuntime({
            async getMemorySearchManager() {
              return { manager: null, error: "snapshot" };
            },
            resolveMemoryBackendConfig() {
              return { backend: "qmd", qmd: {} };
            },
          });
        },
      };`,
    });

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-memory"],
          slots: { memory: "snapshot-memory" },
        },
      },
      onlyPluginIds: ["snapshot-memory"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-memory")?.status).toBe("loaded");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "active memory section",
      "active wiki supplement",
    ]);
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/active.md");
    expect(getMemoryRuntime()).toBe(activeRuntime);
    expect(listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual(["active"]);
  });

  it("clears newly-registered memory plugin registries when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-memory",
      filename: "failing-memory.cjs",
      body: `module.exports = {
        id: "failing-memory",
        kind: "memory",
        register(api) {
          api.registerMemoryEmbeddingProvider({
            id: "failed",
            create: async () => ({ provider: null }),
          });
          api.registerMemoryPromptSection(() => ["stale failure section"]);
          api.registerMemoryPromptSupplement(() => ["stale failure supplement"]);
          api.registerMemoryCorpusSupplement({
            search: async () => [],
            get: async () => null,
          });
          api.registerMemoryFlushPlan(() => ({
            softThresholdTokens: 10,
            forceFlushTranscriptBytes: 20,
            reserveTokensFloor: 30,
            prompt: "failed",
            systemPrompt: "failed",
            relativePath: "memory/failed.md",
          }));
          api.registerMemoryRuntime({
            async getMemorySearchManager() {
              return { manager: null, error: "failed" };
            },
            resolveMemoryBackendConfig() {
              return { backend: "builtin" };
            },
          });
          throw new Error("memory register failed");
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-memory"],
          slots: { memory: "failing-memory" },
        },
      },
      onlyPluginIds: ["failing-memory"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-memory")?.status).toBe("error");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(listMemoryCorpusSupplements()).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
    expect(listMemoryEmbeddingProviders()).toEqual([]);
  });

  it("does not replace the active detached task runtime during non-activating loads", () => {
    useNoBundledPlugins();
    const activeRuntime = createDetachedTaskRuntimeStub("active");
    registerDetachedTaskLifecycleRuntime("active-runtime", activeRuntime);

    const plugin = writePlugin({
      id: "snapshot-detached-runtime",
      filename: "snapshot-detached-runtime.cjs",
      body: `module.exports = {
        id: "snapshot-detached-runtime",
        register(api) {
          api.registerDetachedTaskRuntime({
            createQueuedTaskRun() { throw new Error("snapshot createQueuedTaskRun should not run"); },
            createRunningTaskRun() { throw new Error("snapshot createRunningTaskRun should not run"); },
            startTaskRunByRunId() { throw new Error("snapshot startTaskRunByRunId should not run"); },
            recordTaskRunProgressByRunId() { throw new Error("snapshot recordTaskRunProgressByRunId should not run"); },
            completeTaskRunByRunId() { throw new Error("snapshot completeTaskRunByRunId should not run"); },
            failTaskRunByRunId() { throw new Error("snapshot failTaskRunByRunId should not run"); },
            setDetachedTaskDeliveryStatusByRunId() { throw new Error("snapshot setDetachedTaskDeliveryStatusByRunId should not run"); },
            async cancelDetachedTaskRunById() { return { found: true, cancelled: true }; },
          });
        },
      };`,
    });

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-detached-runtime"],
        },
      },
      onlyPluginIds: ["snapshot-detached-runtime"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-detached-runtime")?.status).toBe(
      "loaded",
    );
    expect(getDetachedTaskLifecycleRuntimeRegistration()).toMatchObject({
      pluginId: "active-runtime",
      runtime: activeRuntime,
    });
  });

  it("clears newly-registered detached task runtimes when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-detached-runtime",
      filename: "failing-detached-runtime.cjs",
      body: `module.exports = {
        id: "failing-detached-runtime",
        register(api) {
          api.registerDetachedTaskRuntime({
            createQueuedTaskRun() { throw new Error("failing createQueuedTaskRun should not run"); },
            createRunningTaskRun() { throw new Error("failing createRunningTaskRun should not run"); },
            startTaskRunByRunId() { throw new Error("failing startTaskRunByRunId should not run"); },
            recordTaskRunProgressByRunId() { throw new Error("failing recordTaskRunProgressByRunId should not run"); },
            completeTaskRunByRunId() { throw new Error("failing completeTaskRunByRunId should not run"); },
            failTaskRunByRunId() { throw new Error("failing failTaskRunByRunId should not run"); },
            setDetachedTaskDeliveryStatusByRunId() { throw new Error("failing setDetachedTaskDeliveryStatusByRunId should not run"); },
            async cancelDetachedTaskRunById() { return { found: true, cancelled: true }; },
          });
          throw new Error("detached runtime register failed");
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-detached-runtime"],
        },
      },
      onlyPluginIds: ["failing-detached-runtime"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-detached-runtime")?.status).toBe(
      "error",
    );
    expect(getDetachedTaskLifecycleRuntimeRegistration()).toBeUndefined();
  });

  it("restores cached detached task runtime registrations on cache hits", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cached-detached-runtime",
      filename: "cached-detached-runtime.cjs",
      body: `module.exports = {
        id: "cached-detached-runtime",
        register(api) {
          api.registerDetachedTaskRuntime({
            createQueuedTaskRun() { throw new Error("cached createQueuedTaskRun should not run"); },
            createRunningTaskRun() { throw new Error("cached createRunningTaskRun should not run"); },
            startTaskRunByRunId() { throw new Error("cached startTaskRunByRunId should not run"); },
            recordTaskRunProgressByRunId() { throw new Error("cached recordTaskRunProgressByRunId should not run"); },
            completeTaskRunByRunId() { throw new Error("cached completeTaskRunByRunId should not run"); },
            failTaskRunByRunId() { throw new Error("cached failTaskRunByRunId should not run"); },
            setDetachedTaskDeliveryStatusByRunId() { throw new Error("cached setDetachedTaskDeliveryStatusByRunId should not run"); },
            async cancelDetachedTaskRunById() { return { found: true, cancelled: true }; },
          });
        },
      };`,
    });

    const loadOptions = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cached-detached-runtime"],
        },
      },
      onlyPluginIds: ["cached-detached-runtime"],
    } satisfies Parameters<typeof loadOpenClawPlugins>[0];

    loadOpenClawPlugins(loadOptions);
    expect(getDetachedTaskLifecycleRuntimeRegistration()?.pluginId).toBe("cached-detached-runtime");

    clearDetachedTaskLifecycleRuntimeRegistration();
    expect(getDetachedTaskLifecycleRuntimeRegistration()).toBeUndefined();

    loadOpenClawPlugins(loadOptions);

    expect(getDetachedTaskLifecycleRuntimeRegistration()?.pluginId).toBe("cached-detached-runtime");
  });

  it("clears stale detached task runtime registrations on active reloads when no plugin re-registers one", () => {
    useNoBundledPlugins();
    registerDetachedTaskLifecycleRuntime("stale-runtime", createDetachedTaskRuntimeStub("stale"));

    loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [] },
          allow: [],
        },
      },
    });

    expect(getDetachedTaskLifecycleRuntimeRegistration()).toBeUndefined();
  });

  it("restores cached memory capability public artifacts on cache hits", async () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const absolutePath = path.join(workspaceDir, "MEMORY.md");
    fs.writeFileSync(absolutePath, "# Memory\n");
    const plugin = writePlugin({
      id: "cached-memory-capability",
      filename: "cached-memory-capability.cjs",
      body: `module.exports = {
        id: "cached-memory-capability",
        kind: "memory",
        register(api) {
          api.registerMemoryCapability({
            publicArtifacts: {
              async listArtifacts() {
                return [{
                  kind: "memory-root",
                  workspaceDir: ${JSON.stringify(workspaceDir)},
                  relativePath: "MEMORY.md",
                  absolutePath: ${JSON.stringify(absolutePath)},
                  agentIds: ["main"],
                  contentType: "markdown",
                }];
              },
            },
          });
        },
      };`,
    });

    const options = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cached-memory-capability"],
          slots: { memory: "cached-memory-capability" },
        },
      },
      onlyPluginIds: ["cached-memory-capability"],
    };

    const expectedArtifacts = [
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath,
        agentIds: ["main"],
        contentType: "markdown" as const,
      },
    ];

    const first = loadOpenClawPlugins(options);
    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );

    clearMemoryPluginState();

    const second = loadOpenClawPlugins(options);
    expect(second).toBe(first);
    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );
  });

  it("preserves previously registered memory capability across activate:false snapshot loads", async () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const absolutePath = path.join(workspaceDir, "MEMORY.md");
    fs.writeFileSync(absolutePath, "# Memory\n");
    const memoryPlugin = writePlugin({
      id: "capability-survives-memory",
      filename: "capability-survives-memory.cjs",
      body: `module.exports = {
        id: "capability-survives-memory",
        kind: "memory",
        register(api) {
          api.registerMemoryCapability({
            publicArtifacts: {
              async listArtifacts() {
                return [{
                  kind: "memory-root",
                  workspaceDir: ${JSON.stringify(workspaceDir)},
                  relativePath: "MEMORY.md",
                  absolutePath: ${JSON.stringify(absolutePath)},
                  agentIds: ["main"],
                  contentType: "markdown",
                }];
              },
            },
          });
        },
      };`,
    });
    const sidecarPlugin = writePlugin({
      id: "capability-survives-sidecar",
      filename: "capability-survives-sidecar.cjs",
      body: `module.exports = {
        id: "capability-survives-sidecar",
        register() {},
      };`,
    });

    const activateConfig = {
      plugins: {
        load: { paths: [memoryPlugin.file, sidecarPlugin.file] },
        allow: ["capability-survives-memory", "capability-survives-sidecar"],
        slots: { memory: "capability-survives-memory" },
      },
    };
    loadOpenClawPlugins({
      cache: false,
      workspaceDir: memoryPlugin.dir,
      config: activateConfig,
    });

    const expectedArtifacts = [
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath,
        agentIds: ["main"],
        contentType: "markdown" as const,
      },
    ];

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );

    // Simulate what resolvePluginWebSearchProviders and similar read-only paths do:
    // load plugins again with activate:false. Each per-plugin snapshot/rollback must
    // preserve the previously registered memory capability.
    loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: memoryPlugin.dir,
      config: activateConfig,
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual(
      expectedArtifacts,
    );
  });

  it("throws when activate:false is used without cache:false", () => {
    expect(() => loadOpenClawPlugins({ activate: false })).toThrow(
      "activate:false requires cache:false",
    );
    expect(() => loadOpenClawPlugins({ activate: false, cache: true })).toThrow(
      "activate:false requires cache:false",
    );
  });

  it("re-initializes global hook runner when serving registry from cache", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "cache-hook-runner",
      filename: "cache-hook-runner.cjs",
      body: `module.exports = { id: "cache-hook-runner", register() {} };`,
    });

    const options = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cache-hook-runner"],
        },
      },
    };

    const first = loadOpenClawPlugins(options);
    expect(getGlobalHookRunner()).not.toBeNull();

    resetGlobalHookRunner();
    expect(getGlobalHookRunner()).toBeNull();

    const second = loadOpenClawPlugins(options);
    expect(second).toBe(first);
    expect(getGlobalHookRunner()).not.toBeNull();

    resetGlobalHookRunner();
  });

  it.each([
    {
      name: "does not reuse cached bundled plugin registries across env changes",
      pluginId: "cache-root",
      setup: () => {
        const bundledA = makeTempDir();
        const bundledB = makeTempDir();
        const pluginA = writePlugin({
          id: "cache-root",
          dir: path.join(bundledA, "cache-root"),
          filename: "index.cjs",
          body: `module.exports = { id: "cache-root", register() {} };`,
        });
        const pluginB = writePlugin({
          id: "cache-root",
          dir: path.join(bundledB, "cache-root"),
          filename: "index.cjs",
          body: `module.exports = { id: "cache-root", register() {} };`,
        });

        const options = {
          config: {
            plugins: {
              allow: ["cache-root"],
              entries: {
                "cache-root": { enabled: true },
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledA,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledB,
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached load-path plugin registries across env home changes",
      pluginId: "demo",
      setup: () => {
        const homeA = makeTempDir();
        const homeB = makeTempDir();
        const stateDir = makeTempDir();
        const bundledDir = makeTempDir();
        const pluginA = writePlugin({
          id: "demo",
          dir: path.join(homeA, "plugins", "demo"),
          filename: "index.cjs",
          body: `module.exports = { id: "demo", register() {} };`,
        });
        const pluginB = writePlugin({
          id: "demo",
          dir: path.join(homeB, "plugins", "demo"),
          filename: "index.cjs",
          body: `module.exports = { id: "demo", register() {} };`,
        });

        const options = {
          config: {
            plugins: {
              allow: ["demo"],
              entries: {
                demo: { enabled: true },
              },
              load: {
                paths: ["~/plugins/demo"],
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeA,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeB,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
              },
            }),
        };
      },
    },
  ])("$name", ({ pluginId, setup }) => {
    const { expectedFirstSource, expectedSecondSource, loadFirst, loadSecond } = setup();
    expectCachePartitionByPluginSource({
      pluginId,
      loadFirst,
      loadSecond,
      expectedFirstSource,
      expectedSecondSource,
    });
  });

  it.each([
    {
      name: "does not reuse cached registries when env-resolved install paths change",
      setup: () => {
        useNoBundledPlugins();
        const openclawHome = makeTempDir();
        const ignoredHome = makeTempDir();
        const stateDir = makeTempDir();
        const pluginDir = path.join(openclawHome, "plugins", "tracked-install-cache");
        mkdirSafe(pluginDir);
        const plugin = writePlugin({
          id: "tracked-install-cache",
          dir: pluginDir,
          filename: "index.cjs",
          body: `module.exports = { id: "tracked-install-cache", register() {} };`,
        });

        const options = {
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["tracked-install-cache"],
              installs: {
                "tracked-install-cache": {
                  source: "path" as const,
                  installPath: "~/plugins/tracked-install-cache",
                  sourcePath: "~/plugins/tracked-install-cache",
                },
              },
            },
          },
        };

        const secondHome = makeTempDir();
        return {
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_HOME: openclawHome,
                HOME: ignoredHome,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
              },
            }),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_HOME: secondHome,
                HOME: ignoredHome,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached registries across different plugin SDK resolution preferences",
      setup: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "cache-sdk-resolution",
          filename: "cache-sdk-resolution.cjs",
          body: `module.exports = { id: "cache-sdk-resolution", register() {} };`,
        });

        const options = {
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              allow: ["cache-sdk-resolution"],
              load: {
                paths: [plugin.file],
              },
            },
          },
        };

        return {
          loadFirst: () => loadOpenClawPlugins(options),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              pluginSdkResolution: "workspace" as PluginSdkResolutionPreference,
            }),
        };
      },
    },
    {
      name: "does not reuse cached registries across gateway subagent binding modes",
      setup: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          id: "cache-gateway-shared",
          filename: "cache-gateway-shared.cjs",
          body: `module.exports = { id: "cache-gateway-shared", register() {} };`,
        });

        const options = {
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              allow: ["cache-gateway-shared"],
              load: {
                paths: [plugin.file],
              },
            },
          },
        };

        return {
          loadFirst: () => loadOpenClawPlugins(options),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              runtimeOptions: {
                allowGatewaySubagentBinding: true,
              },
            }),
        };
      },
    },
  ])("$name", ({ setup }) => {
    expectCacheMissThenHit(setup());
  });

  it("evicts least recently used registries when the loader cache exceeds its cap", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cache-eviction",
      filename: "cache-eviction.cjs",
      body: `module.exports = { id: "cache-eviction", register() {} };`,
    });
    const previousCacheCap = __testing.maxPluginRegistryCacheEntries;
    __testing.setMaxPluginRegistryCacheEntriesForTest(4);
    const stateDirs = Array.from({ length: __testing.maxPluginRegistryCacheEntries + 1 }, () =>
      makeTempDir(),
    );

    const loadWithStateDir = (stateDir: string) =>
      loadOpenClawPlugins({
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        },
        config: {
          plugins: {
            allow: ["cache-eviction"],
            load: {
              paths: [plugin.file],
            },
          },
        },
      });

    try {
      const first = loadWithStateDir(stateDirs[0] ?? makeTempDir());
      const second = loadWithStateDir(stateDirs[1] ?? makeTempDir());

      expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);

      for (const stateDir of stateDirs.slice(2)) {
        loadWithStateDir(stateDir);
      }

      expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);
      expect(loadWithStateDir(stateDirs[1] ?? makeTempDir())).not.toBe(second);
    } finally {
      __testing.setMaxPluginRegistryCacheEntriesForTest(previousCacheCap);
    }
  });

  it("normalizes bundled plugin env overrides against the provided env", () => {
    const bundledDir = makeTempDir();
    const homeDir = path.dirname(bundledDir);
    const override = `~/${path.basename(bundledDir)}`;
    const plugin = writePlugin({
      id: "tilde-bundled",
      dir: path.join(bundledDir, "tilde-bundled"),
      filename: "index.cjs",
      body: `module.exports = { id: "tilde-bundled", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_HOME: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: override,
      },
      config: {
        plugins: {
          allow: ["tilde-bundled"],
          entries: {
            "tilde-bundled": { enabled: true },
          },
        },
      },
    });

    expect(
      fs.realpathSync(registry.plugins.find((entry) => entry.id === "tilde-bundled")?.source ?? ""),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("prefers OPENCLAW_HOME over HOME for env-expanded load paths", () => {
    const ignoredHome = makeTempDir();
    const openclawHome = makeTempDir();
    const stateDir = makeTempDir();
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      id: "openclaw-home-demo",
      dir: path.join(openclawHome, "plugins", "openclaw-home-demo"),
      filename: "index.cjs",
      body: `module.exports = { id: "openclaw-home-demo", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      env: {
        ...process.env,
        HOME: ignoredHome,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      },
      config: {
        plugins: {
          allow: ["openclaw-home-demo"],
          entries: {
            "openclaw-home-demo": { enabled: true },
          },
          load: {
            paths: ["~/plugins/openclaw-home-demo"],
          },
        },
      },
    });

    expect(
      fs.realpathSync(
        registry.plugins.find((entry) => entry.id === "openclaw-home-demo")?.source ?? "",
      ),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("loads plugins when source and root differ only by realpath alias", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "alias-safe",
      filename: "alias-safe.cjs",
      body: `module.exports = { id: "alias-safe", register() {} };`,
    });
    const realRoot = fs.realpathSync(plugin.dir);
    if (realRoot === plugin.dir) {
      return;
    }

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["alias-safe"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "alias-safe");
    expect(loaded?.status).toBe("loaded");
  });

  it("denylist disables plugins even if allowed", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "blocked",
      body: `module.exports = { id: "blocked", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["blocked"],
        deny: ["blocked"],
      },
    });

    const blocked = registry.plugins.find((entry) => entry.id === "blocked");
    expect(blocked?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "configurable",
      filename: "configurable.cjs",
      body: `module.exports = { id: "configurable", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        entries: {
          configurable: {
            config: "nope" as unknown as Record<string, unknown>,
          },
        },
      },
    });

    const configurable = registry.plugins.find((entry) => entry.id === "configurable");
    expect(configurable?.status).toBe("error");
    expect(registry.diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("repairs incomplete registered channel metadata before storing registry entries", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "channel-meta-repair",
      filename: "channel-meta-repair.cjs",
      body: `module.exports = { id: "channel-meta-repair", register(api) {
  api.registerChannel({
    plugin: {
      id: "telegram",
      meta: {
        id: "telegram"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["channel-meta-repair"],
      },
    });

    const telegram = registry.channels.find((entry) => entry.plugin.id === "telegram")?.plugin;
    expect(telegram?.meta).toMatchObject({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
    });
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.level === "warn" &&
          diag.message ===
            'channel "telegram" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
      ),
    ).toBe(true);
  });

  it("throws when strict plugin loading sees plugin errors", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "configurable",
      filename: "configurable.cjs",
      body: `module.exports = { id: "configurable", register() {} };`,
    });

    expect(() =>
      loadOpenClawPlugins({
        cache: false,
        throwOnLoadError: true,
        config: {
          plugins: {
            enabled: true,
            load: { paths: [plugin.file] },
            allow: ["configurable"],
            entries: {
              configurable: {
                enabled: true,
                config: "nope" as unknown as Record<string, unknown>,
              },
            },
          },
        },
      }),
    ).toThrow("plugin load failed: configurable: invalid config: <root>: must be object");
  });

  it("fails when plugin export id mismatches manifest id", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "manifest-id",
      filename: "manifest-id.cjs",
      body: `module.exports = { id: "export-id", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["manifest-id"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "manifest-id");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toBe(
      'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
    );
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.pluginId === "manifest-id" &&
          entry.message ===
            'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
      ),
    ).toBe(true);
  });

  it("handles single-plugin channel, context engine, and cli validation", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "registers channel plugins",
        pluginId: "channel-demo",
        body: `module.exports = { id: "channel-demo", register(api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "demo channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const channel = registry.channels.find((entry) => entry.plugin.id === "demo");
          expect(channel).toBeDefined();
        },
      },
      {
        label: "rejects duplicate channel ids during plugin registration",
        pluginId: "channel-dup",
        body: `module.exports = { id: "channel-dup", register(api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo Override",
        selectionLabel: "Demo Override",
        docsPath: "/channels/demo-override",
        blurb: "override"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo Duplicate",
        selectionLabel: "Demo Duplicate",
        docsPath: "/channels/demo-duplicate",
        blurb: "duplicate"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.channels.filter((entry) => entry.plugin.id === "demo")).toHaveLength(1);
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "channel-dup",
            message: "channel already registered: demo (channel-dup)",
          });
        },
      },
      {
        label: "rejects plugin context engine ids reserved by core",
        pluginId: "context-engine-core-collision",
        body: `module.exports = { id: "context-engine-core-collision", register(api) {
  api.registerContextEngine("legacy", () => ({}));
} };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "context-engine-core-collision",
            message: "context engine id reserved by core: legacy",
          });
        },
      },
      {
        label: "requires plugin CLI registrars to declare explicit command roots",
        pluginId: "cli-missing-metadata",
        body: `module.exports = { id: "cli-missing-metadata", register(api) {
  api.registerCli(() => {});
} };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars).toHaveLength(0);
          expectRegistryErrorDiagnostic({
            registry,
            pluginId: "cli-missing-metadata",
            message: "cli registration missing explicit commands metadata",
          });
        },
      },
    ] as const;

    runSinglePluginRegistryScenarios(scenarios);
  });

  it("registers plugin http routes", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "defaults exact match",
        pluginId: "http-route-demo",
        routeOptions:
          '{ path: "/demo", auth: "gateway", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } }',
        expectedPath: "/demo",
        expectedAuth: "gateway",
        expectedMatch: "exact",
        assert: expectRegisteredHttpRoute,
      },
      {
        label: "keeps explicit auth and match options",
        pluginId: "http-demo",
        routeOptions:
          '{ path: "/webhook", auth: "plugin", match: "prefix", handler: async () => false }',
        expectedPath: "/webhook",
        expectedAuth: "plugin",
        expectedMatch: "prefix",
        assert: expectRegisteredHttpRoute,
      },
    ] as const;

    runSinglePluginRegistryScenarios(
      scenarios.map((scenario) =>
        Object.assign({}, scenario, {
          body: `module.exports = { id: "${scenario.pluginId}", register(api) {
  api.registerHttpRoute(${scenario.routeOptions});
} };`,
        }),
      ),
    );
  });

  it("rejects duplicate plugin registrations", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "plugin-visible hook names",
        ownerA: "hook-owner-a",
        ownerB: "hook-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerHook("gateway:startup", () => {}, { name: "shared-hook" });
} };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.hooks.filter((entry) => entry.entry.hook.name === "shared-hook").length,
        duplicateMessage: "hook already registered: shared-hook (hook-owner-a)",
        assert: expectDuplicateRegistrationResult,
      },
      {
        label: "plugin service ids",
        ownerA: "service-owner-a",
        ownerB: "service-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerService({ id: "shared-service", start() {} });
} };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.services.filter((entry) => entry.service.id === "shared-service").length,
        duplicateMessage: "service already registered: shared-service (service-owner-a)",
        assert: expectDuplicateRegistrationResult,
      },
      {
        label: "plugin context engine ids",
        ownerA: "context-engine-owner-a",
        ownerB: "context-engine-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerContextEngine("shared-context-engine-loader-test", () => ({}));
} };`,
        selectCount: () => 1,
        duplicateMessage:
          "context engine already registered: shared-context-engine-loader-test (plugin:context-engine-owner-a)",
        assertPrimaryOwner: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.plugins.find((entry) => entry.id === "context-engine-owner-a")
              ?.contextEngineIds,
          ).toEqual(["shared-context-engine-loader-test"]);
        },
        assert: expectDuplicateRegistrationResult,
      },
      {
        label: "plugin CLI command roots",
        ownerA: "cli-owner-a",
        ownerB: "cli-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerCli(() => {}, { commands: ["shared-cli"] });
} };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.cliRegistrars.length,
        duplicateMessage: "cli command already registered: shared-cli (cli-owner-a)",
        assertPrimaryOwner: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars[0]?.pluginId).toBe("cli-owner-a");
        },
        assert: expectDuplicateRegistrationResult,
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => {
      const first = writePlugin({
        id: scenario.ownerA,
        filename: `${scenario.ownerA}.cjs`,
        body: scenario.buildBody(scenario.ownerA),
      });
      const second = writePlugin({
        id: scenario.ownerB,
        filename: `${scenario.ownerB}.cjs`,
        body: scenario.buildBody(scenario.ownerB),
      });
      return loadRegistryFromAllowedPlugins([first, second]);
    });
  });

  it("allows the same plugin to register the same service id twice", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "service-owner-self",
      filename: "service-owner-self.cjs",
      body: `module.exports = { id: "service-owner-self", register(api) {
  api.registerService({ id: "shared-service", start() {} });
  api.registerService({ id: "shared-service", start() {} });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["service-owner-self"],
      },
    });

    expect(registry.services.filter((entry) => entry.service.id === "shared-service")).toHaveLength(
      1,
    );
    expect(
      registry.diagnostics.some((diag) =>
        diag.message.includes("service already registered: shared-service"),
      ),
    ).toBe(false);
  });

  it("rewrites removed registerHttpHandler failures into migration diagnostics", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-handler-legacy",
      filename: "http-handler-legacy.cjs",
      body: `module.exports = { id: "http-handler-legacy", register(api) {
  api.registerHttpHandler({ path: "/legacy", handler: async () => true });
} };`,
    });

    const errors: string[] = [];
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-handler-legacy"],
      },
      options: {
        logger: createErrorLogger(errors),
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-legacy");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toContain("api.registerHttpHandler(...) was removed");
    expect(loaded?.error).toContain("api.registerHttpRoute(...)");
    expect(loaded?.error).toContain("registerPluginHttpRoute(...)");
    expect(
      registry.diagnostics.some((diag) =>
        diag.message.includes("api.registerHttpHandler(...) was removed"),
      ),
    ).toBe(true);
    expect(errors.some((entry) => entry.includes("api.registerHttpHandler(...) was removed"))).toBe(
      true,
    );
  });

  it("does not rewrite unrelated registerHttpHandler helper failures", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-handler-local-helper",
      filename: "http-handler-local-helper.cjs",
      body: `module.exports = { id: "http-handler-local-helper", register() {
  const registerHttpHandler = undefined;
  registerHttpHandler();
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-handler-local-helper"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-local-helper");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).not.toContain("api.registerHttpHandler(...) was removed");
  });

  it("enforces plugin http route validation and conflict rules", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "missing auth is rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-missing-auth",
            filename: "http-route-missing-auth.cjs",
            body: `module.exports = { id: "http-route-missing-auth", register(api) {
  api.registerHttpRoute({ path: "/demo", handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.httpRoutes.find((entry) => entry.pluginId === "http-route-missing-auth"),
          ).toBeUndefined();
          expect(
            registry.diagnostics.some((diag) =>
              diag.message.includes("http route registration missing or invalid auth"),
            ),
          ).toBe(true);
        },
      },
      {
        label: "same plugin can replace its own route",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-replace-self",
            filename: "http-route-replace-self.cjs",
            body: `module.exports = { id: "http-route-replace-self", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-replace-self",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/demo");
          expect(registry.diagnostics).toEqual([]);
        },
      },
      {
        label: "cross-plugin replaceExisting is rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-owner-a",
            filename: "http-route-owner-a.cjs",
            body: `module.exports = { id: "http-route-owner-a", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
} };`,
          }),
          writePlugin({
            id: "http-route-owner-b",
            filename: "http-route-owner-b.cjs",
            body: `module.exports = { id: "http-route-owner-b", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const route = registry.httpRoutes.find((entry) => entry.path === "/demo");
          expect(route?.pluginId).toBe("http-route-owner-a");
          expect(
            registry.diagnostics.some((diag) =>
              diag.message.includes("http route replacement rejected"),
            ),
          ).toBe(true);
        },
      },
      {
        label: "mixed-auth overlaps are rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-overlap",
            filename: "http-route-overlap.cjs",
            body: `module.exports = { id: "http-route-overlap", register(api) {
  api.registerHttpRoute({ path: "/plugin/secure", auth: "gateway", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/secure/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/plugin/secure");
          expect(
            registry.diagnostics.some((diag) =>
              diag.message.includes("http route overlap rejected"),
            ),
          ).toBe(true);
        },
      },
      {
        label: "same-auth overlaps are allowed",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-overlap-same-auth",
            filename: "http-route-overlap-same-auth.cjs",
            body: `module.exports = { id: "http-route-overlap-same-auth", register(api) {
  api.registerHttpRoute({ path: "/plugin/public", auth: "plugin", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/public/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap-same-auth",
          );
          expect(routes).toHaveLength(2);
          expect(registry.diagnostics).toEqual([]);
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) =>
      loadRegistryFromScenarioPlugins(scenario.buildPlugins()),
    );
  });

  it("respects explicit disable in config", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "config-disable",
      body: `module.exports = { id: "config-disable", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            "config-disable": { enabled: false },
          },
        },
      },
    });

    const disabled = registry.plugins.find((entry) => entry.id === "config-disable");
    expect(disabled?.status).toBe("disabled");
  });

  it("loads bundled channel entries through nested default export wrappers", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const fullMarker = path.join(pluginDir, "full-loaded.txt");

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/nested-default-channel",
          openclaw: {
            extensions: ["./index.cjs"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "nested-default-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["nested-default-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
  default: {
    default: {
      id: "nested-default-channel",
      kind: "bundled-channel-entry",
      name: "Nested Default Channel",
      description: "interop-wrapped bundled channel entry",
      register(api) {
        require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
        api.registerChannel({
          plugin: {
            id: "nested-default-channel",
            meta: {
              id: "nested-default-channel",
              label: "Nested Default Channel",
              selectionLabel: "Nested Default Channel",
              docsPath: "/channels/nested-default-channel",
              blurb: "interop-wrapped bundled channel entry",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({ accountId: "default", token: "configured" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });
      },
    },
  },
};`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        channels: {
          "nested-default-channel": {
            enabled: true,
            token: "configured",
          },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["nested-default-channel"],
        },
      },
    });

    expect(fs.existsSync(fullMarker)).toBe(true);
    expect(registry.plugins.find((entry) => entry.id === "nested-default-channel")?.status).toBe(
      "loaded",
    );
    expect(registry.channels.some((entry) => entry.plugin.id === "nested-default-channel")).toBe(
      true,
    );
  });

  it("does not treat manifest channel ids as scoped plugin id matches", () => {
    useNoBundledPlugins();
    const target = writePlugin({
      id: "target-plugin",
      filename: "target-plugin.cjs",
      body: `module.exports = { id: "target-plugin", register() {} };`,
    });
    const unrelated = writePlugin({
      id: "unrelated-plugin",
      filename: "unrelated-plugin.cjs",
      body: `module.exports = { id: "unrelated-plugin", register() { throw new Error("unrelated plugin should not load"); } };`,
    });
    fs.writeFileSync(
      path.join(unrelated.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "unrelated-plugin",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["target-plugin"],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [target.file, unrelated.file] },
          allow: ["target-plugin", "unrelated-plugin"],
          entries: {
            "target-plugin": { enabled: true },
            "unrelated-plugin": { enabled: true },
          },
        },
      },
      onlyPluginIds: ["target-plugin"],
    });

    expect(registry.plugins.map((entry) => entry.id)).toEqual(["target-plugin"]);
  });

  it("only setup-loads a disabled channel plugin when the caller scopes to the selected plugin", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "lazy-channel-imported.txt");
    const plugin = writePlugin({
      id: "lazy-channel-plugin",
      filename: "lazy-channel.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
module.exports = {
  id: "lazy-channel-plugin",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "lazy-channel",
        meta: {
          id: "lazy-channel",
          label: "Lazy Channel",
          selectionLabel: "Lazy Channel",
          docsPath: "/channels/lazy-channel",
          blurb: "lazy test channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "lazy-channel-plugin",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["lazy-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: ["lazy-channel-plugin"],
        entries: {
          "lazy-channel-plugin": { enabled: false },
        },
      },
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(0);
    expect(registry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status).toBe(
      "disabled",
    );

    const broadSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config,
      includeSetupOnlyChannelPlugins: true,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(broadSetupRegistry.channelSetups).toHaveLength(0);
    expect(broadSetupRegistry.channels).toHaveLength(0);
    expect(
      broadSetupRegistry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status,
    ).toBe("disabled");

    const scopedSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config,
      includeSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["lazy-channel-plugin"],
    });

    expect(fs.existsSync(marker)).toBe(true);
    expect(scopedSetupRegistry.channelSetups).toHaveLength(1);
    expect(scopedSetupRegistry.channels).toHaveLength(0);
    expect(
      scopedSetupRegistry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status,
    ).toBe("disabled");
  });

  it.each([
    {
      name: "uses package setupEntry for selected setup-only channel loads",
      fixture: {
        id: "setup-entry-test",
        label: "Setup Entry Test",
        packageName: "@openclaw/setup-entry-test",
        fullBlurb: "full entry should not run in setup-only mode",
        setupBlurb: "setup entry",
        configured: false,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-entry-test"],
              entries: {
                "setup-entry-test": { enabled: false },
              },
            },
          },
          includeSetupOnlyChannelPlugins: true,
          onlyPluginIds: ["setup-entry-test"],
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 0,
    },
    {
      name: "keeps bundled setupEntry setup-only loads on the setup-safe path",
      fixture: {
        id: "setup-only-bundled-contract-test",
        label: "Setup Only Bundled Contract Test",
        packageName: "@openclaw/setup-only-bundled-contract-test",
        fullBlurb: "full entry should not run in setup-only mode",
        setupBlurb: "setup-only bundled contract",
        configured: false,
        useBundledSetupEntryContract: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-only-bundled-contract-test"],
              entries: {
                "setup-only-bundled-contract-test": { enabled: false },
              },
            },
          },
          includeSetupOnlyChannelPlugins: true,
          onlyPluginIds: ["setup-only-bundled-contract-test"],
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 0,
    },
    {
      name: "uses package setupEntry for enabled but unconfigured channel loads",
      fixture: {
        id: "setup-runtime-test",
        label: "Setup Runtime Test",
        packageName: "@openclaw/setup-runtime-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime",
        configured: false,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-test"],
            },
          },
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 1,
    },
    {
      name: "uses package setupEntry bundled contract for setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-contract-test",
        label: "Setup Runtime Bundled Contract Test",
        packageName: "@openclaw/setup-runtime-bundled-contract-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime bundled contract",
        configured: false,
        useBundledSetupEntryContract: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-contract-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
    },
    {
      name: "preserves bundled setupEntry split secrets for setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-contract-secrets-test",
        label: "Setup Runtime Bundled Contract Secrets Test",
        packageName: "@openclaw/setup-runtime-bundled-contract-secrets-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime bundled contract secrets",
        configured: false,
        useBundledSetupEntryContract: true,
        splitBundledSetupSecrets: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-contract-secrets-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectedSetupSecretId: "channels.setup-runtime-bundled-contract-secrets-test.setup-token",
    },
    {
      name: "applies bundled setupEntry runtime setter for setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-contract-runtime-test",
        label: "Setup Runtime Bundled Contract Runtime Test",
        packageName: "@openclaw/setup-runtime-bundled-contract-runtime-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime bundled contract runtime",
        configured: false,
        useBundledSetupEntryContract: true,
        bundledSetupRuntimeMarker: path.join(makeTempDir(), "setup-runtime-applied.txt"),
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-contract-runtime-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectSetupRuntimeLoaded: true,
    },
    {
      name: "merges bundled runtime plugin into setup-runtime channel loads",
      fixture: {
        id: "setup-runtime-bundled-runtime-merge-test",
        label: "Setup Runtime Bundled Runtime Merge Test",
        packageName: "@openclaw/setup-runtime-bundled-runtime-merge-test",
        fullBlurb: "full runtime plugin",
        setupBlurb: "setup runtime override",
        configured: false,
        useBundledFullEntryContract: true,
        useBundledSetupEntryContract: true,
        bundledFullRuntimeMarker: path.join(makeTempDir(), "bundled-runtime-applied.txt"),
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-bundled-runtime-merge-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: true,
      expectedChannels: 1,
      expectBundledFullRuntimeLoaded: true,
    },
    {
      name: "does not prefer setupEntry for configured channel loads without startup opt-in",
      fixture: {
        id: "setup-runtime-not-preferred-test",
        label: "Setup Runtime Not Preferred Test",
        packageName: "@openclaw/setup-runtime-not-preferred-test",
        fullBlurb: "full entry should still load without explicit startup opt-in",
        setupBlurb: "setup runtime not preferred",
        configured: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          preferSetupRuntimeForChannelPlugins: true,
          config: {
            channels: {
              "setup-runtime-not-preferred-test": {
                enabled: true,
                token: "configured",
              },
            },
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-not-preferred-test"],
            },
          },
        }),
      expectFullLoaded: true,
      expectSetupLoaded: false,
      expectedChannels: 1,
    },
  ])(
    "$name",
    ({
      fixture,
      load,
      expectFullLoaded,
      expectSetupLoaded,
      expectedChannels,
      expectedSetupSecretId,
      expectSetupRuntimeLoaded,
      expectBundledFullRuntimeLoaded,
    }) => {
      const built = createSetupEntryChannelPluginFixture(fixture);
      const registry = load({ pluginDir: built.pluginDir });

      expect(fs.existsSync(built.fullMarker)).toBe(expectFullLoaded);
      expect(fs.existsSync(built.setupMarker)).toBe(expectSetupLoaded);
      expect(registry.channelSetups).toHaveLength(1);
      expect(registry.channels).toHaveLength(expectedChannels);
      if (fixture.bundledSetupRuntimeMarker) {
        expect(fs.existsSync(fixture.bundledSetupRuntimeMarker)).toBe(
          expectSetupRuntimeLoaded ?? false,
        );
      }
      if (fixture.bundledFullRuntimeMarker) {
        expect(fs.existsSync(fixture.bundledFullRuntimeMarker)).toBe(
          expectBundledFullRuntimeLoaded ?? false,
        );
      }
      if (expectedSetupSecretId) {
        expect(registry.channelSetups[0]?.plugin.secrets?.secretTargetRegistryEntries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: expectedSetupSecretId,
            }),
          ]),
        );
        expect(registry.channels[0]?.plugin.secrets?.secretTargetRegistryEntries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: expectedSetupSecretId,
            }),
          ]),
        );
      }
    },
  );

  it("applies the bundled runtime setter before loading the merged setup-runtime plugin", () => {
    const runtimeMarker = path.join(makeTempDir(), "setup-runtime-before-load.txt");
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-order-test",
      label: "Setup Runtime Order Test",
      packageName: "@openclaw/setup-runtime-order-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledFullEntryContract: true,
      useBundledSetupEntryContract: true,
      bundledFullRuntimeMarker: runtimeMarker,
      requireBundledFullRuntimeBeforeLoad: true,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir] },
          allow: ["setup-runtime-order-test"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "setup-runtime-order-test")?.status).toBe(
      "loaded",
    );
    expect(fs.existsSync(runtimeMarker)).toBe(true);
  });

  it("records setup runtime setter failures without aborting the full load pass", () => {
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-error-test",
      label: "Setup Runtime Error Test",
      packageName: "@openclaw/setup-runtime-error-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledSetupEntryContract: true,
      bundledSetupRuntimeError: "broken setup runtime setter",
    });
    const helperPlugin = writePlugin({
      id: "setup-runtime-helper-test",
      filename: "setup-runtime-helper-test.cjs",
      body: `module.exports = { id: "setup-runtime-helper-test", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir, helperPlugin.file] },
          allow: ["setup-runtime-error-test", "setup-runtime-helper-test"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "setup-runtime-error-test")?.status).toBe(
      "error",
    );
    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-error-test")?.error,
    ).toContain("broken setup runtime setter");
    expect(registry.plugins.find((entry) => entry.id === "setup-runtime-helper-test")?.status).toBe(
      "loaded",
    );
  });

  it("rejects mismatched bundled runtime entry ids before applying setup-runtime setters", () => {
    const runtimeMarker = path.join(makeTempDir(), "setup-runtime-mismatch.txt");
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-runtime-mismatch-test",
      bundledFullEntryId: "wrong-runtime-id",
      label: "Setup Runtime Mismatch Test",
      packageName: "@openclaw/setup-runtime-mismatch-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledFullEntryContract: true,
      useBundledSetupEntryContract: true,
      bundledFullRuntimeMarker: runtimeMarker,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir] },
          allow: ["setup-runtime-mismatch-test"],
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-mismatch-test")?.status,
    ).toBe("error");
    expect(
      registry.plugins.find((entry) => entry.id === "setup-runtime-mismatch-test")?.error,
    ).toContain('runtime entry uses "wrong-runtime-id"');
    expect(registry.channels).toHaveLength(0);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("rejects mismatched bundled setup export ids before loading setup-runtime entry code", () => {
    const runtimeMarker = path.join(makeTempDir(), "setup-runtime-mismatch.txt");
    const built = createSetupEntryChannelPluginFixture({
      id: "setup-export-mismatch-test",
      bundledSetupEntryId: "wrong-setup-id",
      label: "Setup Export Mismatch Test",
      packageName: "@openclaw/setup-export-mismatch-test",
      fullBlurb: "full runtime plugin",
      setupBlurb: "setup runtime override",
      configured: false,
      useBundledFullEntryContract: true,
      useBundledSetupEntryContract: true,
      bundledFullRuntimeMarker: runtimeMarker,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [built.pluginDir] },
          allow: ["setup-export-mismatch-test"],
        },
      },
    });

    expect(
      registry.plugins.find((entry) => entry.id === "setup-export-mismatch-test")?.status,
    ).toBe("error");
    expect(
      registry.plugins.find((entry) => entry.id === "setup-export-mismatch-test")?.error,
    ).toContain('setup export uses "wrong-setup-id"');
    expect(registry.channels).toHaveLength(0);
    expect(fs.existsSync(built.fullMarker)).toBe(false);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("isolates loadSetupPlugin errors as per-plugin diagnostics instead of crashing registry load", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();

    // Plugin whose setup-entry uses the bundled contract but loadSetupPlugin() throws
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-entry-throws-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "setup-entry-throws-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["setup-entry-throws-test"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    // index.cjs: full entry (should NOT be reached if setup-entry is used)
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = { id: "setup-entry-throws-test", register() {} };`,
      "utf-8",
    );
    // setup-entry.cjs: bundled contract whose loadSetupPlugin throws
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin: () => { throw new Error("boom: setup plugin missing"); },
};`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["setup-entry-throws-test"],
        },
      },
    });

    // The registry load should NOT crash; the error should be recorded as a
    // per-plugin diagnostic rather than aborting the whole load.
    expect(registry.diagnostics.length).toBeGreaterThanOrEqual(1);
    const diagnostic = registry.diagnostics.find(
      (d) => d.pluginId === "setup-entry-throws-test" && d.level === "error",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).toContain("failed to load setup entry");
  });

  it("keeps healthy sibling channel plugins loadable when a setup entry throws", () => {
    useNoBundledPlugins();
    const brokenDir = makeTempDir();

    fs.writeFileSync(
      path.join(brokenDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-entry-throws-sibling-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "setup-entry-throws-sibling-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["broken-chat"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "index.cjs"),
      `module.exports = { id: "setup-entry-throws-sibling-test", register() {} };`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(brokenDir, "setup-entry.cjs"),
      `module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin: () => { throw new Error("boom: setup plugin missing"); },
};`,
      "utf-8",
    );

    const healthy = writePlugin({
      id: "healthy-channel",
      filename: "healthy-channel.cjs",
      body: `module.exports = { id: "healthy-channel", register(api) {
  api.registerChannel({
    plugin: {
      id: "healthy-chat",
      meta: {
        id: "healthy-chat",
        label: "Healthy Chat",
        selectionLabel: "Healthy Chat",
        docsPath: "/channels/healthy-chat",
        blurb: "healthy sibling channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      outbound: { deliveryMode: "direct" },
    }
  });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
          load: { paths: [brokenDir, healthy.file] },
          allow: ["setup-entry-throws-sibling-test", "healthy-channel"],
        },
      },
    });

    expect(
      registry.channels.find((entry) => entry.plugin.id === "healthy-chat")?.plugin.meta,
    ).toMatchObject({
      label: "Healthy Chat",
      docsPath: "/channels/healthy-chat",
    });
    expect(registry.plugins.find((entry) => entry.id === "healthy-channel")?.status).toBe("loaded");
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "setup-entry-throws-sibling-test" &&
          diag.level === "error" &&
          diag.message.includes("failed to load setup entry"),
      ),
    ).toBe(true);
  });

  it("prefers setupEntry for configured channel loads during startup when opted in", () => {
    expect(
      __testing.shouldLoadChannelPluginInSetupRuntime({
        manifestChannels: ["setup-runtime-preferred-test"],
        setupSource: "./setup-entry.cjs",
        startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
        cfg: {
          channels: {
            "setup-runtime-preferred-test": {
              enabled: true,
              token: "configured",
            },
          },
        },
        env: {},
        preferSetupRuntimeForChannelPlugins: true,
      }),
    ).toBe(true);
  });

  it("blocks before_prompt_build but preserves legacy model overrides when prompt injection is disabled", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy",
      filename: "hook-policy.cjs",
      body: `module.exports = { id: "hook-policy", register(api) {
  api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
  api.on("before_agent_start", () => ({
    prependContext: "legacy",
    modelOverride: "demo-legacy-model",
    providerOverride: "demo-legacy-provider",
  }));
  api.on("before_model_resolve", () => ({ providerOverride: "demo-explicit-provider" }));
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy"],
        entries: {
          "hook-policy": {
            hooks: {
              allowPromptInjection: false,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-policy")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_agent_start",
      "before_model_resolve",
    ]);
    const runner = createHookRunner(registry);
    const legacyResult = await runner.runBeforeAgentStart({ prompt: "hello", messages: [] }, {});
    expect(legacyResult).toEqual({
      modelOverride: "demo-legacy-model",
      providerOverride: "demo-legacy-provider",
    });
    const blockedDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes(
        "blocked by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(blockedDiagnostics).toHaveLength(1);
    const constrainedDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes(
        "prompt fields constrained by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(constrainedDiagnostics).toHaveLength(1);
  });

  it("keeps prompt-injection typed hooks enabled by default", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy-default",
      filename: "hook-policy-default.cjs",
      body: `module.exports = { id: "hook-policy-default", register(api) {
  api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
  api.on("before_agent_start", () => ({ prependContext: "legacy" }));
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy-default"],
      },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_prompt_build",
      "before_agent_start",
    ]);
  });

  it("ignores unknown typed hooks from plugins and keeps loading", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-unknown",
      filename: "hook-unknown.cjs",
      body: `module.exports = { id: "hook-unknown", register(api) {
  api.on("totally_unknown_hook_name", () => ({ foo: "bar" }));
  api.on(123, () => ({ foo: "baz" }));
  api.on("before_model_resolve", () => ({ providerOverride: "demo-provider" }));
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-unknown"],
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-unknown")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_model_resolve"]);
    const unknownHookDiagnostics = registry.diagnostics.filter((diag) =>
      diag.message.includes('unknown typed hook "'),
    );
    expect(unknownHookDiagnostics).toHaveLength(2);
    expect(
      unknownHookDiagnostics.some((diag) =>
        diag.message.includes('unknown typed hook "totally_unknown_hook_name" ignored'),
      ),
    ).toBe(true);
    expect(
      unknownHookDiagnostics.some((diag) =>
        diag.message.includes('unknown typed hook "123" ignored'),
      ),
    ).toBe(true);
  });

  it("enforces memory slot loading rules", () => {
    const scenarios = [
      {
        label: "enforces memory slot selection",
        loadRegistry: () => {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
          const memoryA = writePlugin({
            id: "memory-a",
            body: memoryPluginBody("memory-a"),
          });
          const memoryB = writePlugin({
            id: "memory-b",
            body: memoryPluginBody("memory-b"),
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [memoryA.file, memoryB.file] },
                slots: { memory: "memory-b" },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(b?.status).toBe("loaded");
          expect(a?.status).toBe("disabled");
        },
      },
      {
        label: "skips importing bundled memory plugins that are disabled by memory slot",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryADir = path.join(bundledDir, "memory-a");
          const memoryBDir = path.join(bundledDir, "memory-b");
          mkdirSafe(memoryADir);
          mkdirSafe(memoryBDir);
          writePlugin({
            id: "memory-a",
            dir: memoryADir,
            filename: "index.cjs",
            body: `throw new Error("memory-a should not be imported when slot selects memory-b");`,
          });
          writePlugin({
            id: "memory-b",
            dir: memoryBDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-b"),
          });
          fs.writeFileSync(
            path.join(memoryADir, "openclaw.plugin.json"),
            JSON.stringify(
              {
                id: "memory-a",
                kind: "memory",
                configSchema: EMPTY_PLUGIN_SCHEMA,
              },
              null,
              2,
            ),
            "utf-8",
          );
          fs.writeFileSync(
            path.join(memoryBDir, "openclaw.plugin.json"),
            JSON.stringify(
              {
                id: "memory-b",
                kind: "memory",
                configSchema: EMPTY_PLUGIN_SCHEMA,
              },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-a", "memory-b"],
                slots: { memory: "memory-b" },
                entries: {
                  "memory-a": { enabled: true },
                  "memory-b": { enabled: true },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(a?.status).toBe("disabled");
          expect(a?.error ?? "").toContain('memory slot set to "memory-b"');
          expect(b?.status).toBe("loaded");
        },
      },
      {
        label:
          "loads dreaming engine alongside a different memory slot plugin when dreaming is enabled",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryCoreDir = path.join(bundledDir, "memory-core");
          const memoryLanceDir = path.join(bundledDir, "memory-lancedb");
          mkdirSafe(memoryCoreDir);
          mkdirSafe(memoryLanceDir);
          writePlugin({
            id: "memory-core",
            dir: memoryCoreDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-core"),
          });
          writePlugin({
            id: "memory-lancedb",
            dir: memoryLanceDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-lancedb"),
          });
          const openSchema = { type: "object", additionalProperties: true };
          fs.writeFileSync(
            path.join(memoryCoreDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-core", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          fs.writeFileSync(
            path.join(memoryLanceDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-lancedb", kind: "memory", configSchema: openSchema },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-core", "memory-lancedb"],
                slots: { memory: "memory-lancedb" },
                entries: {
                  "memory-core": { enabled: true },
                  "memory-lancedb": { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("loaded");
          expect(lance?.status).toBe("loaded");
          expect(lance?.memorySlotSelected).toBe(true);
          expect(core?.memorySlotSelected).toBeFalsy();
        },
      },
      {
        label: "excludes dreaming engine when dreaming is disabled and it is not the slot",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryCoreDir = path.join(bundledDir, "memory-core");
          const memoryLanceDir = path.join(bundledDir, "memory-lancedb");
          mkdirSafe(memoryCoreDir);
          mkdirSafe(memoryLanceDir);
          writePlugin({
            id: "memory-core",
            dir: memoryCoreDir,
            filename: "index.cjs",
            body: `throw new Error("memory-core should not load when dreaming is disabled");`,
          });
          writePlugin({
            id: "memory-lancedb",
            dir: memoryLanceDir,
            filename: "index.cjs",
            body: memoryPluginBody("memory-lancedb"),
          });
          fs.writeFileSync(
            path.join(memoryCoreDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-core", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          fs.writeFileSync(
            path.join(memoryLanceDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-lancedb", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-core", "memory-lancedb"],
                slots: { memory: "memory-lancedb" },
                entries: {
                  "memory-core": { enabled: true },
                  "memory-lancedb": { enabled: true },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          const lance = registry.plugins.find((entry) => entry.id === "memory-lancedb");
          expect(core?.status).toBe("disabled");
          expect(lance?.status).toBe("loaded");
        },
      },
      {
        label: 'keeps memory slot "none" disabled even with stale memory-core dreaming config',
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryCoreDir = path.join(bundledDir, "memory-core");
          mkdirSafe(memoryCoreDir);
          writePlugin({
            id: "memory-core",
            dir: memoryCoreDir,
            filename: "index.cjs",
            body: `throw new Error("memory-core should not load when memory slot is none");`,
          });
          fs.writeFileSync(
            path.join(memoryCoreDir, "openclaw.plugin.json"),
            JSON.stringify(
              { id: "memory-core", kind: "memory", configSchema: EMPTY_PLUGIN_SCHEMA },
              null,
              2,
            ),
            "utf-8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-core"],
                slots: { memory: "none" },
                entries: {
                  "memory-core": { enabled: true, config: { dreaming: { enabled: true } } },
                },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const core = registry.plugins.find((entry) => entry.id === "memory-core");
          expect(core?.status).toBe("disabled");
        },
      },
      {
        label: "disables memory plugins when slot is none",
        loadRegistry: () => {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
          const memory = writePlugin({
            id: "memory-off",
            body: memoryPluginBody("memory-off"),
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [memory.file] },
                slots: { memory: "none" },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const entry = registry.plugins.find((item) => item.id === "memory-off");
          expect(entry?.status).toBe("disabled");
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, ({ loadRegistry }) => loadRegistry());
  });

  it("resolves duplicate plugin ids by source precedence", () => {
    const scenarios = [
      {
        label: "config load overrides bundled",
        pluginId: "shadow",
        bundledFilename: "shadow.cjs",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "shadow",
            body: simplePluginBody("shadow"),
            filename: "shadow.cjs",
          });

          const override = writePlugin({
            id: "shadow",
            body: simplePluginBody("shadow"),
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [override.file] },
                entries: {
                  shadow: { enabled: true },
                },
              },
            },
          });
        },
        expectedLoadedOrigin: "config",
        expectedDisabledOrigin: "bundled",
        assert: expectPluginSourcePrecedence,
      },
      {
        label: "bundled beats auto-discovered global duplicate",
        pluginId: "demo-bundled-duplicate",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "demo-bundled-duplicate",
            body: simplePluginBody("demo-bundled-duplicate"),
          });
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "demo-bundled-duplicate");
            mkdirSafe(globalDir);
            writePlugin({
              id: "demo-bundled-duplicate",
              body: simplePluginBody("demo-bundled-duplicate"),
              dir: globalDir,
              filename: "index.cjs",
            });

            return loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["demo-bundled-duplicate"],
                  entries: {
                    "demo-bundled-duplicate": { enabled: true },
                  },
                },
              },
            });
          });
        },
        expectedLoadedOrigin: "bundled",
        expectedDisabledOrigin: "global",
        expectedDisabledError: "overridden by bundled plugin",
        assert: expectPluginSourcePrecedence,
      },
      {
        label: "installed global beats bundled duplicate",
        pluginId: "demo-installed-duplicate",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "demo-installed-duplicate",
            body: simplePluginBody("demo-installed-duplicate"),
          });
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "demo-installed-duplicate");
            mkdirSafe(globalDir);
            writePlugin({
              id: "demo-installed-duplicate",
              body: simplePluginBody("demo-installed-duplicate"),
              dir: globalDir,
              filename: "index.cjs",
            });

            return loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["demo-installed-duplicate"],
                  installs: {
                    "demo-installed-duplicate": {
                      source: "npm",
                      installPath: globalDir,
                    },
                  },
                  entries: {
                    "demo-installed-duplicate": { enabled: true },
                  },
                },
              },
            });
          });
        },
        expectedLoadedOrigin: "global",
        expectedDisabledOrigin: "bundled",
        expectedDisabledError: "overridden by global plugin",
        assert: expectPluginSourcePrecedence,
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => scenario.loadRegistry());
  });

  it("warns about open allowlists only for auto-discovered plugins", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const scenarios = [
      {
        label: "explicit config path stays quiet",
        pluginId: "warn-open-allow-config",
        loads: 1,
        expectedWarnings: 0,
        loadRegistry: (warnings: string[]) => {
          const plugin = writePlugin({
            id: "warn-open-allow-config",
            body: simplePluginBody("warn-open-allow-config"),
          });
          return loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            config: {
              plugins: {
                load: { paths: [plugin.file] },
              },
            },
          });
        },
      },
      {
        label: "workspace discovery warns once",
        pluginId: "warn-open-allow-workspace",
        loads: 2,
        expectedWarnings: 1,
        loadRegistry: (() => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "warn-open-allow-workspace",
          });
          return (warnings: string[]) =>
            loadOpenClawPlugins({
              cache: false,
              workspaceDir,
              logger: createWarningLogger(warnings),
              config: {
                plugins: {
                  enabled: true,
                },
              },
            });
        })(),
      },
    ] as const;

    runScenarioCases(scenarios, (scenario) => {
      const warnings: string[] = [];

      for (let index = 0; index < scenario.loads; index += 1) {
        scenario.loadRegistry(warnings);
      }

      expectOpenAllowWarnings({
        warnings,
        pluginId: scenario.pluginId,
        expectedWarnings: scenario.expectedWarnings,
        label: scenario.label,
      });
    });
  });

  it("handles workspace-discovered plugins according to trust and precedence", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "untrusted workspace plugins stay disabled",
        pluginId: "workspace-helper",
        loadRegistry: () => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "workspace-helper",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectPluginOriginAndStatus({
            registry,
            pluginId: "workspace-helper",
            origin: "workspace",
            status: "disabled",
            label: "untrusted workspace plugins stay disabled",
            errorIncludes: "workspace plugin (disabled by default)",
          });
        },
      },
      {
        label: "trusted workspace plugins load",
        pluginId: "workspace-helper",
        loadRegistry: () => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "workspace-helper",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
                allow: ["workspace-helper"],
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectPluginOriginAndStatus({
            registry,
            pluginId: "workspace-helper",
            origin: "workspace",
            status: "loaded",
            label: "trusted workspace plugins load",
          });
        },
      },
      {
        label: "bundled plugins stay ahead of trusted workspace duplicates",
        pluginId: "shadowed",
        expectedLoadedOrigin: "bundled",
        expectedDisabledOrigin: "workspace",
        expectedDisabledError: "overridden by bundled plugin",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "shadowed",
          });
          const { workspaceDir } = writeWorkspacePlugin({
            id: "shadowed",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
                allow: ["shadowed"],
                entries: {
                  shadowed: { enabled: true },
                },
              },
            },
          });
        },
        assert: (registry: PluginRegistry) => {
          expectPluginSourcePrecedence(registry, {
            pluginId: "shadowed",
            expectedLoadedOrigin: "bundled",
            expectedDisabledOrigin: "workspace",
            expectedDisabledError: "overridden by bundled plugin",
            label: "bundled plugins stay ahead of trusted workspace duplicates",
          });
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => scenario.loadRegistry());
  });

  it("loads bundled plugins when manifest metadata opts into default enablement", () => {
    const { bundledDir, plugin } = writeBundledPlugin({
      id: "profile-aware",
      body: simplePluginBody("profile-aware"),
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "profile-aware",
          enabledByDefault: true,
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: bundledDir,
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    const bundledPlugin = registry.plugins.find((entry) => entry.id === "profile-aware");
    expect(bundledPlugin?.origin).toBe("bundled");
    expect(bundledPlugin?.status).toBe("loaded");
  });

  it("keeps scoped and unscoped plugin ids distinct", () => {
    useNoBundledPlugins();
    const scoped = writePlugin({
      id: "@team/shadowed",
      body: simplePluginBody("@team/shadowed"),
      filename: "scoped.cjs",
    });
    const unscoped = writePlugin({
      id: "shadowed",
      body: simplePluginBody("shadowed"),
      filename: "unscoped.cjs",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [scoped.file, unscoped.file] },
          allow: ["@team/shadowed", "shadowed"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "@team/shadowed")?.status).toBe("loaded");
    expect(registry.plugins.find((entry) => entry.id === "shadowed")?.status).toBe("loaded");
    expect(registry.diagnostics.some((diag) => diag.message.includes("duplicate plugin id"))).toBe(
      false,
    );
  });

  it("evaluates load-path provenance warnings", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "does not warn when loaded non-bundled plugin is in plugins.allow",
        loadRegistry: () => {
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "rogue");
            mkdirSafe(globalDir);
            writePlugin({
              id: "rogue",
              body: simplePluginBody("rogue"),
              dir: globalDir,
              filename: "index.cjs",
            });

            const warnings: string[] = [];
            const registry = loadOpenClawPlugins({
              cache: false,
              logger: createWarningLogger(warnings),
              config: {
                plugins: {
                  allow: ["rogue"],
                },
              },
            });

            return { registry, warnings, pluginId: "rogue", expectWarning: false };
          });
        },
      },
      {
        label: "warns when loaded non-bundled plugin has no provenance and no allowlist is set",
        loadRegistry: () => {
          const stateDir = makeTempDir();
          return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
            const globalDir = path.join(stateDir, "extensions", "rogue");
            mkdirSafe(globalDir);
            writePlugin({
              id: "rogue",
              body: `module.exports = { id: "rogue", register() {} };`,
              dir: globalDir,
              filename: "index.cjs",
            });

            const warnings: string[] = [];
            const registry = loadOpenClawPlugins({
              cache: false,
              logger: createWarningLogger(warnings),
              config: {
                plugins: {
                  enabled: true,
                },
              },
            });

            return { registry, warnings, pluginId: "rogue", expectWarning: true };
          });
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved load paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-load-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            env,
            config: {
              plugins: {
                load: { paths: ["~/plugins/tracked-load-path"] },
                allow: [plugin.id],
              },
            },
          });

          return {
            registry,
            warnings,
            pluginId: plugin.id,
            expectWarning: false,
            expectedSource: plugin.file,
          };
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved install paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-install-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            env,
            config: {
              plugins: {
                load: { paths: [plugin.file] },
                allow: [plugin.id],
                installs: {
                  [plugin.id]: {
                    source: "path",
                    installPath: `~/plugins/${plugin.id}`,
                    sourcePath: `~/plugins/${plugin.id}`,
                  },
                },
              },
            },
          });

          return {
            registry,
            warnings,
            pluginId: plugin.id,
            expectWarning: false,
            expectedSource: plugin.file,
          };
        },
      },
    ] as const;

    runScenarioCases(scenarios, (scenario) => {
      const loadedScenario = scenario.loadRegistry();
      const expectedSource =
        "expectedSource" in loadedScenario && typeof loadedScenario.expectedSource === "string"
          ? loadedScenario.expectedSource
          : undefined;
      expectLoadedPluginProvenance({
        scenario,
        ...loadedScenario,
        expectedSource,
      });
    });
  });

  it.each([
    {
      name: "rejects plugin entry files that escape plugin root via symlink",
      id: "symlinked",
      linkKind: "symlink" as const,
    },
    {
      name: "rejects plugin entry files that escape plugin root via hardlink",
      id: "hardlinked",
      linkKind: "hardlink" as const,
      skip: process.platform === "win32",
    },
  ])("$name", ({ id, linkKind, skip }) => {
    if (skip) {
      return;
    }
    expectEscapingEntryRejected({
      id,
      linkKind,
      sourceBody: `module.exports = { id: "${id}", register() { throw new Error("should not run"); } };`,
    });
  });

  it("allows bundled plugin entry files that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const bundledDir = makeTempDir();
    const pluginDir = path.join(bundledDir, "hardlinked-bundled");
    mkdirSafe(pluginDir);

    const outsideDir = makeTempDir();
    const outsideEntry = path.join(outsideDir, "outside.cjs");
    fs.writeFileSync(
      outsideEntry,
      'module.exports = { id: "hardlinked-bundled", register() {} };',
      "utf-8",
    );
    const plugin = writePlugin({
      id: "hardlinked-bundled",
      body: 'module.exports = { id: "hardlinked-bundled", register() {} };',
      dir: pluginDir,
      filename: "index.cjs",
    });
    fs.rmSync(plugin.file);
    try {
      fs.linkSync(outsideEntry, plugin.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: bundledDir,
      config: {
        plugins: {
          entries: {
            "hardlinked-bundled": { enabled: true },
          },
          allow: ["hardlinked-bundled"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "hardlinked-bundled");
    expect(record?.status).toBe("loaded");
    expect(registry.diagnostics.some((entry) => entry.message.includes("unsafe plugin path"))).toBe(
      false,
    );
  });

  it("preserves runtime reflection semantics when runtime is lazily initialized", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    const plugin = writePlugin({
      id: "runtime-introspection",
      filename: "runtime-introspection.cjs",
      body: `module.exports = { id: "runtime-introspection", register(api) {
  const runtime = api.runtime ?? {};
  const keys = Object.keys(runtime);
  if (!keys.includes("channel")) {
    throw new Error("runtime channel key missing");
  }
  if (!("channel" in runtime)) {
    throw new Error("runtime channel missing from has check");
  }
  if (!Object.getOwnPropertyDescriptor(runtime, "channel")) {
    throw new Error("runtime channel descriptor missing");
  }
} };`,
    });

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: {
          allow: ["runtime-introspection"],
        },
        options: {
          onlyPluginIds: ["runtime-introspection"],
        },
      }),
    );

    const record = registry.plugins.find((entry) => entry.id === "runtime-introspection");
    expect(record?.status).toBe("loaded");
  });

  it("supports legacy plugins importing monolithic plugin-sdk root", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "legacy-root-import",
      filename: "legacy-root-import.cjs",
      body: `module.exports = {
  id: "legacy-root-import",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
        register() {},
      };`,
    });

    const registry = withEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins" }, () =>
      loadOpenClawPlugins({
        cache: false,
        workspaceDir: plugin.dir,
        config: {
          plugins: {
            load: { paths: [plugin.file] },
            allow: ["legacy-root-import"],
          },
        },
      }),
    );
    const record = registry.plugins.find((entry) => entry.id === "legacy-root-import");
    expect(record?.status).toBe("loaded");
  });

  it("supports legacy plugins subscribing to diagnostic events from the root sdk", async () => {
    useNoBundledPlugins();
    const seenKey = "__openclawLegacyRootDiagnosticSeen";
    delete (globalThis as Record<string, unknown>)[seenKey];

    const plugin = writePlugin({
      id: "legacy-root-diagnostic-listener",
      filename: "legacy-root-diagnostic-listener.cjs",
      body: `module.exports = {
  id: "legacy-root-diagnostic-listener",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
  register() {
    const { onDiagnosticEvent } = require("openclaw/plugin-sdk");
    if (typeof onDiagnosticEvent !== "function") {
      throw new Error("missing onDiagnosticEvent root export");
    }
    globalThis.${seenKey} = [];
    onDiagnosticEvent((event) => {
      globalThis.${seenKey}.push({
        type: event.type,
        sessionKey: event.sessionKey,
      });
    });
  },
};`,
    });

    try {
      const registry = withEnv(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins" },
        () =>
          loadOpenClawPlugins({
            cache: false,
            workspaceDir: plugin.dir,
            config: {
              plugins: {
                load: { paths: [plugin.file] },
                allow: ["legacy-root-diagnostic-listener"],
              },
            },
          }),
      );
      const record = registry.plugins.find(
        (entry) => entry.id === "legacy-root-diagnostic-listener",
      );
      expect(record?.status).toBe("loaded");

      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey: "agent:main:test:dm:peer",
        usage: { total: 1 },
      });

      expect((globalThis as Record<string, unknown>)[seenKey]).toEqual([
        {
          type: "model.usage",
          sessionKey: "agent:main:test:dm:peer",
        },
      ]);
    } finally {
      delete (globalThis as Record<string, unknown>)[seenKey];
    }
  });

  it("suppresses trust warning logs for non-activating snapshot loads", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const globalDir = path.join(stateDir, "extensions", "rogue");
      mkdirSafe(globalDir);
      writePlugin({
        id: "rogue",
        body: simplePluginBody("rogue"),
        dir: globalDir,
        filename: "index.cjs",
      });

      const warnings: string[] = [];
      const registry = loadOpenClawPlugins({
        activate: false,
        cache: false,
        logger: createWarningLogger(warnings),
        config: {
          plugins: {
            enabled: true,
          },
        },
      });

      expect(warnings).toEqual([]);
      expect(
        registry.diagnostics.some(
          (diag) =>
            diag.level === "warn" &&
            diag.pluginId === "rogue" &&
            diag.message.includes("loaded without install/load-path provenance"),
        ),
      ).toBe(true);
    });
  });

  it("loads source TypeScript plugins that route through local runtime shims", () => {
    const plugin = writePlugin({
      id: "source-runtime-shim",
      filename: "source-runtime-shim.ts",
      body: `import "./runtime-shim.ts";

export default {
  id: "source-runtime-shim",
  register() {},
};`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "runtime-shim.ts"),
      `import { helperValue } from "./helper.js";

export const runtimeValue = helperValue;`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(plugin.dir, "helper.ts"),
      `export const helperValue = "ok";`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["source-runtime-shim"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "source-runtime-shim");
    expect(record?.status).toBe("loaded");
  });

  it("converts Windows absolute import specifiers to file URLs only for module loading", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(__testing.toSafeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
      expect(__testing.toSafeImportPath("\\\\server\\share\\plugin\\index.mjs")).toBe(
        "file://server/share/plugin/index.mjs",
      );
      expect(__testing.toSafeImportPath("file:///C:/Users/alice/plugin/index.mjs")).toBe(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
      expect(__testing.toSafeImportPath("./relative/index.mjs")).toBe("./relative/index.mjs");
    } finally {
      platformSpy.mockRestore();
    }
  });
});
