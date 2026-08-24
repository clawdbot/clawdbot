/**
 * Proves `startManagedGatewayConfigReloader` forwards the underlying watcher's
 * live `hotReloadStatus()` accessor and owns cache invalidation at the accepted
 * candidate seam. This keeps request caching coupled to the actual watcher
 * lifecycle instead of individual config writers.
 */
import { describe, expect, it, vi } from "vitest";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import { startManagedGatewayConfigReloader } from "./server-reload-handlers.js";

const hoisted = vi.hoisted(() => ({
  hotReloadStatus: { current: "active" as "active" | "disabled" },
  invalidateConfigGetResponseCache: vi.fn(),
  onConfigCandidateCommitted: undefined as
    | ((info: {
        path: string;
        persistedHash: string | null;
        changedPaths: readonly string[];
      }) => void)
    | undefined,
  notifyPluginMetadataChanged: vi.fn(),
  stop: vi.fn(async () => {}),
}));

vi.mock("./config-get-response.js", () => ({
  invalidateConfigGetResponseCache: hoisted.invalidateConfigGetResponseCache,
}));

vi.mock("./config-reload.js", async () => {
  const actual = await vi.importActual<typeof import("./config-reload.js")>("./config-reload.js");
  return {
    ...actual,
    startGatewayConfigReloader: vi.fn(
      (options: {
        onConfigCandidateCommitted?: (info: {
          path: string;
          persistedHash: string | null;
          changedPaths: readonly string[];
        }) => void;
      }) => {
        hoisted.onConfigCandidateCommitted = options.onConfigCandidateCommitted;
        return {
          stop: hoisted.stop,
          hotReloadStatus: () => hoisted.hotReloadStatus.current,
          notifyPluginMetadataChanged: hoisted.notifyPluginMetadataChanged,
        };
      },
    ),
  };
});

describe("startManagedGatewayConfigReloader hotReloadStatus plumbing", () => {
  it("forwards live status and invalidates config.get on watcher commit", async () => {
    const initialConfig = { session: { store: "/tmp/sessions.json" } } as OpenClawConfig;
    const broadcast = vi.fn();
    const reloader = startManagedGatewayConfigReloader({
      configRevisionProjector: {
        projectRawHash: (hash) => `opaque:${hash}`,
        projectResolvedHash: (hash) => `resolved:${hash}`,
      },
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialSnapshotRawHash: null,
      initialAuthoredConfig: {},
      initialSnapshotValid: true,
      initialSnapshotIssues: [],
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn() as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: vi.fn(() => () => {}) as never,
      deps: {} as never,
      broadcast,
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
          reconcileExitWatchers: vi.fn(async () => {}),
          stopExitWatchers: vi.fn(),
          reconcileStreamWatchers: vi.fn(async () => {}),
          stopStreamWatchers: vi.fn(async () => {}),
          reconcileHeartbeatJobs: vi.fn(async () => {}),
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cronReconciliation: {
        arm: () => ({ complete: async () => {} }),
        invalidate: vi.fn(),
      },
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {},
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      prepareTerminalConfig: vi.fn(),
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      acceptTerminalConfig: vi.fn(),
      clients: [],
    });

    expect(reloader.hotReloadStatus).toBeTypeOf("function");
    expect(reloader.hotReloadStatus?.()).toBe("active");

    // Flip the underlying watcher's live state without recreating the managed
    // handle — a copied/snapshotted value would stay stuck on "active".
    hoisted.hotReloadStatus.current = "disabled";
    expect(reloader.hotReloadStatus?.()).toBe("disabled");

    hoisted.onConfigCandidateCommitted?.({
      path: "/tmp/openclaw.json",
      persistedHash: "persisted-1",
      changedPaths: ["gateway.port"],
    });
    expect(hoisted.invalidateConfigGetResponseCache).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      "config.changed",
      { path: "/tmp/openclaw.json", hash: "opaque:persisted-1", ts: expect.any(Number) },
      { dropIfSlow: true },
    );

    await reloader.stop();
    expect(hoisted.stop).toHaveBeenCalledOnce();
  });
});
