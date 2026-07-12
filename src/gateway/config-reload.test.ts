// Gateway config reload tests cover changed-path detection, reload planning,
// plugin registry refresh, skill snapshot invalidation, and watcher behavior.
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type {
  ConfigFileSnapshot,
  ConfigWriteNotification,
  OpenClawConfig,
} from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
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
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  diffGatewayReloadPaths,
  type GatewayReloadPlan,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  resolveConfigReloadMetadata,
  resolveGatewayReloadSettings,
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
    {
      label: "added",
      prev: {},
      next: { mcp: { apps: { enabled: true } } },
    },
    {
      label: "removed",
      prev: { mcp: { apps: { enabled: true } } },
      next: {},
    },
  ])(
    "preserves the Apps restart boundary when the whole MCP config is $label",
    ({ prev, next }) => {
      const changedPaths = diffGatewayReloadPaths(prev, next);
      const plan = buildGatewayReloadPlan(changedPaths);

      expect(changedPaths).toEqual(["mcp", "mcp.apps"]);
      expect(plan.restartGateway).toBe(true);
      expect(plan.restartReasons).toContain("mcp.apps");
    },
  );
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
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
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

  it("marks gateway changes as restart required", () => {
    const plan = buildGatewayReloadPlan(["gateway.port"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.port");
  });

  it("restarts the gateway when MCP Apps listener config changes", () => {
    const plan = buildGatewayReloadPlan([
      "mcp.apps.enabled",
      "mcp.apps.sandboxPort",
      "mcp.apps.sandboxOrigin",
    ]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual([
      "mcp.apps.enabled",
      "mcp.apps.sandboxPort",
      "mcp.apps.sandboxOrigin",
    ]);
    expect(plan.disposeMcpRuntimes).toBe(false);
  });

  it("restarts the gateway for operator terminal config changes", () => {
    // The terminal drives the Control UI CSP + bootstrap (both document-load
    // time) and live PTYs, none of which hot-update a connected client, so a
    // change restarts the gateway (clients reconnect with a fresh page/CSP).
    const plan = buildGatewayReloadPlan(["gateway.terminal.enabled", "gateway.terminal.shell"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.terminal.enabled");
  });

  it("restarts the gateway for browser plugin config changes", () => {
    const plan = buildGatewayReloadPlan(["browser.enabled"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("browser.enabled");
    expect(plan.hotReasons).toStrictEqual([]);
  });

  it("hot-reloads browser profile config under the broad browser restart rule", () => {
    const path = "browser.profiles.sandbox.cdpUrl";
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(false);
    expect(plan.restartReasons).toStrictEqual([]);
    expect(plan.hotReasons).toEqual([path]);
    expect(plan.noopPaths).toStrictEqual([]);
    expect(resolveConfigReloadMetadata(path).kind).toBe("hot");
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

  it("restarts the channel when a per-account config field changes (more specific configPrefix wins over the broad noop prefix)", () => {
    const changedPaths = [
      "channels.whatsapp.accounts.default.enabled",
      "channels.whatsapp.accounts.default.authDir",
    ];
    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["whatsapp"]));
    expect(plan.hotReasons).toEqual(changedPaths);
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("restarts the WhatsApp channel when selfChatMode changes (configPrefix wins over broad noop prefix)", () => {
    const plan = buildGatewayReloadPlan(["channels.whatsapp.selfChatMode"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["whatsapp"]));
    expect(plan.hotReasons).toContain("channels.whatsapp.selfChatMode");
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("keeps other channels.whatsapp.* changes as hot no-ops", () => {
    const plan = buildGatewayReloadPlan(["channels.whatsapp.replyToMode"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set());
    expect(plan.noopPaths).toContain("channels.whatsapp.replyToMode");
  });

  it("refreshes channel reload rules when only the tracked channel registry changes", () => {
    const activeOnlyRegistry = createTestRegistry([]);
    const channelOnlyRegistry = createTestRegistry([
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]);

    setActivePluginRegistry(activeOnlyRegistry);
    const beforePinPlan = buildGatewayReloadPlan(["channels.telegram.botToken"]);
    expect(beforePinPlan.restartGateway).toBe(true);
    expect(beforePinPlan.restartChannels).toEqual(new Set());

    pinActivePluginChannelRegistry(channelOnlyRegistry);
    const afterPinPlan = buildGatewayReloadPlan(["channels.telegram.botToken"]);
    expect(afterPinPlan.restartGateway).toBe(false);
    expect(afterPinPlan.restartChannels).toEqual(new Set(["telegram"]));
  });

  it("restarts loaded channel plugins when plugin entry state changes", () => {
    const plan = buildGatewayReloadPlan(["plugins.entries.telegram.enabled"]);

    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.disposeMcpRuntimes).toBe(true);
    expect(plan.restartChannels).toEqual(new Set(["telegram"]));
  });

  it("keeps installed channel plugin source changes restart-backed", () => {
    const plan = buildGatewayReloadPlan(["plugins.installs.telegram.installPath"]);

    expect(plan.restartGateway).toBe(true);
    expect(plan.reloadPlugins).toBe(false);
    expect(plan.disposeMcpRuntimes).toBe(false);
    expect(plan.restartChannels).toEqual(new Set());
    expect(plan.restartReasons).toEqual(["plugins.installs.telegram.installPath"]);
  });

  it("restarts heartbeat when model-related config changes", () => {
    const plan = buildGatewayReloadPlan([
      "models.providers.openai.models",
      "agents.defaults.model",
    ]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toEqual(["models.providers.openai.models", "agents.defaults.model"]);
  });

  it("requires restart when model pricing bootstrap changes", () => {
    const plan = buildGatewayReloadPlan(["models.pricing.enabled"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("models.pricing.enabled");
    expect(plan.restartHeartbeat).toBe(false);
    expect(plan.hotReasons).toStrictEqual([]);
  });

  it("restarts heartbeat when agents.defaults.models allowlist changes", () => {
    const plan = buildGatewayReloadPlan(["agents.defaults.models"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toContain("agents.defaults.models");
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("restarts heartbeat when agents.list entries change", () => {
    const plan = buildGatewayReloadPlan(["agents.list"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toContain("agents.list");
    expect(plan.noopPaths).toStrictEqual([]);
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
    expect(resolveConfigReloadMetadata("plugins.installs.lossless-claw.resolvedAt").kind).toBe(
      "none",
    );
    expect(resolveConfigReloadMetadata("plugins.installs.lossless-claw.installedAt").kind).toBe(
      "none",
    );
  });

  it("restarts for whole-record plugin install changes", () => {
    const plan = buildGatewayReloadPlan(
      ["plugins.installs.lossless.resolvedAt", "plugins.installs.lossless.resolvedAt"],
      {
        noopPaths: ["plugins.installs.lossless.resolvedAt"],
        forceChangedPaths: ["plugins.installs.lossless.resolvedAt"],
      },
    );

    expect(plan.restartGateway).toBe(true);
    expect(plan.reloadPlugins).toBe(false);
    expect(plan.disposeMcpRuntimes).toBe(false);
    expect(plan.restartReasons).toEqual([
      "plugins.installs.lossless.resolvedAt",
      "plugins.installs.lossless.resolvedAt",
    ]);
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("requires restart when plugin load paths change", () => {
    const plan = buildGatewayReloadPlan(["plugins.load.paths.0"]);

    expect(plan.restartGateway).toBe(true);
    expect(plan.reloadPlugins).toBe(false);
    expect(plan.disposeMcpRuntimes).toBe(false);
    expect(plan.restartReasons).toEqual(["plugins.load.paths.0"]);
  });

  it("hot-reloads plugin entry config changes", () => {
    const plan = buildGatewayReloadPlan(["plugins.entries.lossless-claw.config.mode"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.disposeMcpRuntimes).toBe(true);
    expect(plan.hotReasons).toContain("plugins.entries.lossless-claw.config.mode");
  });

  it("keeps restart-owned plugin entry config changes restart-backed", () => {
    const plan = buildGatewayReloadPlan(["plugins.entries.canvas.enabled"]);

    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual(["plugins.entries.canvas.enabled"]);
    expect(plan.hotReasons).toStrictEqual([]);
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

  it("hot-reloads MCP config changes by disposing cached runtimes", () => {
    const plan = buildGatewayReloadPlan(["mcp.servers.context7.command"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.disposeMcpRuntimes).toBe(true);
    expect(plan.hotReasons).toContain("mcp.servers.context7.command");
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

  it("treats TUI display preferences as no-op for gateway restart planning", () => {
    const path = "tui.footer.showRemoteHost";
    const plan = buildGatewayReloadPlan([path]);

    expect(plan.restartGateway).toBe(false);
    expect(plan.restartReasons).toStrictEqual([]);
    expect(plan.hotReasons).toStrictEqual([]);
    expect(plan.noopPaths).toContain(path);
    expect(resolveConfigReloadMetadata(path).kind).toBe("none");
  });

  it("treats diagnostics stuck-session thresholds as no-op for gateway restart planning", () => {
    const plan = buildGatewayReloadPlan([
      "diagnostics.stuckSessionWarnMs",
      "diagnostics.stuckSessionAbortMs",
    ]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("diagnostics.stuckSessionWarnMs");
    expect(plan.noopPaths).toContain("diagnostics.stuckSessionAbortMs");
  });

  it("hot-reloads diagnostics memory pressure snapshot toggles", () => {
    const plan = buildGatewayReloadPlan(["diagnostics.memoryPressureSnapshot"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.hotReasons).toContain("diagnostics.memoryPressureSnapshot");
    expect(plan.noopPaths).toStrictEqual([]);
  });

  it("hot-reloads auth cooldown changes without a gateway restart", () => {
    const changedPaths = [
      "auth.cooldowns.billingBackoffHours",
      "auth.cooldowns.billingBackoffHoursByProvider.anthropic",
    ];
    const plan = buildGatewayReloadPlan(changedPaths);

    expect(plan.restartGateway).toBe(false);
    expect(plan.restartReasons).toStrictEqual([]);
    expect(plan.hotReasons).toStrictEqual(changedPaths);
    expect(plan.noopPaths).toStrictEqual([]);
    expect(resolveConfigReloadMetadata("auth.cooldowns.billingBackoffHours").kind).toBe("hot");
  });

  it("treats session tool visibility as a dynamic-read path", () => {
    const plan = buildGatewayReloadPlan(["tools.sessions.visibility"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("tools.sessions.visibility");
  });

  it("treats continuation delegate limits as dynamic-read paths", () => {
    const plan = buildGatewayReloadPlan(["agents.defaults.continuation.maxDelegatesPerTurn"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("agents.defaults.continuation.maxDelegatesPerTurn");
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
      path: "browser.defaultProfile",
      expectRestartGateway: true,
      expectRestartReason: "browser.defaultProfile",
    },
    {
      path: "browser.profiles.sandbox.cdpUrl",
      expectRestartGateway: false,
      expectHotPath: "browser.profiles.sandbox.cdpUrl",
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
      path: "mcp.servers.context7",
      expectRestartGateway: false,
      expectHotPath: "mcp.servers.context7",
      expectDisposeMcpRuntimes: true,
    },
    {
      path: "gateway.remote.url",
      expectRestartGateway: false,
      expectNoopPath: "gateway.remote.url",
    },
    {
      path: "tui.footer.showRemoteHost",
      expectRestartGateway: false,
      expectNoopPath: "tui.footer.showRemoteHost",
    },
    {
      path: "auth.cooldowns.billingBackoffHours",
      expectRestartGateway: false,
      expectHotPath: "auth.cooldowns.billingBackoffHours",
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
    if (testCase.expectDisposeMcpRuntimes) {
      expect(plan.disposeMcpRuntimes).toBe(true);
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

function createWatcherMock(effectiveUsePolling?: boolean) {
  const handlers = new Map<WatcherEvent, WatcherHandler[]>();
  return {
    effectiveUsePolling,
    options: { usePolling: false },
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
    initialInternalWriteHash?: string | null;
    promoteSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
    initialPluginInstallRecords?: Record<string, PluginInstallRecord>;
    readPluginInstallRecords?: () => Promise<Record<string, PluginInstallRecord>>;
    runTransaction?: <T>(run: () => Promise<T>) => Promise<T>;
    onRestart?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  } = {},
) {
  const watcher = createWatcherMock();
  vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
  const onConfigChange = vi.fn(async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {});
  const onConfigApplied = vi.fn(
    async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {},
  );
  const onNoopConfigCommit = vi.fn(
    async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {},
  );
  const onHotReload = vi.fn(async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {});
  const onRestart = vi.fn(
    options.onRestart ?? ((_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {}),
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
  const initialConfig = options.initialConfig ?? { gateway: { reload: { debounceMs: 0 } } };
  const reloader = startGatewayConfigReloader({
    initialConfig,
    initialCompareConfig: options.initialCompareConfig,
    initialInternalWriteHash: options.initialInternalWriteHash,
    readSnapshot,
    promoteSnapshot: options.promoteSnapshot,
    initialPluginInstallRecords: options.initialPluginInstallRecords ?? {},
    readPluginInstallRecords: options.readPluginInstallRecords ?? (async () => ({})),
    subscribeToWrites,
    onConfigChange,
    onConfigApplied,
    onNoopConfigCommit,
    onHotReload,
    onRestart,
    ...(options.runTransaction ? { runTransaction: options.runTransaction } : {}),
    log,
    watchPath: "/tmp/openclaw.json",
  });
  return {
    watcher,
    onConfigChange,
    onConfigApplied,
    onNoopConfigCommit,
    onHotReload,
    onRestart,
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
  return call;
}

function getOnlyHotReloadCall(harness: ReloaderHarness): [GatewayReloadPlan, OpenClawConfig] {
  expect(harness.onHotReload).toHaveBeenCalledTimes(1);
  const call = harness.onHotReload.mock.calls[0];
  if (!call) {
    throw new Error("expected one hot reload call");
  }
  return call;
}

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

  it("notifies lifecycle owners for no-op sandbox policy changes", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      agents: { defaults: { sandbox: { mode: "off" } } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
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
      gateway: { reload: { debounceMs: 0 } },
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
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

  it("notifies lifecycle owners before hot reload and commits after success", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      agents: { defaults: { sandbox: { mode: "off" } } },
      hooks: { enabled: false },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
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
    await harness.reloader.stop();
  });

  it("notifies lifecycle owners before queuing a terminal disable restart", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 }, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 }, terminal: { enabled: false } },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "terminal" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(harness.onConfigChange).toHaveBeenCalledTimes(1);
    expect(harness.onConfigApplied).not.toHaveBeenCalled();
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
      gateway: { reload: { debounceMs: 0 }, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 }, terminal: { enabled: false } },
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
      gateway: { reload: { mode: "off", debounceMs: 0 }, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off", debounceMs: 0 }, terminal: { enabled: false } },
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

  it("does not notify lifecycle owners when hot mode ignores a restart-only change", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hot", debounceMs: 0 }, terminal: { enabled: true } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hot", debounceMs: 0 }, terminal: { enabled: false } },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "hot" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onConfigChange).not.toHaveBeenCalled();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onRestart).not.toHaveBeenCalled();
    await harness.reloader.stop();
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
      expect(unhandled).toStrictEqual([]);

      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onRestart).toHaveBeenCalledTimes(2);
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await reloader.stop();
    }
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
      gateway: { reload: { debounceMs: 0 } },
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
        gateway: { reload: { debounceMs: 0 } },
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

  it("hot-reloads direct diagnostics memory pressure snapshot edits", async () => {
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      diagnostics: { memoryPressureSnapshot: false },
    };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        config: nextConfig,
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        hash: "diagnostics-memory-pressure-snapshot-1",
      }),
    );
    const previousConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      diagnostics: { memoryPressureSnapshot: true },
    };
    const harness = createReloaderHarness(readSnapshot, {
      initialCompareConfig: previousConfig,
    });

    harness.watcher.emit("change");
    await vi.runAllTimersAsync();

    expect(harness.onRestart).not.toHaveBeenCalled();
    const [plan, hotConfig] = getOnlyHotReloadCall(harness);
    expect(plan.hotReasons).toEqual(["diagnostics.memoryPressureSnapshot"]);
    expect(hotConfig).toBe(nextConfig);

    await harness.reloader.stop();
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
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true },
    });

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
      gateway: { reload: { debounceMs: 0 } },
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

  it("keeps external plugin policy-only writes on the hot reload path", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      plugins: {
        entries: {
          telegram: { enabled: false },
        },
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
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

  it("keeps external auth cooldown writes on the hot reload path", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      auth: {
        cooldowns: {
          billingBackoffHours: 1,
          billingBackoffHoursByProvider: { anthropic: 2 },
        },
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      auth: {
        cooldowns: {
          billingBackoffHours: 3,
          billingBackoffHoursByProvider: { anthropic: 4 },
        },
      },
    };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValueOnce(
      makeSnapshot({
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        config: nextConfig,
        hash: "external-auth-cooldowns-1",
      }),
    );
    const harness = createReloaderHarness(readSnapshot, {
      initialCompareConfig: previousConfig,
    });

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onRestart).not.toHaveBeenCalled();
    const [plan, hotConfig] = getOnlyHotReloadCall(harness);
    expect(plan.changedPaths).toEqual([
      "auth.cooldowns.billingBackoffHours",
      "auth.cooldowns.billingBackoffHoursByProvider.anthropic",
    ]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.hotReasons).toEqual([
      "auth.cooldowns.billingBackoffHours",
      "auth.cooldowns.billingBackoffHoursByProvider.anthropic",
    ]);
    expect(plan.noopPaths).toStrictEqual([]);
    expect(hotConfig).toBe(nextConfig);

    await harness.reloader.stop();
  });

  it("queues restart when an external plugin source write also changes plugin config", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      plugins: {
        allow: ["lossless-claw"],
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
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
    const reloader = startGatewayConfigReloader({
      initialConfig: { gateway: { reload: { debounceMs: 0 } } },
      readSnapshot: vi.fn(async () => makeSnapshot()),
      initialPluginInstallRecords: {},
      readPluginInstallRecords: async () => ({}),
      onNoopConfigCommit: vi.fn(async () => {}),
      onHotReload: vi.fn(async () => {}),
      onRestart: vi.fn(),
      log,
      watchPath: "/tmp/openclaw.json",
    });
    return { watchSpy, log, reloader };
  }

  it("re-creates the watcher with backoff after a transient error", async () => {
    const first = createWatcherMock();
    const second = createWatcherMock();
    const { watchSpy, log, reloader } = startReloaderWithWatchers([first, second]);

    expect(watchSpy).toHaveBeenCalledTimes(1);

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
    expect(reloader.hotReloadStatus()).toBe("active");
    expect(log.error).not.toHaveBeenCalled();

    await reloader.stop();
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
      const { watchSpy, log } = started;
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
    expect(log.info).toHaveBeenCalledWith("skills snapshot invalidated by config change (skills)");

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
