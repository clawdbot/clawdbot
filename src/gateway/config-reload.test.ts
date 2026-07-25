// Gateway config reload tests cover changed-path detection, reload planning,
// plugin registry refresh, skill snapshot invalidation, and watcher behavior.
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { prepareConfigRuntimeEnv } from "../config/config-env-vars.js";
import { fingerprintConfigSnapshotAuthoredConfig } from "../config/config-journal-snapshot.js";
import type {
  ConfigFileSnapshot,
  ConfigWriteNotification,
  OpenClawConfig,
} from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffConfigPaths, diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  resolveConfigReloadMetadata,
} from "./config-reload-plan.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import {
  type GatewayConfigReloadTransactionOwnership,
  type GatewayReloadPlan,
  startGatewayConfigReloader,
} from "./config-reload.js";
import { createTerminalLaunchPolicy } from "./terminal/launch.js";

const configAuditMocks = vi.hoisted(() => ({
  append: vi.fn(),
  readSnapshot: vi.fn(),
  readLatestSnapshot: vi.fn(),
  upsertSnapshot: vi.fn(),
}));

vi.mock("../config/io.audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.audit.js")>();
  return {
    ...actual,
    appendConfigAuditRecordSync: configAuditMocks.append,
  };
});

vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config-journal-snapshot.js")>();
  return {
    ...actual,
    readConfigSnapshotAuditRecord: configAuditMocks.readSnapshot,
    readLatestConfigSnapshotAuditRecord: configAuditMocks.readLatestSnapshot,
    upsertConfigSnapshotAuditRecord: configAuditMocks.upsertSnapshot,
  };
});

beforeEach(() => {
  configAuditMocks.append.mockReset();
  configAuditMocks.readSnapshot.mockReset().mockReturnValue(null);
  // Unfiltered reads delegate to the filtered mock with the harness watch path
  // so slot fixtures seeded via readSnapshot serve both accessors.
  configAuditMocks.readLatestSnapshot
    .mockReset()
    .mockImplementation(() => configAuditMocks.readSnapshot({ configPath: "/tmp/openclaw.json" }));
  configAuditMocks.upsertSnapshot.mockReset();
});

describe("diffConfigPaths", () => {
  it("captures nested config changes", () => {
    const prev = { hooks: { gmail: { account: "a" } } };
    const next = { hooks: { gmail: { account: "b" } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("hooks.gmail.account");
  });

  it("captures array changes", () => {
    const prev = { messages: { groupChat: { mentionPatterns: ["a"] } } };
    const next = { messages: { groupChat: { mentionPatterns: ["b"] } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("messages.groupChat.mentionPatterns");
  });

  it("does not report unchanged arrays of objects as changed", () => {
    const prev = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
          scope: {
            rules: [{ when: { channel: "slack" }, include: ["docs"] }],
          },
        },
      },
    };
    const next = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
          scope: {
            rules: [{ when: { channel: "slack" }, include: ["docs"] }],
          },
        },
      },
    };
    expect(diffConfigPaths(prev, next)).toStrictEqual([]);
  });

  it("reports changed arrays of objects", () => {
    const prev = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
        },
      },
    };
    const next = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.txt", name: "docs" }],
        },
      },
    };
    expect(diffConfigPaths(prev, next)).toContain("memory.qmd.paths");
  });

  it("collapses changed agents.list heartbeat entries to agents.list", () => {
    const prev = {
      agents: {
        list: [{ id: "ops", heartbeat: { every: "5m", lightContext: false } }],
      },
    };
    const next = {
      agents: {
        list: [{ id: "ops", heartbeat: { every: "5m", lightContext: true } }],
      },
    };

    expect(diffConfigPaths(prev, next)).toEqual(["agents.list"]);
  });

  it("can emit duplicate path strings for install timestamp and dotted install id add", () => {
    const prev = {
      plugins: {
        installs: {
          lossless: { source: "npm", resolvedAt: "2026-04-22T00:00:00.000Z" },
        },
      },
    };
    const next = {
      plugins: {
        installs: {
          lossless: { source: "npm", resolvedAt: "2026-04-22T00:01:00.000Z" },
          "lossless.resolvedAt": { source: "npm" },
        },
      },
    };

    expect(diffConfigPaths(prev, next)).toEqual([
      "plugins.installs.lossless.resolvedAt",
      "plugins.installs.lossless.resolvedAt",
    ]);
  });

  it.each([
    { prev: {}, next: { mcp: { apps: { enabled: true } } } },
    { prev: { mcp: { apps: { enabled: true } } }, next: {} },
  ])("preserves the Apps restart boundary for whole MCP changes", ({ prev, next }) => {
    const changedPaths = diffGatewayReloadPaths(prev, next);
    expect(changedPaths).toEqual(["mcp", "mcp.apps"]);
    expect(buildGatewayReloadPlan(changedPaths).restartReasons).toContain("mcp.apps");
  });
});

describe("buildGatewayReloadPlan", () => {
  const emptyRegistry = createTestRegistry([]);
  const telegramPlugin: ChannelPlugin = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["channels.telegram"] },
  };
  const whatsappPlugin: ChannelPlugin = {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: {
      configPrefixes: ["web", "channels.whatsapp.accounts", "channels.whatsapp.selfChatMode"],
      noopPrefixes: ["channels.whatsapp"],
    },
  };
  const mattermostPlugin: ChannelPlugin = {
    id: "mattermost",
    meta: {
      id: "mattermost",
      label: "Mattermost",
      selectionLabel: "Mattermost",
      docsPath: "/channels/mattermost",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: (cfg) => Object.keys(cfg.channels?.mattermost?.accounts ?? {}),
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["channels.mattermost"], accountScopedRestart: true },
  };
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    { pluginId: "mattermost", plugin: mattermostPlugin, source: "test" },
  ]);
  registry.reloads = [
    {
      pluginId: "browser",
      pluginName: "Browser",
      registration: { restartPrefixes: ["browser"], hotPrefixes: ["browser.profiles"] },
      source: "test",
    },
    {
      pluginId: "canvas",
      pluginName: "Canvas",
      registration: { restartPrefixes: ["plugins.entries.canvas"] },
      source: "test",
    },
  ];

  beforeEach(() => {
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(emptyRegistry);
  });

  it.each([
    {
      path: "mcp.apps.enabled",
      restart: true,
      reason: "mcp.apps.enabled",
    },
    {
      path: "gateway.auth.token",
      restart: true,
      reason: "gateway.auth.token",
    },
    {
      path: "models.pricing.enabled",
      restart: true,
      reason: "models.pricing.enabled",
    },
    {
      path: "agents.defaults.model",
      restart: false,
      hot: "agents.defaults.model",
      restartHeartbeat: true,
    },
    {
      path: "unknownField",
      restart: true,
      reason: "unknownField",
    },
  ])("classifies reload path: $path", (testCase) => {
    const plan = buildGatewayReloadPlan([testCase.path]);
    expect(plan.restartGateway).toBe(testCase.restart);
    if (testCase.reason) {
      expect(plan.restartReasons).toContain(testCase.reason);
    }
    if (testCase.hot) {
      expect(plan.hotReasons).toContain(testCase.hot);
      expect(resolveConfigReloadMetadata(testCase.path).kind).toBe("hot");
    }
    if (testCase.restartHeartbeat) {
      expect(plan.restartHeartbeat).toBe(true);
    }
  });

  it.each([
    "gateway.port",
    "gateway.terminal.enabled",
    "browser.enabled",
    "plugins.installs.telegram.installPath",
    "plugins.load.paths.0",
    "gateway.auth.mode",
  ])("keeps restart-owned path restart-backed: %s", (path) => {
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual([path]);
    expect(plan.hotReasons).toStrictEqual([]);
  });

  it.each([
    {
      path: "hooks.gmail.account",
      expected: { restartGmailWatcher: true, reloadHooks: true },
    },
    {
      path: "mcp.servers.context7.command",
      expected: { disposeMcpRuntimes: true },
    },
    {
      path: "models.providers.openai.models",
      expected: { restartHeartbeat: true },
    },
    {
      path: "agents.defaults.models",
      expected: { restartHeartbeat: true },
    },
    {
      path: "agents.defaults.modelPolicy.allow",
      expected: { restartHeartbeat: true },
    },
    {
      path: "agents.list",
      expected: { restartHeartbeat: true },
    },
    {
      path: "plugins.entries.lossless-claw.config.mode",
      expected: { reloadPlugins: true, disposeMcpRuntimes: true },
    },
  ])("keeps hot-reload actions for $path", ({ path, expected }) => {
    const plan = buildGatewayReloadPlan([path]);

    expect(plan).toMatchObject({
      restartGateway: false,
      restartReasons: [],
      hotReasons: [path],
      noopPaths: [],
      ...expected,
    });
  });

  it.each(["gateway.remote.url", "secrets.providers.default.path", "tui.footer.showRemoteHost"])(
    "keeps runtime-irrelevant path as a no-op: %s",
    (path) => {
      const plan = buildGatewayReloadPlan([path]);

      expect(plan.restartGateway).toBe(false);
      expect(plan.restartReasons).toStrictEqual([]);
      expect(plan.hotReasons).toStrictEqual([]);
      expect(plan.noopPaths).toEqual([path]);
    },
  );

  it("treats plugin install timestamp-only changes as no-ops", () => {
    const paths = [
      "plugins.installs.lossless-claw.resolvedAt",
      "plugins.installs.lossless-claw.installedAt",
    ];
    const plan = buildGatewayReloadPlan(paths);

    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toEqual(paths);
    for (const path of paths) {
      expect(resolveConfigReloadMetadata(path).kind).toBe("none");
    }
  });

  it("restarts for forced whole-record plugin install changes", () => {
    const path = "plugins.installs.lossless.resolvedAt";
    const plan = buildGatewayReloadPlan([path, path], {
      noopPaths: [path],
      forceChangedPaths: [path],
    });

    expect(plan.restartGateway).toBe(true);
    expect(plan.reloadPlugins).toBe(false);
    expect(plan.disposeMcpRuntimes).toBe(false);
    expect(plan.restartReasons).toEqual([path, path]);
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("restarts the matching channel for channel config changes", () => {
    const plan = buildGatewayReloadPlan(["channels.telegram.botToken"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["telegram"]));
  });

  const mattermostAccountConfig = {
    channels: {
      mattermost: {
        accounts: {
          alpha: { enabled: true },
          beta: { enabled: true },
        },
      },
    },
  } as OpenClawConfig;

  it.each([
    {
      label: "targets changed named accounts",
      paths: [
        "channels.mattermost.accounts.alpha.enabled",
        "channels.mattermost.accounts.beta.commands",
      ],
      expectedChannels: new Set<ChannelKind>(),
      expectedAccounts: new Map<ChannelKind, Set<string>>([
        ["mattermost", new Set(["alpha", "beta"])],
      ]),
    },
    {
      label: "promotes accounts.default changes",
      paths: ["channels.mattermost.accounts.default.commands"],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
    {
      label: "promotes channel-global changes",
      paths: ["channels.mattermost.botToken"],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
    {
      label: "promotes unlisted account changes",
      paths: ["channels.mattermost.accounts.removed.enabled"],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
    {
      label: "lets an unlisted account replace earlier scoped targets",
      paths: [
        "channels.mattermost.accounts.alpha.enabled",
        "channels.mattermost.accounts.removed.enabled",
      ],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
    {
      label: "lets a mixed global change replace scoped targets",
      paths: ["channels.mattermost.accounts.alpha.enabled", "channels.mattermost.botToken"],
      expectedChannels: new Set<ChannelKind>(["mattermost"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
    {
      label: "keeps non-opted-in channels wholesale",
      paths: ["channels.telegram.accounts.alpha.enabled"],
      expectedChannels: new Set<ChannelKind>(["telegram"]),
      expectedAccounts: new Map<ChannelKind, Set<string>>(),
    },
  ])("$label", ({ paths, expectedChannels, expectedAccounts }) => {
    const plan = buildGatewayReloadPlan(paths, { candidateConfig: mattermostAccountConfig });

    expect(plan.restartChannels).toEqual(expectedChannels);
    expect(plan.restartChannelAccounts).toEqual(expectedAccounts);
  });

  it("restarts every channel whose config prefix matches", () => {
    const plan = buildGatewayReloadPlan(["web.enabled", "channels.telegram.botToken"]);

    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["whatsapp", "telegram"]));
  });

  it("prefers a specific hot rule under a broad restart prefix", () => {
    const path = "browser.profiles.sandbox.cdpUrl";
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(false);
    expect(plan.restartReasons).toStrictEqual([]);
    expect(plan.hotReasons).toEqual([path]);
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("keeps Gateway reload policy when an agent activates a scoped registry", () => {
    pinActivePluginHttpRouteRegistry(registry);
    setActivePluginRegistry(emptyRegistry);

    const path = "browser.profiles.sandbox.cdpUrl";
    expect(buildGatewayReloadPlan([path])).toMatchObject({
      restartGateway: false,
      hotReasons: [path],
    });
  });

  it("prefers channel restart prefixes over a broad no-op prefix", () => {
    const changedPaths = [
      "channels.whatsapp.accounts.default.enabled",
      "channels.whatsapp.selfChatMode",
    ];
    const plan = buildGatewayReloadPlan(changedPaths);

    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["whatsapp"]));
    expect(plan.hotReasons).toEqual(changedPaths);
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("keeps unrelated channel paths as no-ops", () => {
    const path = "channels.whatsapp.replyToMode";
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set());
    expect(plan.noopPaths).toEqual([path]);
  });

  it("refreshes channel rules when the tracked channel registry changes", () => {
    const channelOnlyRegistry = createTestRegistry([
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]);

    setActivePluginRegistry(emptyRegistry);
    expect(buildGatewayReloadPlan(["channels.telegram.botToken"])).toMatchObject({
      restartGateway: true,
      restartChannels: new Set(),
    });

    pinActivePluginChannelRegistry(channelOnlyRegistry);
    expect(buildGatewayReloadPlan(["channels.telegram.botToken"])).toMatchObject({
      restartGateway: false,
      restartChannels: new Set(["telegram"]),
    });
  });

  it("reloads loaded channel plugins when plugin entry state changes", () => {
    const plan = buildGatewayReloadPlan(["plugins.entries.telegram.enabled"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.disposeMcpRuntimes).toBe(true);
    expect(plan.restartChannels).toEqual(new Set(["telegram"]));
  });

  it("keeps restart-owned plugin paths ahead of the generic plugin hot rule", () => {
    const path = "plugins.entries.canvas.enabled";
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual([path]);
    expect(plan.hotReasons).toStrictEqual([]);
  });

  it("uses default reload settings when config is unset", () => {
    expect(resolveGatewayReloadSettings({})).toMatchObject({ mode: "hybrid", debounceMs: 300 });
  });
});

type WatcherHandler = (value?: unknown) => void;
type WatcherEvent = "add" | "change" | "unlink" | "error" | "ready";
const WATCHER_PATH_EVENTS = new Set<WatcherEvent>(["add", "change", "unlink"]);

function createWatcherMock(effectiveUsePolling?: boolean) {
  const handlers = new Map<WatcherEvent, WatcherHandler[]>();
  const watcher = {
    effectiveUsePolling,
    options: { usePolling: false },
    on(event: WatcherEvent, handler: WatcherHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return this;
    },
    emit(event: WatcherEvent, value?: unknown) {
      const eventValue =
        value ?? (WATCHER_PATH_EVENTS.has(event) ? "/tmp/openclaw.json" : undefined);
      for (const handler of handlers.get(event) ?? []) {
        handler(eventValue);
      }
    },
    close: vi.fn(async () => {}),
  };
  return watcher;
}

function makeSnapshot(partial: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  const config = partial.config ?? {};
  const sourceConfig = (partial.sourceConfig ??
    partial.config ??
    {}) as ConfigFileSnapshot["sourceConfig"];
  const runtimeConfig = partial.runtimeConfig ?? partial.config ?? {};
  return {
    path: "/tmp/openclaw.json",
    includedPaths: [],
    exists: true,
    raw: "{}",
    parsed: {},
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...partial,
  };
}

function makeZeroDebounceHookSnapshot(hash: string): ConfigFileSnapshot {
  return makeSnapshot({
    sourceConfig: {
      gateway: { reload: {} },
      hooks: { enabled: true },
    },
    runtimeConfig: {
      gateway: { reload: {} },
      hooks: { enabled: true },
    },
    config: {
      gateway: { reload: {} },
      hooks: { enabled: true },
    },
    hash,
  });
}

function makeZeroDebounceHookWrite(persistedHash: string): ConfigWriteNotification {
  return {
    configPath: "/tmp/openclaw.json",
    sourceConfig: { gateway: { reload: {} }, hooks: { enabled: true } },
    runtimeConfig: {
      gateway: { reload: {} },
      hooks: { enabled: true },
    },
    persistedHash,
    revision: 1,
    fingerprint: `runtime-${persistedHash}`,
    sourceFingerprint: `source-${persistedHash}`,
    writtenAtMs: Date.now(),
  };
}

function createReloaderHarness(
  readSnapshot: () => Promise<ConfigFileSnapshot>,
  options: {
    initialConfig?: OpenClawConfig;
    initialCompareConfig?: OpenClawConfig;
    initialSnapshotRawHash?: string | null;
    initialAuthoredConfig?: unknown;
    initialIncludedPaths?: readonly string[];
    initialSnapshotValid?: boolean;
    initialSnapshotIssues?: ConfigFileSnapshot["issues"];
    prepareConfigCandidate?: (params: {
      runtimeConfig: OpenClawConfig;
      sourceConfig: OpenClawConfig;
      previousSourceConfig: OpenClawConfig;
    }) => {
      runtimeConfig: OpenClawConfig;
      compareConfig: OpenClawConfig;
      runtimeEnv?: ReturnType<typeof prepareConfigRuntimeEnv>;
    };
    initialInternalWriteHash?: string | null;
    promoteSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
    initialPluginInstallRecords?: Record<string, PluginInstallRecord>;
    readPluginInstallRecords?: () => Promise<Record<string, PluginInstallRecord>>;
    runTransaction?: <T>(run: () => Promise<T>) => Promise<T>;
    onConfigCandidateObserved?: () => void;
    onConfigAccepted?: (
      nextConfig: OpenClawConfig,
      ownership: GatewayConfigReloadTransactionOwnership,
      sourceConfig: OpenClawConfig,
      acceptance: {
        runtimeApplied: boolean;
        publishSource?: () => Promise<() => Promise<void>>;
      },
    ) => void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>;
    onEffectiveConfigUnchanged?: (
      nextConfig: OpenClawConfig,
      ownership: GatewayConfigReloadTransactionOwnership,
      sourceConfig: OpenClawConfig,
    ) => Promise<{ rollback: () => Promise<void>; commit?: () => void }>;
    onConfigApplied?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
    onConfigRevisionApplied?: (hash: string) => void;
    onConfigChange?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
    onNoopConfigCommit?: (
      plan: GatewayReloadPlan,
      nextConfig: OpenClawConfig,
      ownership: GatewayConfigReloadTransactionOwnership,
      sourceConfig: OpenClawConfig,
    ) => Promise<void>;
    onHotReload?: (
      plan: GatewayReloadPlan,
      nextConfig: OpenClawConfig,
      ownership: GatewayConfigReloadTransactionOwnership,
      sourceConfig: OpenClawConfig,
    ) => Promise<void>;
    onRestart?: (
      plan: GatewayReloadPlan,
      nextConfig: OpenClawConfig,
      ownership: GatewayConfigReloadTransactionOwnership,
      sourceConfig: OpenClawConfig,
    ) => void | Promise<void>;
  } = {},
) {
  const watcher = createWatcherMock();
  vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
  const onConfigChange = vi.fn(
    options.onConfigChange ?? (async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {}),
  );
  const onConfigApplied = vi.fn(
    options.onConfigApplied ??
      (async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {}),
  );
  const onConfigAccepted = vi.fn(options.onConfigAccepted ?? (async () => {}));
  const onConfigRevisionApplied = vi.fn(options.onConfigRevisionApplied ?? (() => {}));
  const onEffectiveConfigUnchanged = vi.fn(
    options.onEffectiveConfigUnchanged ?? (async () => ({ rollback: async () => {} })),
  );
  const onNoopConfigCommit = vi.fn(
    options.onNoopConfigCommit ??
      (async (
        _plan: GatewayReloadPlan,
        _nextConfig: OpenClawConfig,
        _ownership: GatewayConfigReloadTransactionOwnership,
      ) => {}),
  );
  const onHotReload = vi.fn(
    options.onHotReload ??
      (async (
        _plan: GatewayReloadPlan,
        _nextConfig: OpenClawConfig,
        _ownership: GatewayConfigReloadTransactionOwnership,
      ) => {}),
  );
  const onRestart = vi.fn(
    options.onRestart ?? ((_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {}),
  );
  const onConfigCandidateCommitted = vi.fn(
    (_info: { path: string; persistedHash: string | null; changedPaths: readonly string[] }) => {},
  );
  let writeListener: ((event: ConfigWriteNotification) => void) | null = null;
  const subscribeToWrites = vi.fn((listener: (event: ConfigWriteNotification) => void) => {
    writeListener = listener;
    return () => {
      if (writeListener === listener) {
        writeListener = null;
      }
    };
  });
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const initialConfig = options.initialConfig ?? { gateway: { reload: {} } };
  const reloader = startGatewayConfigReloader({
    testDebounceMs: 0,
    initialConfig,
    initialCompareConfig: options.initialCompareConfig,
    initialSnapshotRawHash:
      options.initialSnapshotRawHash === undefined
        ? "initial-raw-hash"
        : options.initialSnapshotRawHash,
    initialAuthoredConfig: options.initialAuthoredConfig ?? initialConfig,
    initialIncludedPaths: options.initialIncludedPaths,
    initialSnapshotValid: options.initialSnapshotValid ?? true,
    initialSnapshotIssues: options.initialSnapshotIssues ?? [],
    ...(options.prepareConfigCandidate
      ? { prepareConfigCandidate: options.prepareConfigCandidate }
      : {}),
    initialInternalWriteHash: options.initialInternalWriteHash,
    readSnapshot,
    promoteSnapshot: options.promoteSnapshot,
    initialPluginInstallRecords: options.initialPluginInstallRecords ?? {},
    readPluginInstallRecords: options.readPluginInstallRecords ?? (async () => ({})),
    subscribeToWrites,
    ...(options.onConfigCandidateObserved
      ? { onConfigCandidateObserved: options.onConfigCandidateObserved }
      : {}),
    onConfigChange,
    onConfigApplied,
    onConfigRevisionApplied,
    onConfigAccepted,
    onEffectiveConfigUnchanged,
    onNoopConfigCommit,
    onHotReload,
    onRestart,
    onConfigCandidateCommitted,
    ...(options.runTransaction ? { runTransaction: options.runTransaction } : {}),
    log,
    watchPath: "/tmp/openclaw.json",
  });
  return {
    watcher,
    onConfigChange,
    onConfigApplied,
    onConfigRevisionApplied,
    onConfigAccepted,
    onEffectiveConfigUnchanged,
    onNoopConfigCommit,
    onHotReload,
    onRestart,
    onConfigCandidateCommitted,
    log,
    reloader,
    emitWrite(event: ConfigWriteNotification) {
      writeListener?.(event);
    },
  };
}

type ReloaderHarness = ReturnType<typeof createReloaderHarness>;

function getOnlyRestartCall(harness: ReloaderHarness): [GatewayReloadPlan, OpenClawConfig] {
  expect(harness.onRestart).toHaveBeenCalledTimes(1);
  const call = harness.onRestart.mock.calls[0];
  if (!call) {
    throw new Error("expected one restart call");
  }
  return [call[0], call[1]];
}

function getOnlyHotReloadCall(harness: ReloaderHarness): [GatewayReloadPlan, OpenClawConfig] {
  expect(harness.onHotReload).toHaveBeenCalledTimes(1);
  const call = harness.onHotReload.mock.calls[0];
  if (!call) {
    throw new Error("expected one hot reload call");
  }
  return [call[0], call[1]];
}

describe("startGatewayConfigReloader include files", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads when an included config file changes", async () => {
    const rootDir = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "openclaw-config-reload-")),
    );
    const configPath = nodePath.join(rootDir, "openclaw.json5");
    const includePath = nodePath.join(rootDir, "hooks.json5");
    const includeLinkPath = nodePath.join(rootDir, "hooks-link.json5");
    const nestedIncludePath = nodePath.join(rootDir, "hooks-enabled.json5");
    await writeFile(
      configPath,
      `${JSON.stringify({ gateway: { reload: { mode: "hybrid" } }, hooks: { $include: "./hooks-link.json5" } }, null, 2)}\n`,
    );
    await writeFile(
      includePath,
      `${JSON.stringify({ $include: "./hooks-enabled.json5" }, null, 2)}\n`,
    );
    await writeFile(nestedIncludePath, `${JSON.stringify({ enabled: true }, null, 2)}\n`);
    await symlink(includePath, includeLinkPath);
    const configIo = createConfigIO({
      configPath,
      env: {},
      homedir: () => rootDir,
      observe: false,
      pluginValidation: "skip",
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const initialSnapshot = await configIo.readConfigFileSnapshot();
    const onHotReload = vi.fn(async () => {});
    let signalWatcherReady!: () => void;
    const watcherReady = new Promise<void>((resolve) => {
      signalWatcherReady = resolve;
    });
    const reloader = startGatewayConfigReloader({
      initialConfig: initialSnapshot.config,
      initialCompareConfig: initialSnapshot.sourceConfig,
      initialSnapshotRawHash: initialSnapshot.hash ?? null,
      initialAuthoredConfig: initialSnapshot.parsed,
      initialIncludedPaths: initialSnapshot.includedPaths,
      initialSnapshotValid: initialSnapshot.valid,
      initialSnapshotIssues: initialSnapshot.issues,
      testDebounceMs: 0,
      onWatcherReady: signalWatcherReady,
      readSnapshot: async () => await configIo.readConfigFileSnapshot(),
      initialPluginInstallRecords: {},
      readPluginInstallRecords: async () => ({}),
      onNoopConfigCommit: async () => {},
      onHotReload,
      onRestart: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      watchPath: configPath,
    });

    try {
      expect(initialSnapshot.includedPaths).toEqual(
        [
          includeLinkPath,
          await realpath(includePath),
          await realpath(nestedIncludePath),
        ].toSorted(),
      );
      await watcherReady;
      await writeFile(nestedIncludePath, `${JSON.stringify({ enabled: false }, null, 2)}\n`);
      await vi.waitFor(() => expect(onHotReload).toHaveBeenCalledOnce(), { timeout: 5000 });
    } finally {
      await reloader.stop();
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("keeps a lexically safe rejected include path watchable", async () => {
    const rootDir = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "openclaw-config-reload-")),
    );
    const outsideDir = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "openclaw-config-outside-")),
    );
    const configPath = nodePath.join(rootDir, "openclaw.json5");
    const includeLinkPath = nodePath.join(rootDir, "hooks-link.json5");
    const outsideIncludePath = nodePath.join(outsideDir, "hooks.json5");
    await writeFile(configPath, `${JSON.stringify({ $include: "./hooks-link.json5" })}\n`);
    await writeFile(outsideIncludePath, `${JSON.stringify({ hooks: { enabled: true } })}\n`);
    await symlink(outsideIncludePath, includeLinkPath);
    const configIo = createConfigIO({
      configPath,
      env: {},
      homedir: () => rootDir,
      observe: false,
      pluginValidation: "skip",
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    try {
      const snapshot = await configIo.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);
      expect(snapshot.includedPaths).toEqual([includeLinkPath]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
      await rm(outsideDir, { force: true, recursive: true });
    }
  });
});

function getOnlyPromoteSnapshotCall(promoteSnapshot: {
  mock: { calls: Array<readonly [ConfigFileSnapshot, string]> };
}): readonly [ConfigFileSnapshot, string] {
  expect(promoteSnapshot).toHaveBeenCalledTimes(1);
  const call = promoteSnapshot.mock.calls[0];
  if (!call) {
    throw new Error("expected one promote snapshot call");
  }
  return call;
}

describe("startGatewayConfigReloader", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("watches resolved includes and reconciles them after an accepted reload", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18789 },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18790 },
    };
    const initialIncludePath = "/tmp/initial.json5";
    const retainedIncludePath = "/tmp/retained.json5";
    const addedIncludePath = "/tmp/added.json5";
    const harness = createReloaderHarness(
      vi.fn(async () =>
        makeSnapshot({
          config: nextConfig,
          parsed: nextConfig,
          hash: "next-raw-hash",
          includedPaths: [retainedIncludePath, addedIncludePath],
        }),
      ),
      {
        initialConfig,
        initialIncludedPaths: [initialIncludePath, retainedIncludePath],
      },
    );

    expect(chokidar.watch).toHaveBeenCalledWith(
      ["/tmp/openclaw.json", initialIncludePath, retainedIncludePath],
      expect.objectContaining({ ignoreInitial: true }),
    );

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    // Candidate discovery adds the new include before acceptance; acceptance
    // then retires the old include in a second readiness-reconciled watcher.
    expect(harness.watcher.close).toHaveBeenCalledTimes(2);
    expect(chokidar.watch).toHaveBeenLastCalledWith(
      ["/tmp/openclaw.json", retainedIncludePath, addedIncludePath],
      expect.objectContaining({ ignoreInitial: true }),
    );
    await harness.reloader.stop();
  });

  it("retains accepted include watches while replacing a rejected candidate set", async () => {
    const acceptedIncludePath = "/tmp/accepted.json5";
    const firstCandidatePath = "/tmp/first-invalid.json5";
    const secondCandidatePath = "/tmp/second-invalid.json5";
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          valid: false,
          hash: "first-invalid-hash",
          includedPaths: [firstCandidatePath],
          issues: [{ path: "hooks.enabled", message: "Expected boolean" }],
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          valid: false,
          hash: "second-invalid-hash",
          includedPaths: [secondCandidatePath],
          issues: [{ path: "hooks.enabled", message: "Expected boolean" }],
        }),
      );
    const harness = createReloaderHarness(readSnapshot, {
      initialIncludedPaths: [acceptedIncludePath],
    });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    expect(harness.watcher.close).toHaveBeenCalledOnce();
    expect(chokidar.watch).toHaveBeenLastCalledWith(
      ["/tmp/openclaw.json", acceptedIncludePath, firstCandidatePath],
      expect.objectContaining({ ignoreInitial: true }),
    );

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    expect(harness.watcher.close).toHaveBeenCalledTimes(2);
    expect(chokidar.watch).toHaveBeenLastCalledWith(
      ["/tmp/openclaw.json", acceptedIncludePath, secondCandidatePath],
      expect.objectContaining({ ignoreInitial: true }),
    );
    await harness.reloader.stop();
  });

  it("does not recurse into or reload for children of a rejected include directory", async () => {
    const rejectedIncludeDir = "/tmp/rejected-include";
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        valid: false,
        hash: "invalid-directory-hash",
        includedPaths: [rejectedIncludeDir],
        issues: [{ path: "", message: "Include path is not a regular file" }],
      }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialIncludedPaths: [rejectedIncludeDir],
    });

    expect(chokidar.watch).toHaveBeenCalledWith(
      ["/tmp/openclaw.json", rejectedIncludeDir],
      expect.objectContaining({ depth: 0 }),
    );

    harness.watcher.emit("change", nodePath.join(rejectedIncludeDir, "session.json"));
    await vi.runAllTimersAsync();
    expect(readSnapshot).not.toHaveBeenCalled();

    harness.watcher.emit("change", rejectedIncludeDir);
    await vi.runAllTimersAsync();
    expect(readSnapshot).toHaveBeenCalledOnce();
    await harness.reloader.stop();
  });

  it("journals valid external watcher edits and advances the snapshot slot", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18789 },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18790 },
    };
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: nextConfig, parsed: nextConfig, hash: "next-raw-hash" }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append).toHaveBeenCalledOnce();
    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "watch",
      configPath: "/tmp/openclaw.json",
      previousHash: "initial-raw-hash",
      nextHash: "next-raw-hash",
      valid: true,
      changedPaths: ["gateway.port"],
    });
    expect(configAuditMocks.upsertSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: "next-raw-hash",
        authoredConfig: nextConfig,
      }),
    );
    await harness.reloader.stop();
  });

  it("does not duplicate another OpenClaw process's journaled write", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18789 },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18790 },
    };
    const harness = createReloaderHarness(
      vi.fn(async () =>
        makeSnapshot({ config: nextConfig, parsed: nextConfig, hash: "other-write" }),
      ),
      { initialConfig },
    );
    configAuditMocks.readSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: "other-write",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(nextConfig),
    });
    configAuditMocks.append.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append).not.toHaveBeenCalled();
    expect(configAuditMocks.upsertSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: "other-write",
        authoredConfig: nextConfig,
      }),
    );
    await harness.reloader.stop();
  });

  it("journals invalid external watcher edits without advancing the snapshot slot", async () => {
    const initialConfig: OpenClawConfig = { gateway: { reload: {} } };
    const invalid = makeSnapshot({
      valid: false,
      hash: "invalid-raw-hash",
      issues: [{ path: "gateway.port", message: "expected number" }],
    });
    const harness = createReloaderHarness(
      vi.fn(async () => invalid),
      { initialConfig },
    );
    configAuditMocks.upsertSnapshot.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "watch",
      previousHash: "initial-raw-hash",
      nextHash: "invalid-raw-hash",
      valid: false,
      issues: ["gateway.port: expected number"],
    });
    expect(configAuditMocks.upsertSnapshot).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("deduplicates invalid snapshots by observed raw hash", async () => {
    const firstInvalid = makeSnapshot({
      valid: false,
      hash: "invalid-raw-hash-1",
      issues: [{ path: "gateway.port", message: "expected number" }],
    });
    const secondInvalid = makeSnapshot({
      valid: false,
      hash: "invalid-raw-hash-2",
      issues: [{ path: "gateway.port", message: "expected number" }],
    });
    let activeSnapshot = firstInvalid;
    const harness = createReloaderHarness(vi.fn(async () => activeSnapshot));
    configAuditMocks.append.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append).toHaveBeenCalledOnce();
    activeSnapshot = secondInvalid;
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append).toHaveBeenCalledTimes(2);
    expect(configAuditMocks.append.mock.calls[1]?.[0]?.record).toMatchObject({
      detectedBy: "watch",
      previousHash: "invalid-raw-hash-1",
      nextHash: "invalid-raw-hash-2",
      valid: false,
    });
    await harness.reloader.stop();
  });

  it("uses the last observed hash when a valid edit follows an invalid one", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18789 },
    };
    const invalid = makeSnapshot({
      valid: false,
      hash: "invalid-raw-hash",
      issues: [{ path: "gateway.port", message: "expected number" }],
    });
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18790 },
    };
    let activeSnapshot = invalid;
    const harness = createReloaderHarness(
      vi.fn(async () => activeSnapshot),
      { initialConfig },
    );
    configAuditMocks.append.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    activeSnapshot = makeSnapshot({
      config: nextConfig,
      parsed: nextConfig,
      hash: "valid-raw-hash",
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append.mock.calls[1]?.[0]?.record).toMatchObject({
      detectedBy: "watch",
      previousHash: "invalid-raw-hash",
      nextHash: "valid-raw-hash",
      valid: true,
      changedPaths: ["gateway.port"],
    });
    await harness.reloader.stop();
  });

  it("journals a return to the accepted bytes after an invalid edit", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18789 },
    };
    const invalid = makeSnapshot({
      valid: false,
      hash: "invalid-raw-hash",
      issues: [{ path: "gateway.port", message: "expected number" }],
    });
    let activeSnapshot = invalid;
    const harness = createReloaderHarness(
      vi.fn(async () => activeSnapshot),
      { initialConfig },
    );
    configAuditMocks.append.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    activeSnapshot = makeSnapshot({
      config: initialConfig,
      parsed: initialConfig,
      hash: "initial-raw-hash",
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append.mock.calls[1]?.[0]?.record).toMatchObject({
      detectedBy: "watch",
      previousHash: "invalid-raw-hash",
      nextHash: "initial-raw-hash",
      valid: true,
      opaqueChange: true,
    });
    await harness.reloader.stop();
  });

  it("journals restoration after startup observed a missing config", async () => {
    const acceptedConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18789 },
    };
    configAuditMocks.readSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: "accepted-raw-hash",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(acceptedConfig),
    });
    const harness = createReloaderHarness(
      vi.fn(async () =>
        makeSnapshot({
          config: acceptedConfig,
          parsed: acceptedConfig,
          hash: "accepted-raw-hash",
        }),
      ),
      {
        initialConfig: acceptedConfig,
        initialSnapshotRawHash: null,
        initialSnapshotValid: false,
      },
    );
    configAuditMocks.append.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      detectedBy: "watch",
      previousHash: null,
      nextHash: "accepted-raw-hash",
      valid: true,
      opaqueChange: true,
    });
    await harness.reloader.stop();
  });

  it("reconciles offline secret rotations with fingerprinted paths", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "alpha" } },
    };
    const initialConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "beta" } },
    };
    configAuditMocks.readSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: "previous-raw-hash",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(previousConfig),
    });

    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      initialSnapshotRawHash: "current-raw-hash",
      initialAuthoredConfig: initialConfig,
    });

    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "startup",
      previousHash: "previous-raw-hash",
      nextHash: "current-raw-hash",
      valid: true,
      changedPaths: ["gateway.auth.token"],
    });
    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).not.toHaveProperty("opaqueChange");
    expect(configAuditMocks.upsertSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: "current-raw-hash",
        authoredConfig: initialConfig,
      }),
    );
    await harness.reloader.stop();
  });

  it("journals invalid initial snapshots as rejected startup edits", async () => {
    configAuditMocks.readSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: "previous-raw-hash",
      fingerprintedAuthoredConfig: { gateway: { port: 18789 } },
    });
    const harness = createReloaderHarness(vi.fn(), {
      initialSnapshotRawHash: "invalid-raw-hash",
      initialAuthoredConfig: { gateway: { port: "invalid" } },
      initialSnapshotValid: false,
      initialSnapshotIssues: [{ path: "gateway.port", message: "expected number" }],
    });

    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "startup",
      previousHash: "previous-raw-hash",
      nextHash: "invalid-raw-hash",
      valid: false,
      issues: ["gateway.port: expected number"],
    });
    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).not.toHaveProperty("changedPaths");
    expect(configAuditMocks.upsertSnapshot).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("journals mixed secret and non-secret offline startup edits", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "alpha" }, port: 18789 },
    };
    const initialConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "beta" }, port: 18790 },
    };
    configAuditMocks.readSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: "previous-raw-hash",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(previousConfig),
    });

    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      initialSnapshotRawHash: "current-raw-hash",
      initialAuthoredConfig: initialConfig,
    });

    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "startup",
      changedPaths: ["gateway.auth.token", "gateway.port"],
    });
    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).not.toHaveProperty("opaqueChange");
    await harness.reloader.stop();
  });

  it("journals an offline config deletion without clearing the snapshot slot", async () => {
    configAuditMocks.readSnapshot.mockReturnValue({
      configPath: "/tmp/openclaw.json",
      rawHash: "previous-raw-hash",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig({
        gateway: { port: 18789 },
      }),
    });
    const harness = createReloaderHarness(vi.fn(), {
      initialSnapshotRawHash: null,
      initialAuthoredConfig: {},
    });

    expect(configAuditMocks.append).toHaveBeenCalledOnce();
    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "startup",
      previousHash: "previous-raw-hash",
      nextHash: null,
      valid: false,
      issues: ["config file missing"],
    });
    expect(configAuditMocks.upsertSnapshot).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("reseeds the slot without an external record when it belongs to another config path", async () => {
    const storedSnapshot = {
      configPath: "/tmp/config-a.json",
      rawHash: "path-a-raw-hash",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig({
        gateway: { port: 18789 },
      }),
    };
    configAuditMocks.readSnapshot.mockImplementation((params: { configPath: string }) =>
      params.configPath === storedSnapshot.configPath ? storedSnapshot : null,
    );
    // The unfiltered read still surfaces the foreign slot: it must become the
    // CAS token so path B can take the slot over, without seeding reconcile.
    configAuditMocks.readLatestSnapshot.mockReturnValue(storedSnapshot);
    const initialConfig: OpenClawConfig = { gateway: { port: 18790 } };
    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      initialSnapshotRawHash: "path-b-raw-hash",
      initialAuthoredConfig: initialConfig,
    });

    expect(configAuditMocks.append).not.toHaveBeenCalled();
    expect(configAuditMocks.upsertSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: "path-b-raw-hash",
        authoredConfig: initialConfig,
        expectedSnapshot: storedSnapshot,
      }),
    );
    await harness.reloader.stop();
  });

  it("does not journal an internal write as external", async () => {
    const harness = createReloaderHarness(
      vi.fn(async () => makeZeroDebounceHookSnapshot("internal-write")),
    );
    configAuditMocks.append.mockClear();

    harness.emitWrite(makeZeroDebounceHookWrite("internal-write"));
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append).not.toHaveBeenCalled();
    expect(configAuditMocks.upsertSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: "internal-write",
        authoredConfig: makeZeroDebounceHookSnapshot("internal-write").parsed,
      }),
    );
    await harness.reloader.stop();
  });

  it("ignores valid watcher events whose source hash did not change", async () => {
    const initialConfig: OpenClawConfig = { gateway: { reload: {} } };
    const snapshot = makeSnapshot({ config: initialConfig, hash: "unchanged-raw-hash" });
    const harness = createReloaderHarness(
      vi.fn(async () => snapshot),
      {
        initialConfig,
        initialSnapshotRawHash: "unchanged-raw-hash",
        initialAuthoredConfig: snapshot.parsed,
      },
    );
    configAuditMocks.append.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("journals opaque watcher edits when only the authored bytes changed", async () => {
    const initialConfig: OpenClawConfig = { gateway: { reload: {} } };
    const snapshot = makeSnapshot({
      config: initialConfig,
      sourceConfig: initialConfig,
      parsed: initialConfig,
      hash: "comment-only-raw-hash",
    });
    const harness = createReloaderHarness(
      vi.fn(async () => snapshot),
      {
        initialConfig,
        initialSnapshotRawHash: "initial-raw-hash",
        initialAuthoredConfig: initialConfig,
      },
    );
    configAuditMocks.append.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).toMatchObject({
      event: "config.external",
      detectedBy: "watch",
      previousHash: "initial-raw-hash",
      nextHash: "comment-only-raw-hash",
      valid: true,
      opaqueChange: true,
    });
    expect(configAuditMocks.append.mock.calls[0]?.[0]?.record).not.toHaveProperty("changedPaths");
    expect(configAuditMocks.upsertSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw.json",
        rawHash: "comment-only-raw-hash",
        authoredConfig: initialConfig,
      }),
    );
    await harness.reloader.stop();
  });

  it.each([
    ["invalid", makeSnapshot({ valid: false })],
    ["missing", makeSnapshot({ exists: false, valid: false })],
  ] as const)(
    "notifies lifecycle owners synchronously for an observed %s snapshot",
    async (_, snapshot) => {
      const onConfigCandidateObserved = vi.fn();
      const readSnapshot = vi.fn(async () => snapshot);
      const harness = createReloaderHarness(readSnapshot, { onConfigCandidateObserved });

      harness.watcher.emit("change");

      expect(onConfigCandidateObserved).toHaveBeenCalledOnce();
      expect(readSnapshot).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();
      expect(harness.onConfigAccepted).not.toHaveBeenCalled();
      await harness.reloader.stop();
    },
  );

  it("notifies change listeners for every accepted external edit, including runtime-skipped ones", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
    };
    // ui.* is a no-op reload class: the runtime snapshot refreshes without a
    // hot reload or restart — exactly the agent-changes-theme case.
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      ui: { prefs: { themeMode: "dark" } },
    };
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: nextConfig, hash: "external-prefs-write" }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigCandidateCommitted).toHaveBeenCalledOnce();
    expect(harness.onConfigCandidateCommitted).toHaveBeenCalledWith({
      path: "/tmp/openclaw.json",
      persistedHash: "external-prefs-write",
      changedPaths: ["ui"],
    });

    // A same-content echo must not re-notify: nothing changed.
    harness.onConfigCandidateCommitted.mockClear();
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    expect(harness.onConfigCandidateCommitted).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("notifies change listeners when reload mode off skips the runtime apply", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      ui: { prefs: { themeMode: "light" } },
    };
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: nextConfig, hash: "mode-off-write" }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onConfigCandidateCommitted).toHaveBeenCalledOnce();
    await harness.reloader.stop();
  });

  it("notifies lifecycle owners when a persisted edit reverts to the current baseline", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, port: 18789 },
    };
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: initialConfig, hash: "reverted-restart-edit" }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onConfigApplied).not.toHaveBeenCalled();
    expect(harness.onConfigRevisionApplied).toHaveBeenCalledWith(
      hashRuntimeConfigValue(initialConfig),
    );
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("reaccepts a same-hash watcher echo after synchronously pausing lifecycle work", async () => {
    const initialConfig = {
      gateway: { reload: {} },
    } satisfies OpenClawConfig;
    const onConfigCandidateObserved = vi.fn();
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: initialConfig, hash: "accepted-write" }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      initialInternalWriteHash: "accepted-write",
      onConfigCandidateObserved,
    });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(onConfigCandidateObserved).toHaveBeenCalledOnce();
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();

    await harness.reloader.stop();
  });

  it("revalidates changed effective config when an accepted write hash is unchanged", async () => {
    const initialConfig = {
      gateway: { reload: {}, port: 18_789 },
    } satisfies OpenClawConfig;
    const unavailableSecret = {
      source: "env" as const,
      provider: "default",
      id: "INCLUDED_GATEWAY_TOKEN",
    };
    const effectiveConfig = {
      gateway: {
        reload: {},
        port: 19_001,
        auth: { mode: "token" as const, token: unavailableSecret },
      },
    } satisfies OpenClawConfig;
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: effectiveConfig,
        sourceConfig: effectiveConfig,
        runtimeConfig: effectiveConfig,
        hash: "unchanged-root-hash",
      }),
    );
    const onRestart = vi.fn(
      async (
        _plan: GatewayReloadPlan,
        _nextConfig: OpenClawConfig,
        _ownership: GatewayConfigReloadTransactionOwnership,
        _sourceConfig: OpenClawConfig,
      ) => {
        throw new Error("required SecretRef INCLUDED_GATEWAY_TOKEN is unavailable");
      },
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      initialCompareConfig: initialConfig,
      onRestart,
    });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: initialConfig,
      runtimeConfig: initialConfig,
      persistedHash: "unchanged-root-hash",
      revision: 1,
      fingerprint: "runtime-unchanged-root-hash",
      sourceFingerprint: "source-unchanged-root-hash",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();
    harness.onConfigAccepted.mockClear();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(onRestart).toHaveBeenCalledOnce();
    expect(onRestart.mock.calls[0]?.[3]).toEqual(effectiveConfig);
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(harness.log.error).toHaveBeenCalledWith(
      "config reload failed: Error: required SecretRef INCLUDED_GATEWAY_TOKEN is unavailable",
    );

    await harness.reloader.stop();
  });

  it("applies a superseded runtime plan before baseline-only acceptance", async () => {
    const initialConfig = {
      gateway: { reload: {}, terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "off" as const } } },
    } satisfies OpenClawConfig;
    const appliedConfig = {
      gateway: { reload: {}, terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" as const } } },
    } satisfies OpenClawConfig;
    const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
    const events: string[] = [];
    const onNoopConfigCommit = async (
      plan: GatewayReloadPlan,
      nextConfig: OpenClawConfig,
      ownership: GatewayConfigReloadTransactionOwnership,
    ) => {
      terminalPolicy.prepareConfig(nextConfig, { restartPending: false });
      ownership.markRuntimeCommitted(nextConfig, plan);
      harness.emitWrite({
        configPath: "/tmp/openclaw.json",
        sourceConfig: initialConfig,
        runtimeConfig: initialConfig,
        persistedHash: "baseline-only-b",
        revision: 2,
        fingerprint: "runtime-baseline-only-b",
        sourceFingerprint: "source-baseline-only-b",
        writtenAtMs: Date.now(),
        afterWrite: { mode: "none", reason: "baseline-only acceptance" },
      });
    };
    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      initialCompareConfig: initialConfig,
      onNoopConfigCommit,
      onConfigApplied: () => {
        events.push("applied");
        terminalPolicy.commitConfig();
      },
      onConfigRevisionApplied: () => events.push("revision-applied"),
      onConfigAccepted: () => {
        events.push("accepted");
        terminalPolicy.acceptConfig({ retireRejectedRestart: false });
      },
    });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: appliedConfig,
      runtimeConfig: appliedConfig,
      persistedHash: "runtime-a",
      revision: 1,
      fingerprint: "runtime-a",
      sourceFingerprint: "source-a",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(events).toEqual(["applied", "revision-applied", "accepted"]);
    expect(terminalPolicy.resolve()).toMatchObject({
      ok: false,
      block: { kind: "sandboxed", mode: "all" },
    });

    await harness.reloader.stop();
  });

  it.each([
    ["invalid", makeSnapshot({ valid: false, hash: "invalid-b" })],
    ["missing", makeSnapshot({ exists: false, valid: false, raw: null, hash: "missing-b" })],
  ] as const)(
    "applies a committed runtime owner before rejecting a superseding %s snapshot",
    async (_, rejectedSnapshot) => {
      const initialConfig = {
        gateway: { reload: {}, terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "off" as const } } },
      } satisfies OpenClawConfig;
      const appliedConfig = {
        ...initialConfig,
        agents: { defaults: { sandbox: { mode: "all" as const } } },
      } satisfies OpenClawConfig;
      const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
      const onNoopConfigCommit = async (
        plan: GatewayReloadPlan,
        nextConfig: OpenClawConfig,
        ownership: GatewayConfigReloadTransactionOwnership,
      ) => {
        terminalPolicy.prepareConfig(nextConfig, { restartPending: false });
        ownership.markRuntimeCommitted(nextConfig, plan);
        harness.watcher.emit("change");
      };
      const harness = createReloaderHarness(
        vi.fn(async () => rejectedSnapshot),
        {
          initialConfig,
          initialCompareConfig: initialConfig,
          onNoopConfigCommit,
          onConfigApplied: () => terminalPolicy.commitConfig(),
        },
      );

      harness.emitWrite({
        configPath: "/tmp/openclaw.json",
        sourceConfig: appliedConfig,
        runtimeConfig: appliedConfig,
        persistedHash: "runtime-a-before-rejected-b",
        revision: 1,
        fingerprint: "runtime-a-before-rejected-b",
        sourceFingerprint: "source-a-before-rejected-b",
        writtenAtMs: Date.now(),
      });
      await vi.runAllTimersAsync();

      expect(harness.onConfigApplied).toHaveBeenCalledOnce();
      expect(terminalPolicy.resolve()).toMatchObject({
        ok: false,
        block: { kind: "sandboxed", mode: "all" },
      });

      await harness.reloader.stop();
    },
  );

  it("applies a superseded runtime owner before preparing a restart candidate", async () => {
    const initialConfig = {
      gateway: { reload: {}, terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "off" as const } } },
    } satisfies OpenClawConfig;
    const appliedConfig = {
      gateway: { reload: {}, terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" as const } } },
    } satisfies OpenClawConfig;
    const restartConfig = {
      ...initialConfig,
      gateway: { ...initialConfig.gateway, port: 19_001 },
    } satisfies OpenClawConfig;
    const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
    const events: string[] = [];
    const onNoopConfigCommit = async (
      plan: GatewayReloadPlan,
      nextConfig: OpenClawConfig,
      ownership: GatewayConfigReloadTransactionOwnership,
    ) => {
      terminalPolicy.prepareConfig(nextConfig, { restartPending: false });
      ownership.markRuntimeCommitted(nextConfig, plan);
      harness.emitWrite({
        configPath: "/tmp/openclaw.json",
        sourceConfig: restartConfig,
        runtimeConfig: restartConfig,
        persistedHash: "restart-b",
        revision: 2,
        fingerprint: "runtime-restart-b",
        sourceFingerprint: "source-restart-b",
        writtenAtMs: Date.now(),
      });
    };
    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      initialCompareConfig: initialConfig,
      onNoopConfigCommit,
      onConfigApplied: () => {
        events.push("applied");
        terminalPolicy.commitConfig();
      },
      onConfigChange: (plan, nextConfig) => {
        events.push("prepared");
        terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
      },
      onConfigAccepted: () => {
        events.push("accepted");
        terminalPolicy.acceptConfig({ retireRejectedRestart: false });
      },
    });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: appliedConfig,
      runtimeConfig: appliedConfig,
      persistedHash: "runtime-a-before-restart",
      revision: 1,
      fingerprint: "runtime-a-before-restart",
      sourceFingerprint: "source-a-before-restart",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(events).toEqual(["prepared", "applied", "prepared", "accepted"]);
    expect(terminalPolicy.resolve()).toMatchObject({
      ok: false,
      block: { kind: "sandboxed", mode: "all" },
    });

    await harness.reloader.stop();
  });

  it("does not reaccept an invalid snapshot whose root hash matches the startup write", async () => {
    const initialConfig = {
      gateway: { reload: {} },
    } satisfies OpenClawConfig;
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: initialConfig, valid: false, hash: "accepted-write" }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      initialInternalWriteHash: "accepted-write",
    });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();

    await harness.reloader.stop();
  });

  it.each(["noop", "hot"] as const)(
    "revokes a slow external %s transaction when a newer watcher burst reverts it",
    async (kind) => {
      const initialConfig = {
        gateway: { reload: { mode: "off" as const } },
        hooks: { enabled: true, token: "test-token", path: "/old" },
      } satisfies OpenClawConfig;
      const configA = {
        gateway: { reload: { mode: "hot" as const } },
        hooks: {
          enabled: true,
          token: "test-token",
          path: kind === "hot" ? "/a" : "/old",
        },
      } satisfies OpenClawConfig;
      const configB = structuredClone(initialConfig);
      const readSnapshot = vi
        .fn<() => Promise<ConfigFileSnapshot>>()
        .mockResolvedValueOnce(
          makeSnapshot({
            config: configA,
            sourceConfig: configA,
            runtimeConfig: configA,
            hash: "external-a",
          }),
        )
        .mockResolvedValueOnce(
          makeSnapshot({
            config: configB,
            sourceConfig: configB,
            runtimeConfig: configB,
            hash: "external-b",
          }),
        );
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let releaseA: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const publishA = async (
        _plan: GatewayReloadPlan,
        _nextConfig: OpenClawConfig,
        ownership: GatewayConfigReloadTransactionOwnership,
      ) => {
        markStarted?.();
        await blocked;
        expect(ownership.isCurrent()).toBe(false);
      };
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig,
        ...(kind === "noop" ? { onNoopConfigCommit: publishA } : { onHotReload: publishA }),
      });

      harness.watcher.emit("change");
      await vi.advanceTimersByTimeAsync(0);
      await started;

      // Editors commonly produce more than one event for a single replacement.
      // Every event revokes A; one debounced read owns the newest epoch.
      harness.watcher.emit("change");
      harness.watcher.emit("add");
      await vi.advanceTimersByTimeAsync(0);
      releaseA?.();
      await vi.runAllTimersAsync();

      expect(readSnapshot).toHaveBeenCalledTimes(2);
      expect(harness.onConfigApplied).not.toHaveBeenCalled();
      expect(harness.onConfigAccepted).toHaveBeenCalledTimes(1);
      expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toEqual(configB);
      expect(harness.onRestart).not.toHaveBeenCalled();
      if (kind === "noop") {
        expect(harness.onNoopConfigCommit).toHaveBeenCalledTimes(1);
        expect(harness.onHotReload).not.toHaveBeenCalled();
      } else {
        expect(harness.onHotReload).toHaveBeenCalledTimes(1);
        expect(harness.onNoopConfigCommit).not.toHaveBeenCalled();
      }
      await harness.reloader.stop();
    },
  );

  it("plans the reverse hot reload when config A commits before config B supersedes its tail", async () => {
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } satisfies OpenClawConfig;
    const configA = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/a" },
    } satisfies OpenClawConfig;
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ config: configA, hash: "post-commit-a" }))
      .mockResolvedValueOnce(makeSnapshot({ config: initialConfig, hash: "reverse-b" }));
    let recordCommitted: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      recordCommitted = resolve;
    });
    let releaseTail = () => {};
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const onHotReload = vi.fn(
      async (
        plan: GatewayReloadPlan,
        nextConfig: OpenClawConfig,
        ownership: GatewayConfigReloadTransactionOwnership,
      ) => {
        ownership.markRuntimeCommitted(nextConfig, plan);
        if (nextConfig === configA) {
          recordCommitted?.();
          await tailGate;
        }
      },
    );
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      onHotReload,
      promoteSnapshot,
    });

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await committed;

    harness.watcher.emit("change");
    releaseTail();
    await vi.runAllTimersAsync();

    expect(onHotReload).toHaveBeenCalledTimes(2);
    expect(onHotReload.mock.calls.map(([, config]) => config)).toEqual([configA, initialConfig]);
    expect(onHotReload.mock.calls[1]?.[0].hotReasons).toContain("hooks.path");
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toEqual(initialConfig);
    expect(harness.onConfigApplied).toHaveBeenCalledTimes(2);
    expect(harness.onConfigApplied.mock.calls.map(([, config]) => config)).toEqual([
      configA,
      initialConfig,
    ]);
    expect(promoteSnapshot.mock.calls.map(([snapshot]) => snapshot.hash)).toEqual(["reverse-b"]);

    await harness.reloader.stop();
  });

  it("prepares a superseding config against the env owner committed at the runtime edge", async () => {
    const envKey = "OPENCLAW_TEST_COMMITTED_ENV_SOURCE";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const configA = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/a" },
      env: { vars: { [envKey]: "a" } },
    } satisfies OpenClawConfig;
    const configB = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/b" },
      env: { vars: { [envKey]: "b" } },
    } satisfies OpenClawConfig;
    const preparedEnvValues: Array<string | undefined> = [];
    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      prepareConfigCandidate: ({ runtimeConfig, sourceConfig, previousSourceConfig }) => ({
        runtimeConfig,
        compareConfig: { ...sourceConfig, env: initialConfig.env },
        runtimeEnv: prepareConfigRuntimeEnv({
          previousConfig: previousSourceConfig,
          nextConfig: sourceConfig,
          env: targetEnv,
          previousOwnedEnv: {
            [envKey]: previousSourceConfig.env?.vars?.[envKey] ?? "",
          },
        }),
      }),
      onHotReload: async (plan, nextConfig, ownership) => {
        preparedEnvValues.push(ownership.runtimeEnv?.env[envKey]);
        ownership.publishRuntimeEnv();
        ownership.markRuntimeCommitted(nextConfig, plan);
        if (nextConfig === configA) {
          emitWrite(configB, "env-b", 2);
        }
      },
    });
    const emitWrite = (config: OpenClawConfig, hash: string, revision: number) => {
      harness.emitWrite({
        configPath: "/tmp/openclaw.json",
        sourceConfig: config,
        runtimeConfig: config,
        persistedHash: hash,
        revision,
        fingerprint: `runtime-${hash}`,
        sourceFingerprint: `source-${hash}`,
        writtenAtMs: Date.now(),
      });
    };

    emitWrite(configA, "env-a", 1);
    await vi.runAllTimersAsync();

    expect(preparedEnvValues).toEqual(["a", "b"]);
    expect(targetEnv[envKey]).toBe("b");
    await harness.reloader.stop();
  });

  it("rereads the filesystem when a watcher event supersedes a queued in-process write", async () => {
    const initialConfig = {
      gateway: { reload: { mode: "off" as const } },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } satisfies OpenClawConfig;
    const queuedConfig = {
      gateway: { reload: { mode: "hot" as const } },
      hooks: { enabled: true, token: "test-token", path: "/queued" },
    } satisfies OpenClawConfig;
    const externalConfig = structuredClone(initialConfig);
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: externalConfig,
        sourceConfig: externalConfig,
        runtimeConfig: externalConfig,
        hash: "external-after-queued-write",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: queuedConfig,
      runtimeConfig: queuedConfig,
      persistedHash: "queued-in-process",
      revision: 1,
      fingerprint: "runtime-queued",
      sourceFingerprint: "source-queued",
      writtenAtMs: Date.now(),
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.onNoopConfigCommit).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onConfigAccepted).toHaveBeenCalledTimes(1);
    expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toEqual(externalConfig);
    await harness.reloader.stop();
  });

  it("does not restart stale external config A before rejecting invalid SecretRef config B", async () => {
    const initialConfig = {
      gateway: { reload: { mode: "off" as const }, port: 18789 },
    } satisfies OpenClawConfig;
    const configA = {
      gateway: { reload: { mode: "restart" as const }, port: 18790 },
    } satisfies OpenClawConfig;
    const configB = {
      gateway: {
        reload: { mode: "restart" as const },
        port: 18791,
        auth: {
          mode: "token" as const,
          token: {
            source: "env" as const,
            provider: "default",
            id: "MISSING_RESTART_TOKEN",
          },
        },
      },
    } satisfies OpenClawConfig;
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          config: configA,
          sourceConfig: configA,
          runtimeConfig: configA,
          hash: "restart-a",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: configB,
          sourceConfig: configB,
          runtimeConfig: configB,
          hash: "restart-invalid-b",
        }),
      );
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseA: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const restartRequests: OpenClawConfig[] = [];
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      onRestart: async (_plan, nextConfig, ownership) => {
        if (nextConfig === configA) {
          markStarted?.();
          await blocked;
        }
        if (!ownership.isCurrent()) {
          throw new Error("external restart config A was superseded");
        }
        const token = nextConfig.gateway?.auth?.token;
        if (typeof token === "object" && token !== null && token.id === "MISSING_RESTART_TOKEN") {
          throw new Error(`required SecretRef ${token.id} is unavailable`);
        }
        restartRequests.push(nextConfig);
      },
    });

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await started;
    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    releaseA?.();
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onRestart.mock.calls.map(([, config]) => config)).toEqual([configA, configB]);
    expect(restartRequests).toEqual([]);
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(harness.log.error).toHaveBeenCalledWith(
      "config restart failed: Error: required SecretRef MISSING_RESTART_TOKEN is unavailable",
    );
    await harness.reloader.stop();
  });

  it("keeps an unlink epoch through a missing-file retry before accepting config B", async () => {
    const initialConfig = {
      gateway: { reload: { mode: "off" as const } },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } satisfies OpenClawConfig;
    const configA = {
      gateway: { reload: { mode: "hot" as const } },
      hooks: { enabled: true, token: "test-token", path: "/a" },
    } satisfies OpenClawConfig;
    const configB = structuredClone(initialConfig);
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          config: configA,
          sourceConfig: configA,
          runtimeConfig: configA,
          hash: "unlink-a",
        }),
      )
      .mockResolvedValueOnce(makeSnapshot({ exists: false, valid: false }))
      .mockResolvedValueOnce(
        makeSnapshot({
          config: configB,
          sourceConfig: configB,
          runtimeConfig: configB,
          hash: "unlink-b",
        }),
      );
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseA: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      onHotReload: async (_plan, _nextConfig, ownership) => {
        markStarted?.();
        await blocked;
        if (!ownership.isCurrent()) {
          throw new Error("unlinked config A was superseded");
        }
      },
    });

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await started;
    harness.watcher.emit("unlink");
    await vi.advanceTimersByTimeAsync(0);
    releaseA?.();
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);
    expect(harness.onConfigApplied).not.toHaveBeenCalled();
    expect(harness.onConfigAccepted).toHaveBeenCalledTimes(1);
    expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toEqual(configB);
    expect(harness.log.info).toHaveBeenCalledWith(
      "config reload retry (1/2): config file not found",
    );
    await harness.reloader.stop();
  });

  it("does not accept stale config A when config B arrives during plugin-index discovery", async () => {
    const initialConfig = {
      gateway: { reload: {} },
    } satisfies OpenClawConfig;
    const invalidConfigB = {
      gateway: { reload: {}, port: 18790 },
    } satisfies OpenClawConfig;
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          config: initialConfig,
          sourceConfig: initialConfig,
          runtimeConfig: initialConfig,
          hash: "plugin-read-a",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: invalidConfigB,
          sourceConfig: invalidConfigB,
          runtimeConfig: invalidConfigB,
          valid: false,
          hash: "plugin-read-invalid-b",
        }),
      );
    let markPluginReadStarted: (() => void) | undefined;
    const pluginReadStarted = new Promise<void>((resolve) => {
      markPluginReadStarted = resolve;
    });
    let releasePluginRead: (() => void) | undefined;
    const pluginReadBlocked = new Promise<void>((resolve) => {
      releasePluginRead = resolve;
    });
    const readPluginInstallRecords = vi.fn(async () => {
      markPluginReadStarted?.();
      await pluginReadBlocked;
      return {};
    });
    let pausedRestartDebt = true;
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      readPluginInstallRecords,
      onConfigAccepted: () => {
        pausedRestartDebt = false;
      },
    });

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted;
    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    releasePluginRead?.();
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(pausedRestartDebt).toBe(true);
    expect(harness.onNoopConfigCommit).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("waits for an active reload transaction before stop resolves", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/next" },
    };
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: nextConfig, hash: "active-reload" }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialConfig });
    let markReloadStarted: (() => void) | undefined;
    const reloadStarted = new Promise<void>((resolve) => {
      markReloadStarted = resolve;
    });
    let finishReload: (() => void) | undefined;
    const reloadBlocked = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    harness.onHotReload.mockImplementationOnce(async () => {
      markReloadStarted?.();
      await reloadBlocked;
    });

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await reloadStarted;

    // A second callback exits quickly through `running` and must not replace
    // the transaction that still owns the reload.
    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);

    let stopResolved = false;
    const stopPromise = harness.reloader.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    finishReload?.();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it("notifies lifecycle owners for no-op sandbox policy changes", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      agents: { defaults: { sandbox: { mode: "off" } } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      agents: { defaults: { sandbox: { mode: "all" } } },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "sandbox" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigChange).toHaveBeenCalledTimes(1);
    expect(harness.onConfigChange.mock.calls[0]?.[0].noopPaths).toContain(
      "agents.defaults.sandbox.mode",
    );
    expect(harness.onConfigChange.mock.calls[0]?.[1]).toBe(nextConfig);
    expect(harness.onConfigApplied).toHaveBeenCalledTimes(1);
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("commits runtime snapshot changes for no-op visible reply reloads", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      messages: { visibleReplies: "message_tool" },
    };
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: nextConfig, hash: "visible-replies" }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onNoopConfigCommit).toHaveBeenCalledTimes(1);
    expect(harness.onNoopConfigCommit.mock.calls[0]?.[0].noopPaths).toContain(
      "messages.visibleReplies",
    );
    expect(harness.onNoopConfigCommit.mock.calls[0]?.[1]).toBe(nextConfig);
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onConfigChange.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onNoopConfigCommit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(harness.onNoopConfigCommit.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onConfigApplied.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    await harness.reloader.stop();
  });

  it("runs account-scoped channel changes through hot reload", async () => {
    const channelRegistry = createTestRegistry([
      {
        pluginId: "mattermost",
        plugin: {
          id: "mattermost",
          meta: {
            id: "mattermost",
            label: "Mattermost",
            selectionLabel: "Mattermost",
            docsPath: "/channels/mattermost",
            blurb: "test",
          },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => ["default", "alpha"], resolveAccount: () => ({}) },
          reload: { configPrefixes: ["channels.mattermost"], accountScopedRestart: true },
        } satisfies ChannelPlugin,
        source: "test",
      },
    ]);
    const initialConfig = {
      gateway: { reload: {} },
      channels: { mattermost: { accounts: { alpha: { enabled: false } } } },
    } as OpenClawConfig;
    const nextConfig = {
      gateway: { reload: {} },
      channels: { mattermost: { accounts: { alpha: { enabled: true } } } },
    } as OpenClawConfig;
    const harness = createReloaderHarness(
      vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "account-reload" })),
      { initialConfig },
    );

    pinActivePluginChannelRegistry(channelRegistry);
    try {
      harness.watcher.emit("change");
      await vi.runAllTimersAsync();

      const [plan] = getOnlyHotReloadCall(harness);
      expect(plan.restartChannelAccounts).toEqual(new Map([["mattermost", new Set(["alpha"])]]));
      expect(harness.onNoopConfigCommit).not.toHaveBeenCalled();
    } finally {
      releasePinnedPluginChannelRegistry(channelRegistry);
      await harness.reloader.stop();
    }
  });

  it("plans one immutable runtime override snapshot per candidate", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      meta: { lastTouchedVersion: "initial" },
      messages: { visibleReplies: "automatic" },
    };
    let visibleRepliesOverride: "message_tool" | undefined;
    const prepareConfigCandidate = vi.fn(({ runtimeConfig, sourceConfig }) => {
      const override = visibleRepliesOverride;
      const applyCapturedOverride = (config: OpenClawConfig): OpenClawConfig =>
        override
          ? { ...config, messages: { ...config.messages, visibleReplies: override } }
          : config;
      return {
        runtimeConfig: applyCapturedOverride(runtimeConfig),
        compareConfig: applyCapturedOverride(sourceConfig),
      };
    });
    const readSnapshot = vi.fn();
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      prepareConfigCandidate,
    });
    const makeOverrideWrite = (
      config: OpenClawConfig,
      persistedHash: string,
    ): ConfigWriteNotification => ({
      configPath: "/tmp/openclaw.json",
      sourceConfig: config,
      runtimeConfig: config,
      persistedHash,
      revision: 1,
      fingerprint: `runtime-${persistedHash}`,
      sourceFingerprint: `source-${persistedHash}`,
      writtenAtMs: Date.now(),
    });

    visibleRepliesOverride = "message_tool";
    const overrideSource: OpenClawConfig = {
      ...initialConfig,
      meta: { lastTouchedVersion: "override-active" },
    };
    harness.emitWrite(makeOverrideWrite(overrideSource, "override-active"));
    await vi.runAllTimersAsync();

    expect(harness.onNoopConfigCommit.mock.calls[0]?.[0].noopPaths).toContain(
      "messages.visibleReplies",
    );
    expect(harness.onNoopConfigCommit.mock.calls[0]?.[1].messages?.visibleReplies).toBe(
      "message_tool",
    );

    visibleRepliesOverride = undefined;
    const resetSource: OpenClawConfig = {
      ...initialConfig,
      meta: { lastTouchedVersion: "override-reset" },
    };
    harness.emitWrite(makeOverrideWrite(resetSource, "override-reset"));
    await vi.runAllTimersAsync();

    expect(harness.onNoopConfigCommit.mock.calls[1]?.[0].noopPaths).toContain(
      "messages.visibleReplies",
    );
    expect(harness.onNoopConfigCommit.mock.calls[1]?.[1].messages?.visibleReplies).toBe(
      "automatic",
    );
    await harness.reloader.stop();
  });

  it("notifies lifecycle owners before hot reload and commits after success", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      agents: { defaults: { sandbox: { mode: "off" } } },
      hooks: { enabled: false },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      agents: { defaults: { sandbox: { mode: "all" } } },
      hooks: { enabled: true },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "hot" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigChange.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onHotReload.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(harness.onHotReload.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onConfigApplied.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(harness.onConfigRevisionApplied).toHaveBeenCalledWith(
      hashRuntimeConfigValue(nextConfig),
    );
    await harness.reloader.stop();
  });

  it("notifies lifecycle owners before queuing a terminal disable restart", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {}, terminal: { enabled: false } },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "terminal" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(harness.onConfigChange).toHaveBeenCalledTimes(1);
    expect(harness.onConfigApplied).not.toHaveBeenCalled();
    expect(harness.onConfigRevisionApplied).not.toHaveBeenCalled();
    expect(harness.onRestart).toHaveBeenCalledTimes(1);
    expect(harness.onConfigChange.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onRestart.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    await harness.reloader.stop();
  });

  it("keeps restart preparation inside the accepted config root", async () => {
    let releaseRestart = () => {};
    let noteRestartStarted = () => {};
    const restartStarted = new Promise<void>((resolve) => {
      noteRestartStarted = resolve;
    });
    const restartPending = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {}, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {}, terminal: { enabled: false } },
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, hash: "restart-root" }),
      {
        initialConfig,
        runTransaction: runWithGatewayIndependentRootWorkAdmission,
        onRestart: async () => {
          noteRestartStarted();
          await restartPending;
        },
      },
    );

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();
    await restartStarted;

    expect(getActiveGatewayRootWorkCount()).toBe(1);
    releaseRestart();
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    await harness.reloader.stop();
  });

  it("does not notify lifecycle owners when reload mode ignores the change", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" }, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" }, terminal: { enabled: false } },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "off" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigChange).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    await harness.reloader.stop();
  });

  it("notifies lifecycle owners when hybrid mode applies a restart-only change", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hybrid" }, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hybrid" }, terminal: { enabled: false } },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "hot" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigChange).toHaveBeenCalledOnce();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).toHaveBeenCalledOnce();
    await harness.reloader.stop();
  });

  it("retries missing snapshots and reloads once config file reappears", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ exists: false, raw: null, hash: "missing-1" }))
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: {} },
            hooks: { enabled: true },
          },
          hash: "next-1",
        }),
      );
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("unlink");
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(150);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("config reload retry (1/2): config file not found");
    expect(log.warn).not.toHaveBeenCalledWith("config reload skipped (config file not found)");

    await reloader.stop();
  });

  it("caps missing-file retries and skips reload after retry budget is exhausted", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValue(makeSnapshot({ exists: false, raw: null, hash: "missing" }));
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("unlink");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(onHotReload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("config reload skipped (config file not found)");

    await reloader.stop();
  });

  it("contains restart callback failures and retries the same persisted config", async () => {
    const snapshot = makeSnapshot({
      config: {
        gateway: { reload: {}, port: 18790 },
      },
      hash: "restart-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot);
    const promoteSnapshot = vi.fn(async () => true);
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
    });
    onRestart.mockRejectedValueOnce(new Error("restart-check failed"));
    onRestart.mockResolvedValueOnce(undefined);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onHotReload).not.toHaveBeenCalled();
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith("config restart failed: Error: restart-check failed");
      expect(log.error).toHaveBeenCalledWith("config reload failed: Error: restart-check failed");
      expect(promoteSnapshot).not.toHaveBeenCalled();
      expect(unhandled).toStrictEqual([]);

      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onRestart).toHaveBeenCalledTimes(2);
      expect(promoteSnapshot).toHaveBeenCalledWith(snapshot, "valid-config");
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await reloader.stop();
    }
  });

  it("logs expected restart supersession without reporting a reload failure", async () => {
    const snapshot = makeSnapshot({
      config: {
        gateway: { reload: {}, port: 18790 },
      },
      hash: "restart-superseded-1",
    });
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(snapshot);
    const { watcher, onRestart, log, reloader } = createReloaderHarness(readSnapshot);
    const superseded = new Error("config reload superseded by a newer runtime config source");
    superseded.name = "GatewayConfigReloadSupersededError";
    onRestart.mockRejectedValueOnce(superseded);

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(log.info).toHaveBeenCalledWith(
      "config restart superseded: GatewayConfigReloadSupersededError: config reload superseded by a newer runtime config source",
    );
    expect(log.info).toHaveBeenCalledWith(
      "config reload superseded: GatewayConfigReloadSupersededError: config reload superseded by a newer runtime config source",
    );
    expect(log.error).not.toHaveBeenCalled();

    await reloader.stop();
  });

  it("skips invalid external config edits without recovery", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        valid: false,
        raw: "{ gateway: { mode: 123 } }",
        issues: [{ path: "gateway.mode", message: "Expected string" }],
        hash: "bad-1",
      }),
    );
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
    });

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(onHotReload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(promoteSnapshot).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "config reload skipped (invalid config): gateway.mode: Expected string",
    );

    await reloader.stop();
  });

  it("skips plugin-local invalid reloads without degraded mode", async () => {
    const activeConfig: OpenClawConfig = {
      gateway: { reload: {} },
      agents: { defaults: { model: "gpt-5.4" } },
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
            config: { compactionMode: "adaptive", cacheAwareCompaction: true },
          },
        },
      },
    };
    const invalidSnapshot = makeSnapshot({
      valid: false,
      raw: `${JSON.stringify(activeConfig, null, 2)}\n`,
      parsed: activeConfig,
      sourceConfig: activeConfig,
      runtimeConfig: activeConfig,
      config: activeConfig,
      issues: [
        {
          path: "plugins.entries.lossless-claw.config.cacheAwareCompaction",
          message: "invalid config: must NOT have additional properties",
        },
      ],
      hash: "plugin-skew-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(invalidSnapshot);
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const previousConfig: OpenClawConfig = {
      ...activeConfig,
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
            config: { compactionMode: "adaptive" },
          },
        },
      },
    };
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot, {
      initialCompareConfig: previousConfig,
      promoteSnapshot,
    });

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
    expect(onHotReload).not.toHaveBeenCalled();
    expect(promoteSnapshot).not.toHaveBeenCalled();
    expect(
      log.warn.mock.calls.some(([message]) =>
        message.includes(
          "config reload skipped (invalid config): plugins.entries.lossless-claw.config.cacheAwareCompaction:",
        ),
      ),
    ).toBe(true);

    await reloader.stop();
  });

  it("promotes valid external config edits after they are accepted", async () => {
    const acceptedSnapshot = makeSnapshot({
      config: {
        gateway: { reload: {} },
        hooks: { enabled: true },
      },
      hash: "external-good-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(acceptedSnapshot);
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const { watcher, onHotReload, reloader } = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
    });

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(promoteSnapshot).toHaveBeenCalledWith(acceptedSnapshot, "valid-config");

    await reloader.stop();
  });

  it("does not promote external config edits when hot reload rejects them", async () => {
    const acceptedSnapshot = makeSnapshot({
      config: {
        gateway: { reload: {} },
        hooks: { enabled: true },
      },
      hash: "external-rejected-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(acceptedSnapshot);
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const { watcher, onConfigApplied, onHotReload, log, reloader } = createReloaderHarness(
      readSnapshot,
      { promoteSnapshot },
    );
    onHotReload.mockRejectedValueOnce(new Error("reload refused"));

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(onConfigApplied).not.toHaveBeenCalled();
    expect(promoteSnapshot).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("config reload failed: Error: reload refused");

    await reloader.stop();
  });

  it("retries the same external snapshot after a pre-commit hot reload failure", async () => {
    const snapshot = makeZeroDebounceHookSnapshot("external-retry-1");
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(snapshot);
    const { watcher, onConfigApplied, onHotReload, reloader } = createReloaderHarness(readSnapshot);
    onHotReload.mockRejectedValueOnce(new Error("reload refused"));

    watcher.emit("change");
    await vi.runAllTimersAsync();
    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(onHotReload).toHaveBeenCalledTimes(2);
    expect(onConfigApplied).toHaveBeenCalledTimes(1);
    await reloader.stop();
  });

  it("lets the watcher retry a failed in-process write with the same persisted hash", async () => {
    const snapshot = makeZeroDebounceHookSnapshot("internal-retry-1");
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(snapshot);
    const harness = createReloaderHarness(readSnapshot);
    harness.onHotReload.mockRejectedValueOnce(new Error("reload refused"));

    harness.emitWrite(makeZeroDebounceHookWrite("internal-retry-1"));
    await vi.runAllTimersAsync();
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onHotReload).toHaveBeenCalledTimes(2);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    await harness.reloader.stop();
  });

  it("keeps accepted external config reloads applied when last-known-good promotion fails", async () => {
    const acceptedSnapshot = makeSnapshot({
      config: {
        gateway: { reload: {} },
        hooks: { enabled: true },
      },
      hash: "external-promotion-fails-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(acceptedSnapshot);
    const promoteSnapshot = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { watcher, onHotReload, log, reloader } = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
    });

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(promoteSnapshot).toHaveBeenCalledWith(acceptedSnapshot, "valid-config");
    expect(log.warn).toHaveBeenCalledWith(
      "config reload last-known-good promotion failed: Error: disk full",
    );

    await reloader.stop();
  });

  it("reuses in-process write notifications and dedupes watcher rereads by persisted hash", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeZeroDebounceHookSnapshot("internal-1"))
      .mockResolvedValueOnce(makeZeroDebounceHookSnapshot("internal-1"))
      .mockResolvedValueOnce(
        makeSnapshot({
          sourceConfig: {
            gateway: { reload: {}, port: 19001 },
          },
          runtimeConfig: {
            gateway: { reload: {}, port: 19001 },
          },
          config: {
            gateway: { reload: {}, port: 19001 },
          },
          hash: "external-1",
        }),
      );
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const harness = createReloaderHarness(readSnapshot, { promoteSnapshot });

    harness.emitWrite(makeZeroDebounceHookWrite("internal-1"));
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);
    const [promotedSnapshot, promotionReason] = getOnlyPromoteSnapshotCall(promoteSnapshot);
    expect(promotedSnapshot?.hash).toBe("internal-1");
    expect(promotionReason).toBe("in-process-write");

    harness.watcher.emit("change");
    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);
    expect(harness.onRestart).toHaveBeenCalledTimes(1);

    await harness.reloader.stop();
  });

  it("honors in-process write intent to skip reload", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeZeroDebounceHookSnapshot("internal-none"));
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const harness = createReloaderHarness(readSnapshot, { promoteSnapshot });

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("internal-none"),
      afterWrite: { mode: "none", reason: "caller handles follow-up" },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.log.info).toHaveBeenCalledWith(
      "config reload skipped by writer intent (caller handles follow-up)",
    );
    const [promotedSnapshot, promotionReason] = getOnlyPromoteSnapshotCall(promoteSnapshot);
    expect(promotedSnapshot?.hash).toBe("internal-none");
    expect(promotionReason).toBe("in-process-write");

    await harness.reloader.stop();
  });

  it.each([
    { label: "accepted", afterWrite: undefined, reloadMode: "hybrid", expected: "candidate" },
    {
      label: "afterWrite none",
      afterWrite: { mode: "none" as const, reason: "source-only" },
      reloadMode: "hybrid",
      expected: "old",
    },
    { label: "reload off", afterWrite: undefined, reloadMode: "off", expected: "old" },
    {
      label: "hybrid restart",
      afterWrite: undefined,
      reloadMode: "hybrid",
      expected: "candidate",
    },
  ] as const)(
    "publishes config env only for a runtime-applied $label transaction",
    async (testCase) => {
      const envKey = "OPENCLAW_TEST_RELOAD_TRANSACTION_ENV";
      const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
      const initialConfig = {
        gateway: { reload: { mode: testCase.reloadMode } },
        env: { vars: { [envKey]: "old" } },
      } satisfies OpenClawConfig;
      const nextConfig = {
        ...initialConfig,
        gateway: { ...initialConfig.gateway, port: 19001 },
        env: { vars: { [envKey]: "candidate" } },
      } satisfies OpenClawConfig;
      const runtimeEnv = prepareConfigRuntimeEnv({
        previousConfig: initialConfig,
        nextConfig,
        env: targetEnv,
        previousOwnedEnv: { [envKey]: "old" },
      });
      const harness = createReloaderHarness(vi.fn(), { initialConfig });

      harness.emitWrite({
        configPath: "/tmp/openclaw.json",
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        preparedCandidate: { runtimeConfig: nextConfig, compareConfig: nextConfig, runtimeEnv },
        persistedHash: `env-${testCase.label}`,
        revision: 1,
        fingerprint: `runtime-env-${testCase.label}`,
        sourceFingerprint: `source-env-${testCase.label}`,
        writtenAtMs: Date.now(),
        ...(testCase.afterWrite ? { afterWrite: testCase.afterWrite } : {}),
      });
      await vi.runAllTimersAsync();

      expect(runtimeEnv.env[envKey]).toBe("candidate");
      expect(targetEnv[envKey]).toBe(testCase.expected);
      await harness.reloader.stop();
    },
  );

  it.each([
    { label: "rejected before runtime commit", markCommitted: false, expected: "old" },
    { label: "failed after runtime commit", markCommitted: true, expected: "candidate" },
  ] as const)("$label handles published config env ownership", async (testCase) => {
    const envKey = "OPENCLAW_TEST_RELOAD_ENV_COMMIT_EDGE";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test", path: "/old" },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/next" },
      env: { vars: { [envKey]: "candidate" } },
    } satisfies OpenClawConfig;
    const compareConfig = {
      ...nextConfig,
      env: initialConfig.env,
    } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: initialConfig,
      nextConfig,
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "old" },
    });
    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      onHotReload: async (plan, runtimeConfig, ownership) => {
        ownership.publishRuntimeEnv();
        expect(targetEnv[envKey]).toBe("candidate");
        if (testCase.markCommitted) {
          ownership.markRuntimeCommitted(runtimeConfig, plan);
        }
        throw new Error("hot reload failed");
      },
    });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      preparedCandidate: { runtimeConfig: nextConfig, compareConfig, runtimeEnv },
      persistedHash: `env-${testCase.label}`,
      revision: 1,
      fingerprint: `runtime-env-${testCase.label}`,
      sourceFingerprint: `source-env-${testCase.label}`,
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(targetEnv[envKey]).toBe(testCase.expected);
    await harness.reloader.stop();
  });

  it("keeps a deferred config env candidate isolated when a watcher supersedes it", async () => {
    const envKey = "OPENCLAW_TEST_SUPERSEDED_RELOAD_ENV";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: {} },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      ...initialConfig,
      gateway: { ...initialConfig.gateway, port: 19001 },
      env: { vars: { [envKey]: "candidate" } },
    } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: initialConfig,
      nextConfig,
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "old" },
    });
    let releaseRestart = () => {};
    const restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    const harness = createReloaderHarness(
      vi.fn(async () => makeSnapshot({ config: initialConfig, hash: "superseding-env" })),
      {
        initialConfig,
        onRestart: async () => await restartGate,
      },
    );

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      preparedCandidate: { runtimeConfig: nextConfig, compareConfig: nextConfig, runtimeEnv },
      persistedHash: "deferred-env",
      revision: 1,
      fingerprint: "runtime-deferred-env",
      sourceFingerprint: "source-deferred-env",
      writtenAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(targetEnv[envKey]).toBe("old");

    harness.watcher.emit("change");
    releaseRestart();
    await vi.runAllTimersAsync();

    expect(targetEnv[envKey]).toBe("old");
    await harness.reloader.stop();
  });

  it("reprepares a stale managed-write env candidate after another transaction accepts", async () => {
    const envKey = "OPENCLAW_TEST_INTERLEAVED_RELOAD_ENV";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "a" };
    const makeConfig = (value: string, port: number): OpenClawConfig => ({
      gateway: { reload: {}, port },
      env: { vars: { [envKey]: value } },
    });
    const configA = makeConfig("a", 18_789);
    const configB = makeConfig("b", 19_001);
    const configC = makeConfig("c", 19_002);
    const staleRuntimeEnv = prepareConfigRuntimeEnv({
      previousConfig: configA,
      nextConfig: configB,
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "a" },
    });
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        sourceConfig: configC,
        runtimeConfig: configC,
        config: configC,
        hash: "env-c",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig: configA,
      prepareConfigCandidate: ({ runtimeConfig, sourceConfig, previousSourceConfig }) => ({
        runtimeConfig,
        compareConfig: sourceConfig,
        runtimeEnv: prepareConfigRuntimeEnv({
          previousConfig: previousSourceConfig,
          nextConfig: sourceConfig,
          env: targetEnv,
          previousOwnedEnv: {
            [envKey]: previousSourceConfig.env?.vars?.[envKey] ?? "",
          },
        }),
      }),
    });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    expect(targetEnv[envKey]).toBe("c");

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: configB,
      runtimeConfig: configB,
      preparedCandidate: {
        runtimeConfig: configB,
        compareConfig: configB,
        runtimeEnv: staleRuntimeEnv,
      },
      persistedHash: "env-b",
      revision: 2,
      fingerprint: "runtime-env-b",
      sourceFingerprint: "source-env-b",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(targetEnv[envKey]).toBe("b");
    await harness.reloader.stop();
  });

  it("honors in-process write intent to force restart", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeZeroDebounceHookSnapshot("internal-restart"));
    const harness = createReloaderHarness(readSnapshot);

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("internal-restart"),
      afterWrite: { mode: "restart", reason: "plugin runtime contract changed" },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    const [plan, nextConfig] = getOnlyRestartCall(harness);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual(["plugin runtime contract changed"]);
    expect(nextConfig).toEqual({
      gateway: { reload: {} },
      hooks: { enabled: true },
    });

    await harness.reloader.stop();
  });

  it.each([
    {
      label: "none",
      afterWrite: { mode: "none" as const, reason: "caller handles follow-up" },
    },
    {
      label: "restart",
      afterWrite: { mode: "restart" as const, reason: "plugin runtime contract changed" },
    },
  ])("preserves slow in-process $label intent across its watcher echo", async (testCase) => {
    const hash = `slow-${testCase.label}`;
    let releasePluginRead = () => {};
    let recordPluginReadStarted: (() => void) | undefined;
    const pluginReadStarted = new Promise<void>((resolve) => {
      recordPluginReadStarted = resolve;
    });
    const pluginReadGate = new Promise<void>((resolve) => {
      releasePluginRead = resolve;
    });
    const readPluginInstallRecords = vi.fn(async () => {
      recordPluginReadStarted?.();
      await pluginReadGate;
      return {};
    });
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot(hash));
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const harness = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
      readPluginInstallRecords,
    });

    harness.emitWrite({
      ...makeZeroDebounceHookWrite(hash),
      afterWrite: testCase.afterWrite,
    });
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted;

    harness.watcher.emit("change");
    releasePluginRead();
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(readPluginInstallRecords).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(promoteSnapshot).toHaveBeenCalledOnce();
    expect(promoteSnapshot.mock.calls[0]?.[1]).toBe("in-process-write");
    if (testCase.afterWrite.mode === "none") {
      expect(harness.onHotReload).not.toHaveBeenCalled();
      expect(harness.onRestart).not.toHaveBeenCalled();
      expect(harness.log.info).toHaveBeenCalledWith(
        "config reload skipped by writer intent (caller handles follow-up)",
      );
    } else {
      expect(harness.onHotReload).not.toHaveBeenCalled();
      const [plan] = getOnlyRestartCall(harness);
      expect(plan.restartReasons).toEqual(["plugin runtime contract changed"]);
    }

    await harness.reloader.stop();
  });

  it("discards slow in-process intent when the watcher proves different bytes", async () => {
    const initialConfig = {
      gateway: { reload: {} },
    } satisfies OpenClawConfig;
    let releasePluginRead = () => {};
    let recordPluginReadStarted: (() => void) | undefined;
    const pluginReadStarted = new Promise<void>((resolve) => {
      recordPluginReadStarted = resolve;
    });
    const pluginReadGate = new Promise<void>((resolve) => {
      releasePluginRead = resolve;
    });
    const readPluginInstallRecords = vi.fn(async () => {
      recordPluginReadStarted?.();
      await pluginReadGate;
      return {};
    });
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({ config: initialConfig, hash: "external-b" }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      readPluginInstallRecords,
    });

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("slow-restart-a"),
      afterWrite: { mode: "restart", reason: "must not survive external B" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted;

    harness.watcher.emit("change");
    releasePluginRead();
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toEqual(initialConfig);

    await harness.reloader.stop();
  });

  it("uses a freshly resolved snapshot when the root hash still matches writer intent", async () => {
    const freshConfig = {
      gateway: { reload: {} },
      hooks: { enabled: false },
    } satisfies OpenClawConfig;
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: freshConfig,
        sourceConfig: freshConfig,
        runtimeConfig: freshConfig,
        hash: "same-root-hash",
      }),
    );
    const harness = createReloaderHarness(readSnapshot);

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("same-root-hash"),
      afterWrite: { mode: "none", reason: "stale resolved intent" },
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    const [, hotConfig] = getOnlyHotReloadCall(harness);
    expect(hotConfig).toEqual(freshConfig);
    expect(harness.onConfigAccepted).toHaveBeenCalledWith(
      freshConfig,
      expect.any(Object),
      freshConfig,
      { runtimeApplied: true },
    );
    expect(harness.log.info).not.toHaveBeenCalledWith(
      "config reload skipped by writer intent (stale resolved intent)",
    );

    await harness.reloader.stop();
  });

  it("preserves writer intent when the runtime notification contains resolved secrets", async () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "GATEWAY_RELOAD_TEST_TOKEN",
    };
    const sourceConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: secretRef },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: "resolved-test-token" },
      },
    } satisfies OpenClawConfig;
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: sourceConfig,
        sourceConfig,
        runtimeConfig: sourceConfig,
        hash: "secret-ref-write",
      }),
    );
    const harness = createReloaderHarness(readSnapshot);

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig,
      runtimeConfig,
      persistedHash: "secret-ref-write",
      revision: 1,
      fingerprint: "runtime-secret-ref-write",
      sourceFingerprint: "source-secret-ref-write",
      writtenAtMs: Date.now(),
      afterWrite: { mode: "none", reason: "secret-aware writer intent" },
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigAccepted).toHaveBeenCalledWith(
      runtimeConfig,
      expect.any(Object),
      sourceConfig,
      { runtimeApplied: false },
    );
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.log.info).toHaveBeenCalledWith(
      "config reload skipped by writer intent (secret-aware writer intent)",
    );

    await harness.reloader.stop();
  });

  it("publishes a managed source edit when runtime overlays mask every effective change", async () => {
    const initialConfig = {
      gateway: { reload: {} },
      logging: { level: "info" as const },
    } satisfies OpenClawConfig;
    const sourceConfig = {
      ...initialConfig,
      logging: { level: "debug" as const },
    } satisfies OpenClawConfig;
    const harness = createReloaderHarness(vi.fn(), { initialConfig });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig,
      runtimeConfig: sourceConfig,
      preparedCandidate: {
        runtimeConfig: initialConfig,
        compareConfig: initialConfig,
        reapplyRuntimeOverlays: () => initialConfig,
      },
      persistedHash: "masked-source-edit",
      revision: 1,
      fingerprint: "runtime-masked-source-edit",
      sourceFingerprint: "source-masked-source-edit",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(harness.onEffectiveConfigUnchanged).toHaveBeenCalledWith(
      initialConfig,
      expect.any(Object),
      sourceConfig,
    );
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();

    await harness.reloader.stop();
  });

  it("does not publish a masked source edit when acceptance fails", async () => {
    const initialConfig = {
      gateway: { reload: {} },
      logging: { level: "info" as const },
    } satisfies OpenClawConfig;
    const sourceConfig = {
      ...initialConfig,
      logging: { level: "debug" as const },
    } satisfies OpenClawConfig;
    const harness = createReloaderHarness(vi.fn(), {
      initialConfig,
      onConfigAccepted: async () => {
        throw new Error("restart debt admission failed");
      },
    });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig,
      runtimeConfig: sourceConfig,
      preparedCandidate: {
        runtimeConfig: initialConfig,
        compareConfig: initialConfig,
        reapplyRuntimeOverlays: () => initialConfig,
      },
      persistedHash: "masked-source-rejected",
      revision: 1,
      fingerprint: "runtime-masked-source-rejected",
      sourceFingerprint: "source-masked-source-rejected",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(harness.onEffectiveConfigUnchanged).not.toHaveBeenCalled();
    expect(harness.log.error).toHaveBeenCalledWith(
      "config reload failed: Error: restart debt admission failed",
    );

    await harness.reloader.stop();
  });

  it("rolls back masked source publication when superseded after acceptance", async () => {
    const initialConfig = {
      gateway: { reload: {} },
      logging: { level: "info" as const },
    } satisfies OpenClawConfig;
    const sourceConfig = {
      ...initialConfig,
      logging: { level: "debug" as const },
    } satisfies OpenClawConfig;
    const publicationEvents: string[] = [];
    let publicationId = 0;
    const rollbackSource = vi.fn(async () => {});
    let emitSupersedingChange = () => {};
    const harness = createReloaderHarness(
      vi.fn(async () => makeSnapshot({ config: initialConfig, hash: "superseding-write" })),
      {
        initialConfig,
        onConfigAccepted: async (_nextConfig, _ownership, _sourceConfig, acceptance) => {
          const rollback = await acceptance.publishSource?.();
          queueMicrotask(emitSupersedingChange);
          return rollback;
        },
        onEffectiveConfigUnchanged: async () => {
          const id = publicationId++;
          return {
            rollback: async () => {
              publicationEvents.push(`rollback:${id}`);
              await rollbackSource();
            },
            commit: () => {
              publicationEvents.push(`commit:${id}`);
            },
          };
        },
      },
    );
    emitSupersedingChange = () => {
      emitSupersedingChange = () => {};
      harness.watcher.emit("change");
    };

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig,
      runtimeConfig: sourceConfig,
      preparedCandidate: {
        runtimeConfig: initialConfig,
        compareConfig: initialConfig,
        reapplyRuntimeOverlays: () => initialConfig,
      },
      persistedHash: "masked-source-superseded",
      revision: 1,
      fingerprint: "runtime-masked-source-superseded",
      sourceFingerprint: "source-masked-source-superseded",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(harness.onEffectiveConfigUnchanged).toHaveBeenCalledTimes(2);
    expect(harness.onEffectiveConfigUnchanged.mock.calls.map((call) => call[2])).toEqual([
      sourceConfig,
      initialConfig,
    ]);
    expect(rollbackSource).toHaveBeenCalledOnce();
    expect(publicationEvents).toEqual(["rollback:0", "commit:1"]);

    await harness.reloader.stop();
  });

  it("retains the accepted candidate overlay when a watcher echoes the same hash", async () => {
    const sourceConfig = makeZeroDebounceHookWrite("overlay-echo").sourceConfig;
    const applyDebugOverride = (config: OpenClawConfig): OpenClawConfig => ({
      ...config,
      logging: { level: "debug" },
    });
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("overlay-echo"));
    const harness = createReloaderHarness(readSnapshot);

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("overlay-echo"),
      preparedCandidate: {
        runtimeConfig: applyDebugOverride(sourceConfig),
        compareConfig: sourceConfig,
        reapplyRuntimeOverlays: applyDebugOverride,
      },
    });
    await vi.runAllTimersAsync();
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigAccepted).toHaveBeenCalledTimes(2);
    const replayOwnership = harness.onConfigAccepted.mock.calls[1]?.[1];
    expect(replayOwnership?.reapplyRuntimeOverlays(sourceConfig).logging?.level).toBe("debug");

    await harness.reloader.stop();
  });

  it("rebinds a source-only restart target when its watcher echo advances ownership", async () => {
    const sourceConfig = makeZeroDebounceHookWrite("source-only-echo").sourceConfig;
    const applyDebugOverride = (config: OpenClawConfig): OpenClawConfig => ({
      ...config,
      logging: { level: "debug" },
    });
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("source-only-echo"));
    const harness = createReloaderHarness(readSnapshot);

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("source-only-echo"),
      afterWrite: { mode: "none", reason: "source owner handles follow-up" },
      preparedCandidate: {
        runtimeConfig: applyDebugOverride(sourceConfig),
        compareConfig: sourceConfig,
        reapplyRuntimeOverlays: applyDebugOverride,
      },
    });
    await vi.runAllTimersAsync();
    const originalOwnership = harness.onConfigAccepted.mock.calls[0]?.[1];

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigAccepted.mock.calls.map((call) => call[3])).toEqual([
      { runtimeApplied: false },
      { runtimeApplied: false },
    ]);
    expect(originalOwnership?.isCurrent()).toBe(false);
    const reboundOwnership = harness.onConfigAccepted.mock.calls[1]?.[1];
    expect(reboundOwnership?.isCurrent()).toBe(true);
    expect(reboundOwnership?.reapplyRuntimeOverlays(sourceConfig).logging?.level).toBe("debug");
    expect(harness.onConfigAccepted.mock.calls[1]?.[0]).toEqual(applyDebugOverride(sourceConfig));

    await harness.reloader.stop();
  });

  it("passes canonical SecretRef source config to direct restart preflight", async () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "DIRECT_RESTART_TOKEN",
    };
    const sourceConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: secretRef },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: "resolved-direct-token" },
      },
    } satisfies OpenClawConfig;
    const harness = createReloaderHarness(vi.fn());

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig,
      runtimeConfig,
      persistedHash: "direct-secret-restart",
      revision: 1,
      fingerprint: "runtime-direct-secret-restart",
      sourceFingerprint: "source-direct-secret-restart",
      writtenAtMs: Date.now(),
      afterWrite: { mode: "restart", reason: "direct source preflight" },
    });
    await vi.runAllTimersAsync();

    expect(harness.onRestart).toHaveBeenCalledOnce();
    expect(harness.onRestart.mock.calls[0]?.[1]).toEqual(runtimeConfig);
    expect(harness.onRestart.mock.calls[0]?.[3]).toEqual(sourceConfig);

    await harness.reloader.stop();
  });

  it("passes canonical SecretRef source config to watcher-replayed restart preflight", async () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "REPLAY_RESTART_TOKEN",
    };
    const sourceConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: secretRef },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      gateway: {
        reload: {},
        auth: { mode: "token" as const, token: "resolved-replay-token" },
      },
    } satisfies OpenClawConfig;
    let releasePluginRead = () => {};
    let recordPluginReadStarted: (() => void) | undefined;
    const pluginReadStarted = new Promise<void>((resolve) => {
      recordPluginReadStarted = resolve;
    });
    const pluginReadGate = new Promise<void>((resolve) => {
      releasePluginRead = resolve;
    });
    const readPluginInstallRecords = vi.fn(async () => {
      recordPluginReadStarted?.();
      await pluginReadGate;
      return {};
    });
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        config: sourceConfig,
        sourceConfig,
        runtimeConfig: sourceConfig,
        hash: "replay-secret-restart",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, { readPluginInstallRecords });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig,
      runtimeConfig,
      persistedHash: "replay-secret-restart",
      revision: 1,
      fingerprint: "runtime-replay-secret-restart",
      sourceFingerprint: "source-replay-secret-restart",
      writtenAtMs: Date.now(),
      afterWrite: { mode: "restart", reason: "replay source preflight" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted;
    harness.watcher.emit("change");
    releasePluginRead();
    await vi.runAllTimersAsync();

    expect(harness.onRestart).toHaveBeenCalledOnce();
    expect(harness.onRestart.mock.calls[0]?.[1]).toEqual(runtimeConfig);
    expect(harness.onRestart.mock.calls[0]?.[3]).toEqual(sourceConfig);

    await harness.reloader.stop();
  });

  it("rejects an invalid resolved snapshot even when the root hash matches writer intent", async () => {
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        valid: false,
        hash: "same-invalid-root-hash",
      }),
    );
    const harness = createReloaderHarness(readSnapshot);

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("same-invalid-root-hash"),
      afterWrite: { mode: "restart", reason: "must not replay invalid config" },
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();

    await harness.reloader.stop();
  });

  it("preserves the newest pending write when a watcher supersedes a slow write", async () => {
    let releasePluginRead = () => {};
    let recordPluginReadStarted: (() => void) | undefined;
    const pluginReadStarted = new Promise<void>((resolve) => {
      recordPluginReadStarted = resolve;
    });
    const pluginReadGate = new Promise<void>((resolve) => {
      releasePluginRead = resolve;
    });
    const readPluginInstallRecords = vi.fn(async () => {
      recordPluginReadStarted?.();
      await pluginReadGate;
      return {};
    });
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("newer-b"));
    const harness = createReloaderHarness(readSnapshot, { readPluginInstallRecords });

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("older-a"),
      afterWrite: { mode: "restart", reason: "obsolete A intent" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted;

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("newer-b"),
      afterWrite: { mode: "none", reason: "newest B intent" },
    });
    harness.watcher.emit("change");
    releasePluginRead();
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.log.info).toHaveBeenCalledWith(
      "config reload skipped by writer intent (newest B intent)",
    );

    await harness.reloader.stop();
  });

  it("preserves in-process intent through a transient missing-file retry", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ exists: false, valid: false }))
      .mockResolvedValueOnce(makeZeroDebounceHookSnapshot("missing-retry"));
    const harness = createReloaderHarness(readSnapshot);

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("missing-retry"),
      afterWrite: { mode: "none", reason: "intent survives missing file" },
    });
    harness.watcher.emit("unlink");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.log.info).toHaveBeenCalledWith(
      "config reload skipped by writer intent (intent survives missing file)",
    );

    await harness.reloader.stop();
  });

  it("retries failed watcher-replayed intent with the same persisted hash", async () => {
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("replay-retry"));
    const harness = createReloaderHarness(readSnapshot);
    harness.onRestart.mockRejectedValueOnce(new Error("restart admission failed"));

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("replay-retry"),
      afterWrite: { mode: "restart", reason: "retry original intent" },
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onRestart).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onHotReload).not.toHaveBeenCalled();

    await harness.reloader.stop();
  });

  it("preserves intent when the direct in-process reload fails before its watcher echo", async () => {
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("direct-retry"));
    const harness = createReloaderHarness(readSnapshot);
    harness.onRestart.mockRejectedValueOnce(new Error("restart admission failed"));

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("direct-retry"),
      afterWrite: { mode: "restart", reason: "retry direct intent" },
    });
    await vi.runAllTimersAsync();

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(harness.onRestart).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onHotReload).not.toHaveBeenCalled();

    await harness.reloader.stop();
  });

  it("plans in-process reloads from source config and ignores runtime materialized paths", async () => {
    const baseInstall = {
      source: "npm" as const,
      spec: "@martian-engineering/lossless-claw",
      installPath: "/tmp/lossless-claw",
      installedAt: "2026-04-22T00:00:00.000Z",
      resolvedAt: "2026-04-22T00:00:00.000Z",
    };
    const sourceConfig: OpenClawConfig = {
      gateway: { reload: {}, auth: { mode: "token" } },
      plugins: {
        installs: {
          "lossless-claw": baseInstall,
        },
      },
    };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: {
          ...sourceConfig,
          plugins: {
            installs: {
              "lossless-claw": {
                ...baseInstall,
                installedAt: "2026-04-22T00:01:00.000Z",
                resolvedAt: "2026-04-22T00:01:00.000Z",
              },
            },
          },
        },
        hash: "plugin-timestamps-1",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialCompareConfig: sourceConfig });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: {
        ...sourceConfig,
        plugins: {
          installs: {
            "lossless-claw": {
              ...baseInstall,
              installedAt: "2026-04-22T00:01:00.000Z",
              resolvedAt: "2026-04-22T00:01:00.000Z",
            },
          },
        },
      },
      runtimeConfig: {
        ...sourceConfig,
        gateway: { reload: {}, auth: { mode: "token", token: "runtime" } },
        plugins: {
          ...sourceConfig.plugins,
          entries: {
            firecrawl: {
              config: {
                webFetch: { provider: "firecrawl" },
              },
            },
          },
          installs: {
            "lossless-claw": {
              ...baseInstall,
              installedAt: "2026-04-22T00:01:00.000Z",
              resolvedAt: "2026-04-22T00:01:00.000Z",
            },
          },
        },
      },
      persistedHash: "plugin-timestamps-1",
      revision: 1,
      fingerprint: "runtime-plugin-timestamps-1",
      sourceFingerprint: "source-plugin-timestamps-1",
      writtenAtMs: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(
      harness.log.info.mock.calls.some(([message]) => message.includes("gateway.auth.token")),
    ).toBe(false);

    await harness.reloader.stop();
  });

  it("does not suppress functional install changes that collide with timestamp paths", async () => {
    const sourceConfig: OpenClawConfig = {
      gateway: { reload: {} },
      plugins: {
        installs: {
          lossless: {
            source: "npm",
            resolvedAt: "2026-04-22T00:00:00.000Z",
          },
        },
      },
    };
    const nextSourceConfig: OpenClawConfig = {
      gateway: { reload: {} },
      plugins: {
        installs: {
          lossless: {
            source: "npm",
            resolvedAt: "2026-04-22T00:01:00.000Z",
          },
          "lossless.resolvedAt": {
            source: "npm",
          },
        },
      },
    };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: nextSourceConfig,
        runtimeConfig: nextSourceConfig,
        config: nextSourceConfig,
        hash: "plugin-collision-1",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, { initialCompareConfig: sourceConfig });

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextSourceConfig,
      runtimeConfig: nextSourceConfig,
      persistedHash: "plugin-collision-1",
      revision: 1,
      fingerprint: "runtime-plugin-collision-1",
      sourceFingerprint: "source-plugin-collision-1",
      writtenAtMs: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    const [plan, nextConfig] = getOnlyRestartCall(harness);
    expect(plan.changedPaths).toEqual([
      "plugins.installs.lossless.resolvedAt",
      "plugins.installs.lossless.resolvedAt",
    ]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual([
      "plugins.installs.lossless.resolvedAt",
      "plugins.installs.lossless.resolvedAt",
    ]);
    expect(nextConfig.plugins?.installs?.["lossless.resolvedAt"]?.source).toBe("npm");

    await harness.reloader.stop();
  });

  it("queues restart when an external plugin source write only changes the managed index", async () => {
    const activeConfig: OpenClawConfig = {
      gateway: { reload: {} },
      plugins: {
        allow: ["lossless-claw"],
        entries: {
          "lossless-claw": { enabled: true },
        },
      },
    };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: activeConfig,
        runtimeConfig: activeConfig,
        config: activeConfig,
        hash: "external-plugin-index-1",
      }),
    );
    const readPluginInstallRecords = vi.fn().mockResolvedValueOnce({
      "lossless-claw": {
        source: "npm",
        spec: "@martian-engineering/lossless-claw",
        installPath: "/tmp/openclaw/plugins/lossless-claw",
        installedAt: "2026-04-22T00:00:00.000Z",
      },
    } satisfies Record<string, PluginInstallRecord>);
    const harness = createReloaderHarness(readSnapshot, {
      initialCompareConfig: activeConfig,
      initialPluginInstallRecords: {},
      readPluginInstallRecords,
    });

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    const [plan, nextConfig] = getOnlyRestartCall(harness);
    expect(plan.changedPaths).toEqual(["plugins.installs.lossless-claw"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual(["plugins.installs.lossless-claw"]);
    expect(nextConfig).toBe(activeConfig);

    await harness.reloader.stop();
  });

  it("reloads explicitly signaled plugin metadata when config bytes stay identical", async () => {
    const activeConfig: OpenClawConfig = {
      gateway: { reload: {} },
    };
    const readSnapshot = vi.fn(async () =>
      makeSnapshot({
        sourceConfig: activeConfig,
        runtimeConfig: activeConfig,
        config: activeConfig,
        hash: "unchanged-config",
      }),
    );
    const readPluginInstallRecords = vi.fn(async () => ({
      brave: {
        source: "npm" as const,
        spec: "@openclaw/brave",
        installPath: "/tmp/openclaw/plugins/brave",
      },
    }));
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig: activeConfig,
      initialCompareConfig: activeConfig,
      initialInternalWriteHash: "unchanged-config",
      initialPluginInstallRecords: {},
      readPluginInstallRecords,
    });

    harness.reloader.notifyPluginMetadataChanged();
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(readPluginInstallRecords).toHaveBeenCalledOnce();
    const [plan, nextConfig] = getOnlyRestartCall(harness);
    expect(plan.changedPaths).toEqual(["plugins.installs.brave"]);
    expect(plan.restartReasons).toEqual(["plugins.installs.brave"]);
    expect(nextConfig).toBe(activeConfig);

    await harness.reloader.stop();
  });

  it("keeps external plugin policy-only writes on the hot reload path", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { reload: {} },
      plugins: {
        entries: {
          telegram: { enabled: false },
        },
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    };
    const installRecords = {
      telegram: {
        source: "npm",
        spec: "@openclaw/telegram",
        installPath: "/tmp/openclaw/plugins/telegram",
      },
    } satisfies Record<string, PluginInstallRecord>;
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        config: nextConfig,
        hash: "external-plugin-policy-1",
      }),
    );
    const readPluginInstallRecords = vi.fn().mockResolvedValueOnce(installRecords);
    const harness = createReloaderHarness(readSnapshot, {
      initialCompareConfig: previousConfig,
      initialPluginInstallRecords: installRecords,
      readPluginInstallRecords,
    });

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onRestart).not.toHaveBeenCalled();
    const [plan, hotConfig] = getOnlyHotReloadCall(harness);
    expect(plan.changedPaths).toEqual(["plugins.entries.telegram.enabled"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.hotReasons).toEqual(["plugins.entries.telegram.enabled"]);
    expect(hotConfig).toBe(nextConfig);

    await harness.reloader.stop();
  });

  it("queues restart when an external plugin source write also changes plugin config", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { reload: {} },
      plugins: {
        allow: ["lossless-claw"],
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      plugins: {
        allow: ["lossless-claw"],
        entries: {
          "lossless-claw": { enabled: true },
        },
      },
    };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        config: nextConfig,
        hash: "external-plugin-source-and-config-1",
      }),
    );
    const readPluginInstallRecords = vi.fn().mockResolvedValueOnce({
      "lossless-claw": {
        source: "npm",
        spec: "@martian-engineering/lossless-claw",
        installPath: "/tmp/openclaw/plugins/lossless-claw",
        installedAt: "2026-04-22T00:00:00.000Z",
      },
    } satisfies Record<string, PluginInstallRecord>);
    const harness = createReloaderHarness(readSnapshot, {
      initialCompareConfig: previousConfig,
      initialPluginInstallRecords: {},
      readPluginInstallRecords,
    });

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    const [plan, restartedConfig] = getOnlyRestartCall(harness);
    expect(plan.changedPaths).toEqual(["plugins.entries", "plugins.installs.lossless-claw"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual(["plugins.installs.lossless-claw"]);
    expect(restartedConfig).toBe(nextConfig);

    await harness.reloader.stop();
  });

  it("skips in-process promotion when the persisted file hash no longer matches the write", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: {
          gateway: { reload: {}, port: 19002 },
        },
        runtimeConfig: {
          gateway: { reload: {}, port: 19002 },
        },
        config: {
          gateway: { reload: {}, port: 19002 },
        },
        hash: "racing-external-edit",
      }),
    );
    const promoteSnapshot = vi.fn(async () => true);
    const harness = createReloaderHarness(readSnapshot, { promoteSnapshot });

    harness.emitWrite(makeZeroDebounceHookWrite("internal-1"));
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).toHaveBeenCalledTimes(1);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(promoteSnapshot).not.toHaveBeenCalled();
    expect(harness.log.warn).not.toHaveBeenCalled();

    await harness.reloader.stop();
  });

  it("dedupes only the first watcher reread for startup internal writes", async () => {
    const startupConfig = {
      gateway: { reload: {}, auth: { mode: "token" as const, token: "startup" } },
    } satisfies OpenClawConfig;
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          config: startupConfig,
          hash: "startup-internal-1",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: {}, port: 19001 },
          },
          hash: "startup-internal-1",
        }),
      );
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig: startupConfig,
      initialInternalWriteHash: "startup-internal-1",
    });

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onRestart).toHaveBeenCalledTimes(1);

    await harness.reloader.stop();
  });

  it("preserves live writer intent before the startup watcher echo", async () => {
    const readSnapshot = vi.fn(async () => makeZeroDebounceHookSnapshot("startup-internal-1"));
    const harness = createReloaderHarness(readSnapshot, {
      initialInternalWriteHash: "startup-internal-1",
    });

    harness.emitWrite({
      ...makeZeroDebounceHookWrite("startup-internal-1"),
      afterWrite: { mode: "restart", reason: "live writer owns startup hash" },
    });
    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onRestart).toHaveBeenCalledOnce();
    expect(harness.onRestart.mock.calls[0]?.[0].restartReasons).toContain(
      "live writer owns startup hash",
    );

    await harness.reloader.stop();
  });

  it("does not dedupe when initialInternalWriteHash is null (#67436)", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        config: {
          gateway: { reload: {}, auth: { mode: "token", token: "startup" } },
        },
        hash: "startup-internal-1",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialInternalWriteHash: null,
    });

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    // With a null hash the guard is a no-op, so the reload proceeds and
    // detects a config diff → restart.  This is the pre-fix regression
    // scenario from #67436 where plugin auto-enable was the only startup
    // writer and the hash was never captured.
    expect(harness.onRestart).toHaveBeenCalledTimes(1);

    await harness.reloader.stop();
  });
});

describe("startGatewayConfigReloader watcher error recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startReloaderWithWatchers(watchers: ReturnType<typeof createWatcherMock>[]) {
    const watchSpy = vi.spyOn(chokidar, "watch");
    let watcherIndex = 0;
    watchSpy.mockImplementation((_path, options) => {
      const watcher = watchers[watcherIndex++];
      if (!watcher) {
        throw new Error("missing watcher mock");
      }
      watcher.options.usePolling = watcher.effectiveUsePolling ?? Boolean(options?.usePolling);
      return watcher as unknown as never;
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const readSnapshot = vi.fn(async () => makeSnapshot());
    const reloader = startGatewayConfigReloader({
      initialConfig: { gateway: { reload: {} } },
      initialSnapshotRawHash: "initial-raw-hash",
      initialAuthoredConfig: {},
      initialSnapshotValid: true,
      initialSnapshotIssues: [],
      readSnapshot,
      initialPluginInstallRecords: {},
      readPluginInstallRecords: async () => ({}),
      onNoopConfigCommit: vi.fn(async () => {}),
      onHotReload: vi.fn(async () => {}),
      onRestart: vi.fn(),
      log,
      watchPath: "/tmp/openclaw.json",
    });
    return { watchSpy, readSnapshot, log, reloader };
  }

  it("re-creates the watcher with backoff and reconciles after it is ready", async () => {
    const first = createWatcherMock();
    const second = createWatcherMock();
    const { watchSpy, readSnapshot, log, reloader } = startReloaderWithWatchers([first, second]);

    expect(watchSpy).toHaveBeenCalledTimes(1);
    first.emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(readSnapshot).not.toHaveBeenCalled();

    first.emit("error");
    expect(reloader.hotReloadStatus()).toBe("active");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("re-creating watcher (attempt 1/3 in 500ms)"),
    );
    expect(first.close).toHaveBeenCalledTimes(1);

    // Watcher is only re-created once the backoff timer fires.
    expect(watchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(watchSpy).toHaveBeenCalledTimes(2);
    expect(readSnapshot).not.toHaveBeenCalled();
    second.emit("ready");
    await vi.runOnlyPendingTimersAsync();
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(reloader.hotReloadStatus()).toBe("active");
    expect(log.error).not.toHaveBeenCalled();

    await reloader.stop();
  });

  it("ignores ready from a replacement watcher that already failed", async () => {
    const first = createWatcherMock();
    const failedReplacement = createWatcherMock();
    const recoveredReplacement = createWatcherMock();
    const { readSnapshot, reloader } = startReloaderWithWatchers([
      first,
      failedReplacement,
      recoveredReplacement,
    ]);

    first.emit("error");
    await vi.advanceTimersByTimeAsync(500);
    failedReplacement.emit("error");
    failedReplacement.emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(readSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    recoveredReplacement.emit("ready");
    await vi.runOnlyPendingTimersAsync();
    expect(readSnapshot).toHaveBeenCalledTimes(1);

    await reloader.stop();
  });

  it("keeps hot-reload active when transient errors are separated by working watchers", async () => {
    const originalVitest = process.env.VITEST;
    const originalChokidarPolling = process.env.CHOKIDAR_USEPOLLING;
    delete process.env.VITEST;
    delete process.env.CHOKIDAR_USEPOLLING;
    let reloader: { stop: () => Promise<void>; hotReloadStatus: () => string } | undefined;
    try {
      // One initial watcher plus one re-create per error/recovery round.
      const watchers = Array.from({ length: 5 }, () => createWatcherMock());
      const started = startReloaderWithWatchers(watchers);
      const { watchSpy, log } = started;
      reloader = started.reloader;
      const watchOptions = (index: number) =>
        watchSpy.mock.calls[index]?.[1] as { usePolling?: boolean } | undefined;

      // The initial error consumes one attempt. Every replacement then proves
      // itself before failing, so each new episode must restart at attempt one.
      watchers[0]?.emit("error");
      expect(log.warn).toHaveBeenLastCalledWith(
        expect.stringContaining("re-creating watcher (attempt 1/3 in 500ms)"),
      );
      await vi.advanceTimersByTimeAsync(500);

      for (let round = 1; round < 4; round += 1) {
        watchers[round]?.emit("change");
        await vi.advanceTimersByTimeAsync(0);
        watchers[round]?.emit("error");
        expect(log.warn).toHaveBeenLastCalledWith(
          expect.stringContaining("re-creating watcher (attempt 1/3 in 500ms)"),
        );
        await vi.advanceTimersByTimeAsync(500);
        expect(watchSpy).toHaveBeenCalledTimes(round + 2);
      }

      // Hot-reload survives in native mode: no polling degradation, no disable.
      expect(reloader.hotReloadStatus()).toBe("active");
      expect(log.warn).toHaveBeenCalledTimes(4);
      expect(watchOptions(4)?.usePolling).toBe(false);
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("degrading to polling mode"),
      );
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      if (originalChokidarPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = originalChokidarPolling;
      }
      await reloader?.stop();
    }
  });

  it("degrades to polling then disables after both native and polling retries are exhausted", async () => {
    const originalVitest = process.env.VITEST;
    const originalChokidarPolling = process.env.CHOKIDAR_USEPOLLING;
    delete process.env.VITEST;
    delete process.env.CHOKIDAR_USEPOLLING;
    let reloader: { stop: () => Promise<void>; hotReloadStatus: () => string } | undefined;
    try {
      // Native phase: initial watcher + 3 re-creates = 4 watchers.
      // Polling phase: 1 polling re-create + 3 re-creates = 4 watchers.
      const watchers = Array.from({ length: 8 }, () => createWatcherMock());
      const started = startReloaderWithWatchers(watchers);
      const { watchSpy, readSnapshot, log } = started;
      reloader = started.reloader;
      const watchOptions = (index: number) =>
        watchSpy.mock.calls[index]?.[1] as { usePolling?: boolean } | undefined;

      // --- Native retry phase (3 retries) ---
      expect(watchOptions(0)?.usePolling).toBe(false);
      watchers[0]?.emit("error");
      await vi.advanceTimersByTimeAsync(500);
      expect(watchOptions(1)?.usePolling).toBe(false);
      watchers[1]?.emit("error");
      await vi.advanceTimersByTimeAsync(2000);
      expect(watchOptions(2)?.usePolling).toBe(false);
      watchers[2]?.emit("error");
      await vi.advanceTimersByTimeAsync(5000);
      expect(watchSpy).toHaveBeenCalledTimes(4);
      expect(watchOptions(3)?.usePolling).toBe(false);
      expect(reloader.hotReloadStatus()).toBe("active");

      // Fourth native error triggers degradation to polling mode (not disabled).
      watchers[3]?.emit("error");
      expect(reloader.hotReloadStatus()).toBe("active");
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("degrading to polling mode"));
      await vi.advanceTimersByTimeAsync(500);
      expect(watchSpy).toHaveBeenCalledTimes(5);
      expect(watchOptions(4)?.usePolling).toBe(true);
      expect(readSnapshot).not.toHaveBeenCalled();
      watchers[4]?.emit("ready");
      await vi.runOnlyPendingTimersAsync();
      expect(readSnapshot).toHaveBeenCalledTimes(1);

      // --- Polling retry phase (3 retries) ---
      watchers[4]?.emit("error");
      await vi.advanceTimersByTimeAsync(500);
      expect(watchOptions(5)?.usePolling).toBe(true);
      watchers[5]?.emit("error");
      await vi.advanceTimersByTimeAsync(2000);
      expect(watchOptions(6)?.usePolling).toBe(true);
      watchers[6]?.emit("error");
      await vi.advanceTimersByTimeAsync(5000);
      expect(watchSpy).toHaveBeenCalledTimes(8);
      expect(watchOptions(7)?.usePolling).toBe(true);
      expect(reloader.hotReloadStatus()).toBe("active");

      // Eighth error in polling mode finally disables hot-reload.
      watchers[7]?.emit("error");
      expect(reloader.hotReloadStatus()).toBe("disabled");
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "config hot-reload disabled: watcher failed after 3 re-create attempts in polling mode",
        ),
      );
      // No further watcher is created once disabled.
      await vi.advanceTimersByTimeAsync(10000);
      expect(watchSpy).toHaveBeenCalledTimes(8);
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      if (originalChokidarPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = originalChokidarPolling;
      }
      await reloader?.stop();
    }
  });

  it("does not run a redundant native phase when chokidar polling is forced on", async () => {
    const originalVitest = process.env.VITEST;
    const originalChokidarPolling = process.env.CHOKIDAR_USEPOLLING;
    delete process.env.VITEST;
    process.env.CHOKIDAR_USEPOLLING = "1";
    let reloader: { stop: () => Promise<void>; hotReloadStatus: () => string } | undefined;
    try {
      const watchers = Array.from({ length: 4 }, () => createWatcherMock());
      const started = startReloaderWithWatchers(watchers);
      const { watchSpy, log } = started;
      reloader = started.reloader;
      const watchOptions = (index: number) =>
        watchSpy.mock.calls[index]?.[1] as { usePolling?: boolean } | undefined;

      expect(watchOptions(0)?.usePolling).toBe(true);
      watchers[0]?.emit("error");
      await vi.advanceTimersByTimeAsync(500);
      expect(watchOptions(1)?.usePolling).toBe(true);
      watchers[1]?.emit("error");
      await vi.advanceTimersByTimeAsync(2000);
      expect(watchOptions(2)?.usePolling).toBe(true);
      watchers[2]?.emit("error");
      await vi.advanceTimersByTimeAsync(5000);
      expect(watchOptions(3)?.usePolling).toBe(true);

      watchers[3]?.emit("error");
      expect(reloader.hotReloadStatus()).toBe("disabled");
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("degrading to polling mode"),
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "config hot-reload disabled: watcher failed after 3 re-create attempts in polling mode",
        ),
      );
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      if (originalChokidarPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = originalChokidarPolling;
      }
      await reloader?.stop();
    }
  });

  it("uses chokidar's effective polling mode when the platform forces it on", async () => {
    const originalVitest = process.env.VITEST;
    const originalChokidarPolling = process.env.CHOKIDAR_USEPOLLING;
    delete process.env.VITEST;
    delete process.env.CHOKIDAR_USEPOLLING;
    let reloader: { stop: () => Promise<void>; hotReloadStatus: () => string } | undefined;
    try {
      const watchers = Array.from({ length: 4 }, () => createWatcherMock(true));
      const started = startReloaderWithWatchers(watchers);
      const { log } = started;
      reloader = started.reloader;
      const backoffs = [500, 2000, 5000] as const;

      for (let index = 0; index < watchers.length - 1; index += 1) {
        watchers[index]?.emit("error");
        await vi.advanceTimersByTimeAsync(backoffs[index] ?? 0);
      }
      watchers.at(-1)?.emit("error");

      expect(reloader.hotReloadStatus()).toBe("disabled");
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("degrading to polling mode"),
      );
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("in polling mode"));
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      if (originalChokidarPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = originalChokidarPolling;
      }
      await reloader?.stop();
    }
  });

  it("does not report polling fallback when chokidar polling is forced off", async () => {
    const originalVitest = process.env.VITEST;
    const originalChokidarPolling = process.env.CHOKIDAR_USEPOLLING;
    delete process.env.VITEST;
    process.env.CHOKIDAR_USEPOLLING = "0";
    let reloader: { stop: () => Promise<void>; hotReloadStatus: () => string } | undefined;
    try {
      const watchers = Array.from({ length: 4 }, () => createWatcherMock());
      const started = startReloaderWithWatchers(watchers);
      const { watchSpy, log } = started;
      reloader = started.reloader;
      const watchOptions = (index: number) =>
        watchSpy.mock.calls[index]?.[1] as { usePolling?: boolean } | undefined;

      expect(watchOptions(0)?.usePolling).toBe(false);
      watchers[0]?.emit("error");
      await vi.advanceTimersByTimeAsync(500);
      expect(watchOptions(1)?.usePolling).toBe(false);
      watchers[1]?.emit("error");
      await vi.advanceTimersByTimeAsync(2000);
      expect(watchOptions(2)?.usePolling).toBe(false);
      watchers[2]?.emit("error");
      await vi.advanceTimersByTimeAsync(5000);
      expect(watchOptions(3)?.usePolling).toBe(false);

      watchers[3]?.emit("error");
      expect(reloader.hotReloadStatus()).toBe("disabled");
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("degrading to polling mode"),
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "config hot-reload disabled: watcher failed after 3 re-create attempts in native mode",
        ),
      );
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      if (originalChokidarPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = originalChokidarPolling;
      }
      await reloader?.stop();
    }
  });
});

describe("startGatewayConfigReloader skills invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSkillsRefreshStateForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSkillsRefreshStateForTest();
  });

  it("bumps the skills snapshot version when skills.allowBundled changes", async () => {
    const before = getSkillsSnapshotVersion();
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        config: {
          gateway: { reload: {} },
          skills: { allowBundled: ["gog"] },
        },
        hash: "skills-change-1",
      }),
    );
    const { watcher, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    const after = getSkillsSnapshotVersion();
    expect(after).toBeGreaterThan(before);
    expect(log.info).toHaveBeenCalledWith("skills snapshot invalidated by config change (skills)");

    await reloader.stop();
  });

  it("does not bump the snapshot version when unrelated config changes", async () => {
    const before = getSkillsSnapshotVersion();
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        config: {
          gateway: { reload: {}, port: 18790 },
        },
        hash: "unrelated-change-1",
      }),
    );
    const { watcher, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(getSkillsSnapshotVersion()).toBe(before);

    await reloader.stop();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
