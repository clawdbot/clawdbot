import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SnapshotSchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";

const testConfig = { session: { store: "/tmp/x" } };
const tempPaths: string[] = [];

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let setActiveDegradedPlugins: typeof import("../plugins/runtime-degraded-state.js").setActiveDegradedPlugins;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let getHealthSnapshot: typeof import("./health.js").getHealthSnapshot;

describe("getHealthSnapshot plugin state", () => {
  beforeAll(async () => {
    vi.doMock("../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
      loadConfig: () => testConfig,
    }));
    vi.doMock("../config/sessions/paths.js", () => ({
      resolveStorePath: () => "/tmp/sessions.json",
    }));
    vi.doMock("../config/sessions/session-accessor.js", () => ({
      listSessionEntries: () => [],
    }));
    vi.doMock("../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => [],
    }));

    const [pluginsRuntime, degradedState, channelTestUtils, health] = await Promise.all([
      import("../plugins/runtime.js"),
      import("../plugins/runtime-degraded-state.js"),
      import("../test-utils/channel-plugins.js"),
      import("./health.js"),
    ]);
    setActivePluginRegistry = pluginsRuntime.setActivePluginRegistry;
    setActiveDegradedPlugins = degradedState.setActiveDegradedPlugins;
    createTestRegistry = channelTestUtils.createTestRegistry;
    getHealthSnapshot = health.getHealthSnapshot;
  });

  afterEach(() => {
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

    const snap = await getHealthSnapshot({ timeoutMs: 10, probe: false });

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
});
