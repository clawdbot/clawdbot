import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../agents/skills/refresh-state.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type {
  ConfigFileSnapshot,
  ConfigWriteNotification,
  OpenClawConfig,
} from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  resolveGatewayReloadSettings,
  shouldInvalidateSkillsSnapshotForPaths,
  startGatewayConfigReloader,
} from "./config-reload.js";

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
    expect(diffConfigPaths(prev, next)).toEqual([]);
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
    reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  };
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
  ]);
  registry.reloads = [
    {
      pluginId: "browser",
      pluginName: "Browser",
      registration: { restartPrefixes: ["browser"] },
      source: "test",
    },
  ];

  beforeEach(() => {
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("marks gateway changes as restart required", () => {
    const plan = buildGatewayReloadPlan(["gateway.port"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.port");
  });

  it("restarts the gateway for browser plugin config changes", () => {
    const plan = buildGatewayReloadPlan(["browser.enabled"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("browser.enabled");
    expect(plan.hotReasons).toEqual([]);
  });

  it("restarts the Gmail watcher for hooks.gmail changes", () => {
    const plan = buildGatewayReloadPlan(["hooks.gmail.account"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartGmailWatcher).toBe(true);
    expect(plan.reloadHooks).toBe(true);
  });

  it("restarts providers when provider config prefixes change", () => {
    const changedPaths = ["web.enabled", "channels.telegram.botToken"];
    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(false);
    const expected = new Set(
      listChannelPlugins()
        .filter((plugin) =>
          (plugin.reload?.configPrefixes ?? []).some((prefix) =>
            changedPaths.some((path) => path === prefix || path.startsWith(`${prefix}.`)),
          ),
        )
        .map((plugin) => plugin.id),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(plan.restartChannels).toEqual(expected);
  });

  it("restarts heartbeat when model-related config changes", () => {
    const plan = buildGatewayReloadPlan([
      "models.providers.openai.models",
      "agents.defaults.model",
    ]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toEqual(
      expect.arrayContaining(["models.providers.openai.models", "agents.defaults.model"]),
    );
  });

  it("restarts heartbeat when agents.defaults.models allowlist changes", () => {
    const plan = buildGatewayReloadPlan(["agents.defaults.models"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toContain("agents.defaults.models");
    expect(plan.noopPaths).toEqual([]);
  });

  it("restarts heartbeat when agents.list entries change", () => {
    const plan = buildGatewayReloadPlan(["agents.list"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toContain("agents.list");
    expect(plan.noopPaths).toEqual([]);
  });

  it("treats plugin install timestamp-only changes as no-op", () => {
    const plan = buildGatewayReloadPlan([
      "plugins.installs.lossless-claw.resolvedAt",
      "plugins.installs.lossless-claw.installedAt",
    ]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toEqual([
      "plugins.installs.lossless-claw.resolvedAt",
      "plugins.installs.lossless-claw.installedAt",
    ]);
  });

  it("keeps colliding whole-record plugin install changes as restart reasons", () => {
    const plan = buildGatewayReloadPlan(
      ["plugins.installs.lossless.resolvedAt", "plugins.installs.lossless.resolvedAt"],
      {
        noopPaths: ["plugins.installs.lossless.resolvedAt"],
        forceChangedPaths: ["plugins.installs.lossless.resolvedAt"],
      },
    );

    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual([
      "plugins.installs.lossless.resolvedAt",
      "plugins.installs.lossless.resolvedAt",
    ]);
    expect(plan.noopPaths).toEqual([]);
  });

  it("lists plugin install metadata and whole-record paths structurally", () => {
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

    expect(listPluginInstallTimestampMetadataPaths(prev, next)).toEqual([
      "plugins.installs.lossless.resolvedAt",
    ]);
    expect(listPluginInstallWholeRecordPaths(prev, next)).toEqual([
      "plugins.installs.lossless.resolvedAt",
    ]);
  });

  it("hot-reloads health monitor when channelHealthCheckMinutes changes", () => {
    const plan = buildGatewayReloadPlan(["gateway.channelHealthCheckMinutes"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHealthMonitor).toBe(true);
    expect(plan.hotReasons).toContain("gateway.channelHealthCheckMinutes");
  });

  it("treats gateway.remote as no-op", () => {
    const plan = buildGatewayReloadPlan(["gateway.remote.url"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("gateway.remote.url");
  });

  it("treats secrets config changes as no-op for gateway restart planning", () => {
    const plan = buildGatewayReloadPlan(["secrets.providers.default.path"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("secrets.providers.default.path");
  });

  it("treats diagnostics.stuckSessionWarnMs as no-op for gateway restart planning", () => {
    const plan = buildGatewayReloadPlan(["diagnostics.stuckSessionWarnMs"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("diagnostics.stuckSessionWarnMs");
  });

  it("restarts for gateway.auth.token changes", () => {
    const plan = buildGatewayReloadPlan(["gateway.auth.token"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.auth.token");
  });

  it("restarts for gateway.auth.mode changes", () => {
    const plan = buildGatewayReloadPlan(["gateway.auth.mode"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.auth.mode");
  });

  it("defaults unknown paths to restart", () => {
    const plan = buildGatewayReloadPlan(["unknownField"]);
    expect(plan.restartGateway).toBe(true);
  });

  it.each([
    {
      path: "browser.enabled",
      expectRestartGateway: true,
      expectRestartReason: "browser.enabled",
    },
    {
      path: "gateway.channelHealthCheckMinutes",
      expectRestartGateway: false,
      expectHotPath: "gateway.channelHealthCheckMinutes",
      expectRestartHealthMonitor: true,
    },
    {
      path: "hooks.gmail.account",
      expectRestartGateway: false,
      expectHotPath: "hooks.gmail.account",
      expectRestartGmailWatcher: true,
      expectReloadHooks: true,
    },
    {
      path: "agents.list",
      expectRestartGateway: false,
      expectHotPath: "agents.list",
      expectRestartHeartbeat: true,
    },
    {
      path: "gateway.remote.url",
      expectRestartGateway: false,
      expectNoopPath: "gateway.remote.url",
    },
    {
      path: "gateway.auth.token",
      expectRestartGateway: true,
      expectRestartReason: "gateway.auth.token",
    },
    {
      path: "unknownField",
      expectRestartGateway: true,
      expectRestartReason: "unknownField",
    },
  ])("classifies reload path: $path", (testCase) => {
    const plan = buildGatewayReloadPlan([testCase.path]);
    expect(plan.restartGateway).toBe(testCase.expectRestartGateway);
    if (testCase.expectHotPath) {
      expect(plan.hotReasons).toContain(testCase.expectHotPath);
    }
    if (testCase.expectNoopPath) {
      expect(plan.noopPaths).toContain(testCase.expectNoopPath);
    }
    if (testCase.expectRestartReason) {
      expect(plan.restartReasons).toContain(testCase.expectRestartReason);
    }
    if (testCase.expectRestartHealthMonitor) {
      expect(plan.restartHealthMonitor).toBe(true);
    }
    if (testCase.expectRestartGmailWatcher) {
      expect(plan.restartGmailWatcher).toBe(true);
    }
    if (testCase.expectReloadHooks) {
      expect(plan.reloadHooks).toBe(true);
    }
    if (testCase.expectRestartHeartbeat) {
      expect(plan.restartHeartbeat).toBe(true);
    }
  });
});

describe("resolveGatewayReloadSettings", () => {
  it("uses defaults when unset", () => {
    const settings = resolveGatewayReloadSettings({});
    expect(settings.mode).toBe("hybrid");
    expect(settings.debounceMs).toBe(300);
  });
});

type WatcherHandler = () => void;
type WatcherEvent = "add" | "change" | "unlink" | "error";

function createWatcherMock() {
  const handlers = new Map<WatcherEvent, WatcherHandler[]>();
  return {
    on(event: WatcherEvent, handler: WatcherHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return this;
    },
    emit(event: WatcherEvent) {
      for (const handler of handlers.get(event) ?? []) {
        handler();
      }
    },
    close: vi.fn(async () => {}),
  };
}

function makeSnapshot(partial: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  const config = partial.config ?? {};
  const sourceConfig = (partial.sourceConfig ??
    partial.config ??
    {}) as ConfigFileSnapshot["sourceConfig"];
  const runtimeConfig = partial.runtimeConfig ?? partial.config ?? {};
  return {
    path: "/tmp/openclaw.json",
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
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true },
    },
    runtimeConfig: {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true },
    },
    config: {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true },
    },
    hash,
  });
}

function makeZeroDebounceHookWrite(persistedHash: string): ConfigWriteNotification {
  return {
    configPath: "/tmp/openclaw.json",
    sourceConfig: { gateway: { reload: { debounceMs: 0 } }, hooks: { enabled: true } },
    runtimeConfig: {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true },
    },
    persistedHash,
    writtenAtMs: Date.now(),
  };
}

function createReloaderHarness(
  readSnapshot: () => Promise<ConfigFileSnapshot>,
  options: {
    initialCompareConfig?: OpenClawConfig;
    initialInternalWriteHash?: string | null;
    recoverSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
    promoteSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
    onRecovered?: (params: {
      reason: string;
      snapshot: ConfigFileSnapshot;
      recoveredSnapshot: ConfigFileSnapshot;
    }) => void | Promise<void>;
  } = {},
) {
  const watcher = createWatcherMock();
  vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
  const onHotReload = vi.fn(async () => {});
  const onRestart = vi.fn();
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
  const reloader = startGatewayConfigReloader({
    initialConfig: { gateway: { reload: { debounceMs: 0 } } },
    initialCompareConfig: options.initialCompareConfig,
    initialInternalWriteHash: options.initialInternalWriteHash,
    readSnapshot,
    recoverSnapshot: options.recoverSnapshot,
    promoteSnapshot: options.promoteSnapshot,
    onRecovered: options.onRecovered,
    subscribeToWrites,
    onHotReload,
    onRestart,
    log,
    watchPath: "/tmp/openclaw.json",
  });
  return {
    watcher,
    onHotReload,
    onRestart,
    log,
    reloader,
    emitWrite(event: ConfigWriteNotification) {
      writeListener?.(event);
    },
  };
}

describe("startGatewayConfigReloader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries missing snapshots and reloads once config file reappears", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ exists: false, raw: null, hash: "missing-1" }))
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 } },
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

  it("contains restart callback failures and retries on subsequent changes", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 }, port: 18790 },
          },
          hash: "restart-1",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 }, port: 18791 },
          },
          hash: "restart-2",
        }),
      );
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);
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
      expect(unhandled).toEqual([]);

      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onRestart).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await reloader.stop();
    }
  });

  it("restores last-known-good on invalid external config edits and reloads recovered snapshot", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          valid: false,
          raw: "{ gateway: { mode: 123 } }",
          issues: [{ path: "gateway.mode", message: "Expected string" }],
          hash: "bad-1",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 } },
            hooks: { enabled: true },
          },
          hash: "last-good-1",
        }),
      );
    const recoverSnapshot = vi.fn(async () => true);
    const promoteSnapshot = vi.fn(async () => true);
    const onRecovered = vi.fn();
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot, {
      recoverSnapshot,
      promoteSnapshot,
      onRecovered,
    });

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(recoverSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ valid: false }),
      "invalid-config",
    );
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid-config",
        snapshot: expect.objectContaining({ valid: false }),
        recoveredSnapshot: expect.objectContaining({ hash: "last-good-1" }),
      }),
    );
    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
    expect(promoteSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "last-good-1" }),
      "valid-config",
    );
    expect(log.warn).toHaveBeenCalledWith(
      "config reload restored last-known-good config after invalid-config",
    );

    await reloader.stop();
  });

  it("promotes valid external config edits after they are accepted", async () => {
    const acceptedSnapshot = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0 } },
        hooks: { enabled: true },
      },
      hash: "external-good-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(acceptedSnapshot);
    const promoteSnapshot = vi.fn(async () => true);
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
        gateway: { reload: { debounceMs: 0 } },
        hooks: { enabled: true },
      },
      hash: "external-rejected-1",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(acceptedSnapshot);
    const promoteSnapshot = vi.fn(async () => true);
    const { watcher, onHotReload, log, reloader } = createReloaderHarness(readSnapshot, {
      promoteSnapshot,
    });
    onHotReload.mockRejectedValueOnce(new Error("reload refused"));

    watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(promoteSnapshot).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("config reload failed: Error: reload refused");

    await reloader.stop();
  });

  it("keeps accepted external config reloads applied when last-known-good promotion fails", async () => {
    const acceptedSnapshot = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0 } },
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
            gateway: { reload: { debounceMs: 0 }, port: 19001 },
          },
          runtimeConfig: {
            gateway: { reload: { debounceMs: 0 }, port: 19001 },
          },
          config: {
            gateway: { reload: { debounceMs: 0 }, port: 19001 },
          },
          hash: "external-1",
        }),
      );
    const promoteSnapshot = vi.fn(async () => true);
    const harness = createReloaderHarness(readSnapshot, { promoteSnapshot });

    harness.emitWrite(makeZeroDebounceHookWrite("internal-1"));
    await vi.runOnlyPendingTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.onHotReload).toHaveBeenCalledTimes(1);
    expect(promoteSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "internal-1" }),
      "in-process-write",
    );

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

  it("plans in-process reloads from source config and ignores runtime materialized paths", async () => {
    const baseInstall = {
      source: "npm" as const,
      spec: "@martian-engineering/lossless-claw",
      installPath: "/tmp/lossless-claw",
      installedAt: "2026-04-22T00:00:00.000Z",
      resolvedAt: "2026-04-22T00:00:00.000Z",
    };
    const sourceConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 }, auth: { mode: "token" } },
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
        gateway: { reload: { debounceMs: 0 }, auth: { mode: "token", token: "runtime" } },
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
      writtenAtMs: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    expect(harness.log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("gateway.auth.token"),
    );

    await harness.reloader.stop();
  });

  it("does not suppress functional install changes that collide with timestamp paths", async () => {
    const sourceConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
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
      gateway: { reload: { debounceMs: 0 } },
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
      writtenAtMs: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).toHaveBeenCalledTimes(1);

    await harness.reloader.stop();
  });

  it("skips in-process promotion when the persisted file hash no longer matches the write", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: {
          gateway: { reload: { debounceMs: 0 }, port: 19002 },
        },
        runtimeConfig: {
          gateway: { reload: { debounceMs: 0 }, port: 19002 },
        },
        config: {
          gateway: { reload: { debounceMs: 0 }, port: 19002 },
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

  it("dedupes the first watcher reread for startup internal writes", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 }, auth: { mode: "token", token: "startup" } },
          },
          hash: "startup-internal-1",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 }, port: 19001 },
          },
          hash: "external-after-startup-1",
        }),
      );
    const harness = createReloaderHarness(readSnapshot, {
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

  it("does not dedupe when initialInternalWriteHash is null (#67436)", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        config: {
          gateway: { reload: { debounceMs: 0 }, auth: { mode: "token", token: "startup" } },
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

describe("shouldInvalidateSkillsSnapshotForPaths", () => {
  it.each([
    "skills",
    "skills.allowBundled",
    "skills.entries",
    "skills.entries.himalaya",
    "skills.entries.himalaya.enabled",
    "skills.profile",
  ])("returns true for skills path %s", (path) => {
    expect(shouldInvalidateSkillsSnapshotForPaths([path])).toBe(true);
  });

  it.each([
    "tools.profile",
    "agents.defaults.model",
    "gateway.port",
    "skillset.allowBundled",
    "channels.telegram.enabled",
  ])("returns false for unrelated path %s", (path) => {
    expect(shouldInvalidateSkillsSnapshotForPaths([path])).toBe(false);
  });

  it("returns true when any path in the list matches", () => {
    expect(
      shouldInvalidateSkillsSnapshotForPaths([
        "gateway.port",
        "skills.allowBundled",
        "channels.telegram.enabled",
      ]),
    ).toBe(true);
  });

  it("returns false for empty input", () => {
    expect(shouldInvalidateSkillsSnapshotForPaths([])).toBe(false);
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
          gateway: { reload: { debounceMs: 0 } },
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
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("skills snapshot invalidated by config change"),
    );

    await reloader.stop();
  });

  it("does not bump the snapshot version when unrelated config changes", async () => {
    const before = getSkillsSnapshotVersion();
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        config: {
          gateway: { reload: { debounceMs: 0 }, port: 18790 },
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
