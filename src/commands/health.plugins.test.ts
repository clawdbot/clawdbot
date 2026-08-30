import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SnapshotSchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";

const testConfig = { session: { store: "/tmp/x" } };
const tempPaths: string[] = [];

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let setActiveDegradedPlugins: typeof import("../plugins/runtime-degraded-state.js").setActiveDegradedPlugins;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let collectGatewayHealthSnapshot: typeof import("../gateway/health/collector.js").collectGatewayHealthSnapshot;
let startPluginServices: typeof import("../plugins/services.js").startPluginServices;
let pluginServicesHandle: PluginServicesHandle | undefined;

describe("collectGatewayHealthSnapshot plugin state", () => {
  beforeAll(async () => {
    vi.doMock("../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
      loadConfig: () => testConfig,
    }));
    vi.doMock("../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => "/tmp/sessions.json",
    }));
    vi.doMock("../config/sessions/session-accessor.js", () => ({
      readSessionStoreSummaryReadOnly: () => ({ count: 0, recent: [], byAgent: new Map() }),
    }));
    vi.doMock("../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => [],
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

  afterEach(async () => {
    await pluginServicesHandle?.stop();
    pluginServicesHandle = undefined;
    setActiveDegradedPlugins([]);
    setActivePluginRegistry(createTestRegistry([]));
    for (const tempPath of tempPaths.splice(0)) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }
  });

  it("deduplicates canonical-root quarantine while retaining unrelated same-id errors", async () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-health-plugin-"));
    const pluginRootAlias = `${pluginRoot}-alias`;
    fs.symlinkSync(pluginRoot, pluginRootAlias, "dir");
    tempPaths.push(pluginRootAlias, pluginRoot);
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

  it("surfaces a failed service while continuing healthy siblings", async () => {
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
              throw new Error("listen EADDRINUSE: address already in use");
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
      error: "service broken: listen EADDRINUSE: address already in use",
    });

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
