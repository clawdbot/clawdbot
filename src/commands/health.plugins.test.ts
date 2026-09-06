import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotSchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";

const testConfig: OpenClawConfig = { session: { store: "/tmp/x" } };
const tempDirs = createTempDirTracker();
let sessionStorePath: string;

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let setActiveDegradedPlugins: typeof import("../plugins/runtime-degraded-state.js").setActiveDegradedPlugins;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let collectGatewayHealthSnapshot: typeof import("../gateway/health/collector.js").collectGatewayHealthSnapshot;
let startPluginServices: typeof import("../plugins/services.js").startPluginServices;
let pluginServicesHandle: PluginServicesHandle | undefined;
let inventoryPlugins: ChannelPlugin[] = [];

describe("collectGatewayHealthSnapshot plugin state", () => {
  beforeAll(async () => {
    vi.doMock("../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
      loadConfig: () => testConfig,
    }));
    vi.doMock("../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => sessionStorePath,
    }));
    vi.doMock("../config/sessions/session-accessor.js", () => ({
      readSessionStoreSummaryReadOnly: () => ({ count: 0, recent: [], byAgent: new Map() }),
    }));
    vi.doMock("../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => inventoryPlugins,
    }));

    const [pluginsRuntime, degradedState, channelTestUtils, health, pluginServices] =
      await Promise.all([
        import("../plugins/runtime.js"),
        import("../plugins/runtime-degraded-state.js"),
        import("../test-utils/channel-plugins.js"),
        import("../gateway/health/collector.js"),
        import("../plugins/services.js"),
      ]);
    setActivePluginRegistry = pluginsRuntime.setActivePluginRegistry;
    setActiveDegradedPlugins = degradedState.setActiveDegradedPlugins;
    createTestRegistry = channelTestUtils.createTestRegistry;
    collectGatewayHealthSnapshot = health.collectGatewayHealthSnapshot;
    startPluginServices = pluginServices.startPluginServices;
  });

  beforeEach(() => {
    sessionStorePath = path.join(
      tempDirs.make("openclaw-health-plugin-sessions-"),
      "sessions.json",
    );
  });

  afterEach(async () => {
    await pluginServicesHandle?.stop();
    pluginServicesHandle = undefined;
    setActiveDegradedPlugins([]);
    inventoryPlugins = [];
    delete testConfig.channels;
    setActivePluginRegistry(createTestRegistry([]));
    tempDirs.cleanup();
  });

  it("deduplicates canonical-root quarantine while retaining unrelated same-id errors", async () => {
    const fixtureDir = tempDirs.make("openclaw-health-plugin-");
    const pluginRoot = path.join(fixtureDir, "plugin");
    const pluginRootAlias = path.join(fixtureDir, "alias");
    fs.mkdirSync(pluginRoot);
    fs.symlinkSync(pluginRoot, pluginRootAlias, "dir");
    setActivePluginRegistry({
      ...createTestRegistry([]),
      plugins: [
        createPluginRecord({
          id: "discord",
          origin: "global",
          rootDir: pluginRoot,
          status: "error",
          activated: false,
          activationReason: "configured-unavailable: unreadable-package-json",
          failurePhase: "validation",
          error: "configured plugin payload verification failed",
        }),
        createPluginRecord({
          id: "discord",
          origin: "config",
          rootDir: "/workspace/discord",
          status: "error",
          activated: false,
          failurePhase: "load",
          error: "healthy override has an unrelated import error",
        }),
      ],
    });
    setActiveDegradedPlugins([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "unreadable-package-json",
          detail: `Could not read ${pluginRootAlias}/package.json: permission denied`,
          installPath: pluginRootAlias,
        },
      },
    ]);

    const snap = await collectGatewayHealthSnapshot({
      audience: "admin",
      timeoutMs: 10,
      probe: false,
    });

    expect(Value.Check(SnapshotSchema.properties.health, snap)).toBe(true);
    expect(snap.sessions.path).toBe(
      path.join(path.dirname(sessionStorePath), "openclaw-agent.sqlite"),
    );
    expect(snap.plugins?.unavailable).toEqual([
      {
        id: "discord",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "unreadable-package-json",
          detail: "Could not read <plugin-install>/package.json: permission denied",
        },
      },
    ]);
    expect(JSON.stringify(snap.plugins?.unavailable)).not.toContain(pluginRoot);
    expect(snap.plugins?.errors).toEqual([
      {
        id: "discord",
        origin: "config",
        activated: false,
        activationSource: "explicit",
        failurePhase: "load",
        error: "healthy override has an unrelated import error",
      },
    ]);
  });

  it("projects the recorded channel load failure instead of stale successful probes", async () => {
    const credential = "synthetic-health-loader-credential";
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const base = createChannelTestPluginBase({ id: "broken-channel" });
    inventoryPlugins = [
      {
        ...base,
        config: { ...base.config, listAccountIds: () => ["default", "disabled"] },
        status: { probeAccount },
      },
    ];
    testConfig.channels = { "broken-channel": { accounts: { Disabled: { enabled: false } } } };
    const registry = {
      ...createTestRegistry([]),
      plugins: [
        createPluginRecord({
          id: "broken-owner",
          enabled: true,
          activated: true,
          status: "error",
          failurePhase: "load",
          channelIds: ["broken-channel"],
          error: `missing SDK export; password=${credential}\n${"context ".repeat(300)}`,
        }),
      ],
    };
    setActivePluginRegistry(registry);
    const snap = await collectGatewayHealthSnapshot({
      audience: "admin",
      timeoutMs: 1000,
      probe: true,
      runtimeSnapshot: {
        channels: {},
        channelAccounts: {
          "broken-channel": {
            default: {
              accountId: "default",
              running: true,
              connected: true,
              probe: { ok: true },
            },
          },
        },
      },
    });
    expect(snap.channels["broken-channel"]).toMatchObject({
      configured: true,
      running: false,
      lifecycle: "blocked",
      lastError: expect.stringContaining("missing SDK export"),
    });
    expect(snap.channels["broken-channel"]?.accounts?.disabled).toMatchObject({
      enabled: false,
      running: false,
      lastError: expect.stringContaining("missing SDK export"),
    });
    expect(snap.channels["broken-channel"]).not.toHaveProperty("probe");
    expect(JSON.stringify(snap)).not.toContain(credential);
    expect(snap.plugins?.errors[0]?.error.length).toBeLessThanOrEqual(1000);
    expect(probeAccount).not.toHaveBeenCalled();

    // A different live owner wins over a failed plugin declaring the same channel.
    setActivePluginRegistry({
      ...registry,
      ...createTestRegistry([
        {
          pluginId: "healthy-owner",
          plugin: inventoryPlugins[0],
          source: "test",
        },
      ]),
      plugins: registry.plugins,
    });
    const { resolveUnavailableChannelAccountSnapshot } =
      await import("../channels/status/account-state.js");
    expect(
      resolveUnavailableChannelAccountSnapshot(testConfig, {
        channelId: "broken-channel",
        accountId: "default",
      }),
    ).toBeUndefined();
  });

  it("surfaces a failed service while continuing healthy siblings", async () => {
    const credential = "synthetic-service-credential";
    const siblingStart = vi.fn();
    const registry = {
      ...createTestRegistry([]),
      plugins: [
        createPluginRecord({
          id: "service-plugin",
          origin: "workspace",
          status: "loaded",
          services: ["broken", "healthy-sibling"],
        }),
      ],
      services: [
        {
          pluginId: "service-plugin",
          pluginName: "Service Plugin",
          service: {
            id: "broken",
            start: () => {
              throw new Error(`listen EADDRINUSE: address already in use; password=${credential}`);
            },
          },
          source: "test",
          origin: "workspace" as const,
        },
        {
          pluginId: "service-plugin",
          pluginName: "Service Plugin",
          service: { id: "healthy-sibling", start: siblingStart },
          source: "test",
          origin: "workspace" as const,
        },
      ],
    };
    setActivePluginRegistry(registry);

    pluginServicesHandle = await startPluginServices({ registry, config: {} });
    const failed = await collectGatewayHealthSnapshot({
      audience: "admin",
      timeoutMs: 10,
      probe: false,
    });

    expect(Value.Check(SnapshotSchema.properties.health, failed)).toBe(true);
    expect(siblingStart).toHaveBeenCalledOnce();
    expect(failed.plugins?.loaded).toContain("service-plugin");
    expect(failed.plugins?.errors).toContainEqual({
      id: "service-plugin",
      origin: "workspace",
      activated: true,
      activationSource: "explicit",
      failurePhase: "service",
      error: expect.stringContaining("service broken: listen EADDRINUSE: address already in use"),
    });
    expect(JSON.stringify(failed)).not.toContain(credential);

    await pluginServicesHandle.stop();
    pluginServicesHandle = undefined;
    const stopped = await collectGatewayHealthSnapshot({
      audience: "admin",
      timeoutMs: 10,
      probe: false,
    });
    expect(stopped.plugins?.errors).toEqual([]);
  });
});
