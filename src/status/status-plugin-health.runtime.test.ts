// Runtime plugin health tests cover state shared across runtime processes.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordPersistedRuntimeToolSchemaQuarantine } from "../agents/tool-schema-quarantine-health.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { recordPersistedContextEngineQuarantine } from "../context-engine/quarantine-health.js";
import { resetContextEngineRuntimeQuarantineForTests } from "../context-engine/registry.test-support.js";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { createRuntimeHealthRecordEnvelope } from "../plugin-state/runtime-health-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginSessionExtensionRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { collectRuntimePluginHealthSnapshot } from "./status-plugin-health.runtime.js";

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
}));

const resolveReadOnlyChannelPluginsForConfigMock = vi.mocked(
  resolveReadOnlyChannelPluginsForConfig,
);

afterEach(() => {
  resolveReadOnlyChannelPluginsForConfigMock.mockReset();
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests();
});

async function deadProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (!pid) {
    throw new Error("failed to spawn short-lived process");
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return pid;
}

function seedPersistedToolQuarantineForTest(record: {
  toolName: string;
  owner?: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  processToken: string;
  processStartTime: number | null;
}): void {
  createCorePluginStateSyncKeyedStore<typeof record>({
    ownerId: "core:runtime-tool-quarantine-health",
    namespace: "schema-quarantines",
    maxEntries: 128,
    defaultTtlMs: 24 * 60 * 60 * 1_000,
  }).register(JSON.stringify([record.owner ?? "", record.toolName, record.processId]), record);
}

describe("runtime plugin health snapshot", () => {
  it("includes persisted context-engine quarantines", async () => {
    await withStateDirEnv("openclaw-status-plugin-health-", async () => {
      resetContextEngineRuntimeQuarantineForTests();
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      expect(collectRuntimePluginHealthSnapshot().contextEngineQuarantines).toEqual([
        {
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "intentional bootstrap failure",
          failedAt: new Date(123),
        },
      ]);
    });
  });

  it("includes persisted runtime tool-schema quarantines", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-", async () => {
      const registry = createEmptyPluginRegistry();
      registry.plugins.push({
        id: "bad-tools",
        status: "loaded",
        enabled: true,
      } as never);
      setActivePluginRegistry(registry, "bad-tools", "default", "/tmp/ws");
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "bad_tool",
        owner: "plugin:bad-tools",
        reason: "unsupported anyOf",
        failedAt: new Date(456),
      });

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([
        {
          toolName: "bad_tool",
          owner: "plugin:bad-tools",
          reason: "unsupported anyOf",
          failedAt: new Date(456),
        },
      ]);
    });
  });

  it("includes core-owned runtime tool quarantines from this process", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-core-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "core_bad_tool",
        reason: "unsupported schema",
        failedAt: new Date(789),
      });

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([
        {
          toolName: "core_bad_tool",
          reason: "unsupported schema",
          failedAt: new Date(789),
        },
      ]);
    });
  });

  it("drops runtime tool quarantines from dead or unverifiable recorder processes", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-liveness-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      // Dead sibling: no current start time exists, so the record fails closed.
      seedPersistedToolQuarantineForTest({
        toolName: "stale_tool",
        reason: "unsupported schema",
        failedAtMs: 123,
        processId: await deadProcessId(),
        processToken: "dead-process-token",
        processStartTime: null,
      });
      seedPersistedToolQuarantineForTest({
        toolName: "live_tool",
        reason: "unsupported schema",
        ...createRuntimeHealthRecordEnvelope(new Date(456)),
      });

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([
        {
          toolName: "live_tool",
          reason: "unsupported schema",
          failedAt: new Date(456),
        },
      ]);
    });
  });

  it("drops runtime tool quarantines from a previous incarnation of this PID", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-pid-reuse-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      seedPersistedToolQuarantineForTest({
        toolName: "reused_pid_tool",
        reason: "unsupported schema",
        ...createRuntimeHealthRecordEnvelope(new Date(123)),
        processToken: "stale-incarnation-token",
      });

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([]);
    });
  });

  it("suppresses persisted plugin-owned runtime tool quarantines after the owner plugin is gone", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-owner-", async () => {
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "bad_tool",
        owner: "plugin:bad-tools",
        reason: "unsupported anyOf",
        failedAt: new Date(456),
      });

      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([]);

      const registry = createEmptyPluginRegistry();
      registry.plugins.push({
        id: "bad-tools",
        status: "loaded",
        enabled: true,
      } as never);
      setActivePluginRegistry(registry, "bad-tools", "default", "/tmp/ws");

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([
        {
          toolName: "bad_tool",
          owner: "plugin:bad-tools",
          reason: "unsupported anyOf",
          failedAt: new Date(456),
        },
      ]);
    });
  });

  it("classifies channel-setup diagnostics as channel plugin failures", () => {
    const registry = createEmptyPluginRegistry();
    registry.diagnostics.push({
      level: "error",
      pluginId: "broken-channel",
      code: "channel-setup-failure",
      message: "failed to load setup entry: boom",
    });
    setActivePluginRegistry(registry, "broken-channel", "default", "/tmp/ws");

    const snapshot = collectRuntimePluginHealthSnapshot();

    expect(snapshot.channelPluginFailures).toEqual([
      {
        channelId: "broken-channel",
        pluginId: "broken-channel",
        message: "failed to load setup entry: boom",
        source: "diagnostic",
      },
    ]);
  });

  it("does not inspect configured channel plugins for compact runtime health", () => {
    const registry = createEmptyPluginRegistry();
    registry.diagnostics.push({
      level: "error",
      pluginId: "broken-channel",
      code: "channel-setup-failure",
      message: "failed to load setup entry: boom",
    });
    setActivePluginRegistry(registry, "broken-channel", "default", "/tmp/ws");

    const snapshot = collectRuntimePluginHealthSnapshot();

    expect(snapshot.channelPluginFailures).toEqual([
      {
        channelId: "broken-channel",
        pluginId: "broken-channel",
        message: "failed to load setup entry: boom",
        source: "diagnostic",
      },
    ]);
    expect(resolveReadOnlyChannelPluginsForConfigMock).not.toHaveBeenCalled();
  });

  it("records only runtime status:loaded plugins as runtime-loaded", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "runtime-ok", status: "loaded", enabled: true } as never,
      { id: "runtime-broken", status: "error", enabled: true } as never,
      { id: "runtime-off", status: "disabled", enabled: false } as never,
    );
    setActivePluginRegistry(registry, "runtime-loaded-ids", "default", "/tmp/ws");

    expect(collectRuntimePluginHealthSnapshot().runtimeLoadedPluginIds).toEqual(["runtime-ok"]);
  });

  it("includes loaded plugins from a pinned channel registry diverged from active", () => {
    const active = createEmptyPluginRegistry();
    active.plugins.push({ id: "active-ok", status: "loaded", enabled: true } as never);
    setActivePluginRegistry(active, "active", "default", "/tmp/ws");

    const channel = createEmptyPluginRegistry();
    channel.plugins.push({ id: "channel-only", status: "loaded", enabled: true } as never);
    pinActivePluginChannelRegistry(channel);

    expect(collectRuntimePluginHealthSnapshot().runtimeLoadedPluginIds).toEqual([
      "active-ok",
      "channel-only",
    ]);
  });

  it("includes loaded plugins from a pinned http-route registry diverged from active", () => {
    const active = createEmptyPluginRegistry();
    active.plugins.push({ id: "active-ok", status: "loaded", enabled: true } as never);
    setActivePluginRegistry(active, "active", "default", "/tmp/ws");

    const httpRoute = createEmptyPluginRegistry();
    httpRoute.plugins.push({ id: "route-only", status: "loaded", enabled: true } as never);
    pinActivePluginHttpRouteRegistry(httpRoute);

    expect(collectRuntimePluginHealthSnapshot().runtimeLoadedPluginIds).toEqual([
      "active-ok",
      "route-only",
    ]);
  });

  it("includes loaded plugins from a pinned session-extension registry diverged from active", () => {
    const active = createEmptyPluginRegistry();
    active.plugins.push({ id: "active-ok", status: "loaded", enabled: true } as never);
    setActivePluginRegistry(active, "active", "default", "/tmp/ws");

    const sessionExtension = createEmptyPluginRegistry();
    sessionExtension.plugins.push({
      id: "session-only",
      status: "loaded",
      enabled: true,
    } as never);
    pinActivePluginSessionExtensionRegistry(sessionExtension);

    expect(collectRuntimePluginHealthSnapshot().runtimeLoadedPluginIds).toEqual([
      "active-ok",
      "session-only",
    ]);
  });

  it("dedupes runtime-loaded ids shared across registry surfaces", () => {
    const active = createEmptyPluginRegistry();
    active.plugins.push({ id: "shared", status: "loaded", enabled: true } as never);
    setActivePluginRegistry(active, "active", "default", "/tmp/ws");

    const channel = createEmptyPluginRegistry();
    channel.plugins.push(
      { id: "shared", status: "loaded", enabled: true } as never,
      { id: "channel-only", status: "loaded", enabled: true } as never,
    );
    pinActivePluginChannelRegistry(channel);

    expect(collectRuntimePluginHealthSnapshot().runtimeLoadedPluginIds).toEqual([
      "channel-only",
      "shared",
    ]);
  });
});
