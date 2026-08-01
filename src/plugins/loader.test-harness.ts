/** Broad plugin loader coverage for manifest discovery, runtime registration, and diagnostics. */
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { listRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import type { DetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime-contract.js";
import { withEnv } from "../test-utils/env.js";
import {
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
} from "./embedding-providers.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  mkdirSafe,
  type PluginRegistry,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { testing as runtimeRegistryLoaderTesting } from "./runtime/runtime-registry-loader.js";

export const getEmbeddingProvider = (id: string) => getRegisteredEmbeddingProvider(id)?.adapter;

export const listEmbeddingProviders = () =>
  listRegisteredEmbeddingProviders().map((entry) => entry.adapter);

export let cachedBundledTelegramDir = "";

let cachedBundledMemoryDir = "";

type GlobalHookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;

type PluginStartupTraceDetail = {
  name: string;
  metrics: ReadonlyArray<readonly [string, number | string]>;
};

export function listRegisteredAgentHarnessIdsForTest(): string[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness.id);
}

export function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

export function expectGlobalHookRunner(
  runner: ReturnType<typeof getGlobalHookRunner>,
): GlobalHookRunner {
  if (runner === null) {
    throw new Error("Expected global hook runner");
  }
  expect(typeof runner.hasHooks).toBe("function");
  return runner;
}

export function createDetachedTaskRuntimeStub(id: string): DetachedTaskLifecycleRuntime {
  const fail = (name: string): never => {
    throw new Error(`detached runtime ${id} should not execute ${name} in this test`);
  };
  return {
    createQueuedTaskRun: () => fail("createQueuedTaskRun"),
    createRunningTaskRun: () => fail("createRunningTaskRun"),
    startTaskRunByRunId: () => fail("startTaskRunByRunId"),
    recordTaskRunProgressByRunId: () => fail("recordTaskRunProgressByRunId"),
    finalizeTaskRunByRunId: () => fail("finalizeTaskRunByRunId"),
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

export function simplePluginBody(id: string) {
  return `module.exports = { id: ${JSON.stringify(id)}, register() {} };`;
}

export function updatePluginManifest(
  plugin: Pick<TempPlugin, "dir">,
  patch: Record<string, unknown>,
) {
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify({ ...raw, ...patch }, null, 2), "utf-8");
}

export function memoryPluginBody(id: string) {
  return `module.exports = { id: ${JSON.stringify(id)}, kind: "memory", register() {} };`;
}

export function setupBundledDreamingMemoryPlugins(params?: {
  selectedId?: string;
  selectedKind?: unknown;
  coreBody?: string;
}) {
  const selectedId = params?.selectedId ?? "memory-lancedb";
  const bundledDir = makeTempDir();
  const memoryCoreDir = path.join(bundledDir, "memory-core");
  const selectedMemoryDir = path.join(bundledDir, selectedId);
  mkdirSafe(memoryCoreDir);
  mkdirSafe(selectedMemoryDir);
  writePlugin({
    id: "memory-core",
    dir: memoryCoreDir,
    filename: "index.cjs",
    body: params?.coreBody ?? memoryPluginBody("memory-core"),
  });
  writePlugin({
    id: selectedId,
    dir: selectedMemoryDir,
    filename: "index.cjs",
    body:
      params?.selectedKind === "utility"
        ? `module.exports = { id: ${JSON.stringify(selectedId)}, kind: "utility", register() {} };`
        : memoryPluginBody(selectedId),
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
    path.join(selectedMemoryDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: selectedId,
        kind: params?.selectedKind ?? "memory",
        configSchema: openSchema,
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
  return { bundledDir, selectedId };
}

export const RESERVED_ADMIN_PLUGIN_METHOD = "config.plugin.inspect";

export const RESERVED_ADMIN_SCOPE_WARNING =
  "gateway method scope coerced to operator.admin for reserved core namespace";

export function writeBundledPlugin(params: {
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
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
  return { bundledDir, plugin };
}

export function makeOpenClawDevSourceRoot() {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf-8");
  mkdirSafe(path.join(root, "src"));
  mkdirSafe(path.join(root, "extensions"));
  return root;
}

export function writeWorkspacePlugin(params: {
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

export function withStateDir<T>(run: (stateDir: string) => T) {
  const stateDir = makeTempDir();
  return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => run(stateDir));
}

export function loadBundledMemoryPluginRegistry(options?: {
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

export function setupBundledTelegramPlugin() {
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

export function expectTelegramLoaded(registry: ReturnType<typeof loadOpenClawPlugins>) {
  const telegram = registry.plugins.find((entry) => entry.id === "telegram");
  expect(telegram?.status).toBe("loaded");
  expect(registry.channels.map((entry) => entry.plugin.id)).toContain("telegram");
}

export function loadRegistryFromSinglePlugin(params: {
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

export function loadRegistryFromAllowedPlugins(
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

export function runRegistryScenarios<
  T extends { assert: (registry: PluginRegistry, scenario: T) => void },
>(scenarios: readonly T[], loadRegistry: (scenario: T) => PluginRegistry) {
  for (const scenario of scenarios) {
    scenario.assert(loadRegistry(scenario), scenario);
  }
}

export function runScenarioCases<T>(scenarios: readonly T[], run: (scenario: T) => void) {
  for (const scenario of scenarios) {
    run(scenario);
  }
}

export function runSinglePluginRegistryScenarios<
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

export function loadRegistryFromScenarioPlugins(plugins: readonly TempPlugin[]) {
  return plugins.length === 1
    ? loadRegistryFromSinglePlugin({
        plugin: expectDefined(plugins[0], "plugins[0] test invariant"),
        pluginConfig: {
          allow: [expectDefined(plugins[0], "plugins[0] test invariant").id],
        },
      })
    : loadRegistryFromAllowedPlugins([...plugins]);
}

export function expectOpenAllowWarnings(params: {
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

export function expectLoadedPluginProvenance(params: {
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
        msg.includes("OpenClaw can't verify where this plugin came from"),
    ),
    params.scenario.label,
  ).toBe(params.expectWarning);
}

export function expectRegisteredHttpRoute(
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
  if (!route) {
    throw new Error(`expected http route for ${scenario.label}`);
  }
  expect(route.path, scenario.label).toBe(scenario.expectedPath);
  expect(route.auth, scenario.label).toBe(scenario.expectedAuth);
  expect(route.match, scenario.label).toBe(scenario.expectedMatch);
  const httpPlugin = registry.plugins.find((entry) => entry.id === scenario.pluginId);
  expect(httpPlugin?.httpRoutes, scenario.label).toBe(1);
}

export function expectDuplicateRegistrationResult(
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

export function expectPluginSourcePrecedence(
  registry: PluginRegistry,
  scenario: {
    pluginId: string;
    expectedLoadedOrigin: string;
    expectedDisabledOrigin: string;
    label: string;
    expectedDisabledError?: string;
    expectDuplicateWarning?: boolean;
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
  const hasDuplicateWarning = registry.diagnostics.some(
    (diag) =>
      diag.level === "warn" &&
      diag.pluginId === scenario.pluginId &&
      diag.message.includes(expectedWarning),
  );
  expect(hasDuplicateWarning, scenario.label).toBe(scenario.expectDuplicateWarning ?? true);
}

export function expectPluginOriginAndStatus(params: {
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

export function expectRegistryErrorDiagnostic(params: {
  registry: PluginRegistry;
  pluginId: string;
  message: string;
}) {
  const diagnostic = params.registry.diagnostics.find(
    (entry) =>
      entry.level === "error" &&
      entry.pluginId === params.pluginId &&
      entry.message === params.message,
  );
  if (!diagnostic) {
    throw new Error(`Expected registry error diagnostic: ${params.message}`);
  }
}

export function expectDiagnosticContaining(params: {
  registry: PluginRegistry;
  message: string;
  level?: string;
  pluginId?: string;
}) {
  const diagnostic = params.registry.diagnostics.find(
    (entry) =>
      (!params.level || entry.level === params.level) &&
      (!params.pluginId || entry.pluginId === params.pluginId) &&
      entry.message.includes(params.message),
  );
  if (!diagnostic) {
    throw new Error(`Expected diagnostic containing: ${params.message}`);
  }
}

export function expectNoDiagnosticContaining(params: {
  registry: PluginRegistry;
  message: string;
  level?: string;
  pluginId?: string;
}) {
  const diagnostic = params.registry.diagnostics.find(
    (entry) =>
      (!params.level || entry.level === params.level) &&
      (!params.pluginId || entry.pluginId === params.pluginId) &&
      entry.message.includes(params.message),
  );
  expect(diagnostic, params.message).toBeUndefined();
}

export function createWarningLogger(warnings: string[]) {
  return {
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
  };
}

export function createErrorLogger(errors: string[]) {
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

export function expectCachePartitionByPluginSource(params: {
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

export function expectCacheMissThenHit(params: {
  loadFirst: () => ReturnType<typeof loadOpenClawPlugins>;
  loadVariant: () => ReturnType<typeof loadOpenClawPlugins>;
}) {
  const first = params.loadFirst();
  const second = params.loadVariant();
  const third = params.loadVariant();

  expect(second).not.toBe(first);
  expect(third).toBe(second);
}

export function createSetupEntryChannelPluginFixture(params: {
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
  bundledSetupRuntimeRoutePath?: string;
  bundledSetupRuntimeRegisterError?: string;
  bundledSetupRuntimeLateRoutePath?: string;
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
	  ${
      params.bundledSetupRuntimeRoutePath
        ? `registerSetupRuntime: (api) => {
	    api.registerHttpRoute({
	      path: ${JSON.stringify(params.bundledSetupRuntimeRoutePath)},
	      auth: "plugin",
	      handler: async () => true,
	    });
	    ${
        params.bundledSetupRuntimeRegisterError
          ? `throw new Error(${JSON.stringify(params.bundledSetupRuntimeRegisterError)});`
          : ""
      }
	    ${
        params.bundledSetupRuntimeLateRoutePath
          ? `queueMicrotask(() => {
	      api.registerHttpRoute({
	        path: ${JSON.stringify(params.bundledSetupRuntimeLateRoutePath)},
	        auth: "plugin",
	        handler: async () => true,
	      });
	    });`
          : ""
      }
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
  ${
    params.bundledSetupRuntimeMarker
      ? `setChannelRuntime: () => {
    require("node:fs").writeFileSync(${JSON.stringify(params.bundledSetupRuntimeMarker)}, "loaded", "utf-8");
  },`
      : ""
  }
};`,
    "utf-8",
  );

  return { pluginDir, fullMarker, setupMarker };
}

export function createEnvResolvedPluginFixture(pluginId: string) {
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

export function expectEscapingEntryRejected(params: {
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
  expectDiagnosticContaining({ registry, message: "escapes" });
  return registry;
}

export function createStartupTraceRecorder(): {
  details: PluginStartupTraceDetail[];
  startupTrace: NonNullable<PluginLoadOptions["startupTrace"]>;
} {
  const details: PluginStartupTraceDetail[] = [];
  return {
    details,
    startupTrace: {
      detail: (name, metrics) => {
        details.push({ name, metrics });
      },
    },
  };
}

export function collectStartupTraceMetrics(
  details: readonly PluginStartupTraceDetail[],
  name: string,
): Record<string, number | string> {
  const matched = details.filter((entry) => entry.name === name);
  expect(matched.length).toBeGreaterThan(0);
  const metrics: Record<string, number | string> = {};
  for (const entry of matched) {
    for (const [key, value] of entry.metrics) {
      metrics[key] = value;
    }
  }
  return metrics;
}

export const globalAfterEach0 = () => {
  resetDiagnosticEventsForTest();
  clearRuntimeConfigSnapshot();
  runtimeRegistryLoaderTesting.resetPluginRegistryLoadedForTests();
  resetPluginLoaderTestStateForTest();
};

export const globalAfterAll1 = () => {
  cleanupPluginLoaderFixturesForTest();
  cachedBundledTelegramDir = "";
  cachedBundledMemoryDir = "";
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
