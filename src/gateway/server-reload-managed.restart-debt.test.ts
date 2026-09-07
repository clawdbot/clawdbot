import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  ConfigFileSnapshot,
  ConfigWriteNotification,
  OpenClawConfig,
} from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigAppliedHash,
  getRuntimeConfigSourceSnapshot,
  hashRuntimeConfigValue,
  setAppliedRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

const watcher = vi.hoisted(() => ({ current: undefined as EventEmitter | undefined }));
vi.mock("chokidar", () => ({
  default: {
    watch: (_paths: string[], options: { usePolling?: boolean }) => {
      const events = new EventEmitter();
      watcher.current = events;
      return Object.assign(events, {
        options,
        add: vi.fn(),
        unwatch: vi.fn(),
        close: async () => {
          events.removeAllListeners();
        },
      });
    },
  },
}));

const dirs = createTempDirTracker();
afterEach(() => {
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  closeOpenClawStateDatabaseForTest();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

async function createHarness(withStoreRef: boolean) {
  const root = dirs.make("openclaw-restart-debt-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  const initialConfig: OpenClawConfig = { gateway: { port: 18789 } };
  const nextConfig: OpenClawConfig = {
    gateway: {
      port: 18790,
      ...(withStoreRef
        ? {
            auth: {
              mode: "token",
              token: { source: "store", provider: "default", id: "RESTART_TEST_TOKEN" },
            },
          }
        : {}),
    },
  };
  writeSecretStoreEntry({
    scope: { kind: "team" },
    name: "RESTART_TEST_TOKEN",
    kind: "secret",
    value: "fixture-restart-token",
    updatedBy: "test",
    database: { env: process.env },
  });
  let settleWrite: ((outcome: string) => void) | undefined;
  const recordFailure = (message: string) => {
    if (message.includes("failed") || message.includes("superseded")) {
      settleWrite?.(message);
    }
  };
  const log = { info: vi.fn(recordFailure), warn: vi.fn(), error: vi.fn(recordFailure) };
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    logSecrets: log,
    emitStateEvent: vi.fn(),
  });
  await activateRuntimeSecrets(initialConfig, {
    reason: "startup",
    activate: true,
    includeAuthStoreRefs: false,
  });
  setAppliedRuntimeConfigSnapshot(initialConfig, initialConfig);
  const activeHash = getRuntimeConfigAppliedHash();
  let config = initialConfig;
  let hash = "initial";
  let listener: ((event: ConfigWriteNotification) => void) | undefined;
  const readSnapshot = async (): Promise<ConfigFileSnapshot> => ({
    path: path.join(root, "openclaw.json"),
    exists: true,
    raw: JSON.stringify(config),
    parsed: config,
    sourceConfig: config,
    resolved: config,
    runtimeConfig: config,
    config,
    valid: true,
    hash,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
  const promoteSnapshot = vi.fn(async () => {
    settleWrite?.("accepted");
    return true;
  });
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  const reloader = startManagedGatewayConfigReloader({
    configRevisionProjector: {
      projectRawHash: (value) => value,
      projectResolvedHash: (value) => value,
    },
    minimalTestGateway: false,
    initialConfig,
    initialCompareConfig: initialConfig,
    initialSnapshotRawHash: hash,
    initialAuthoredConfig: initialConfig,
    initialSnapshotValid: true,
    initialSnapshotIssues: [],
    initialInternalWriteHash: null,
    watchPath: path.join(root, "openclaw.json"),
    readSnapshot,
    promoteSnapshot,
    subscribeToWrites: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    deps: {},
    broadcast: vi.fn(),
    getState: () => {
      throw new Error("Restart must not hot-apply services");
    },
    setState: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    reloadPlugins: vi.fn(),
    logHooks: log,
    logChannels: log,
    logCron: log,
    logReload: log,
    cronReconciliation: { arm: () => ({ complete: async () => {} }), invalidate: vi.fn() },
    channelManager: {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getPluginCommandCatalogAccounts: () => new Map(),
      startChannels: vi.fn(),
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      setAutostartSuppression: vi.fn(),
      getAutostartSuppression: () => null,
      recoverAutostartSuppression: async () => false,
      setAmbientAutostartSuppressedChannelIds: vi.fn(),
      isAmbientAutostartSuppressed: () => false,
      markChannelLoggedOut: vi.fn(),
      isManuallyStopped: () => false,
      isAutoRestartScheduled: () => false,
      resetRestartAttempts: vi.fn(),
      isHealthMonitorEnabled: () => false,
      pruneInactiveChannelAccountState: vi.fn(),
    },
    activateRuntimeSecrets,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: { current: undefined, required: null },
    clients: [],
    prepareTerminalConfig: vi.fn(),
    reconcileTerminalSessions: vi.fn(),
    commitTerminalConfig: vi.fn(),
    acceptTerminalConfig: vi.fn(),
    requestRecoveryRestart,
  });
  return {
    reloader,
    initialConfig,
    nextConfig,
    activeHash,
    log,
    promoteSnapshot,
    requestRecoveryRestart,
    async write(
      next: OpenClawConfig,
      nextHash: string,
      revision: number,
      afterWrite: ConfigWriteNotification["afterWrite"] = { mode: "auto" },
    ) {
      config = next;
      hash = nextHash;
      if (!listener) {
        throw new Error("Missing config write subscription");
      }
      const settled = new Promise<string>((resolve) => {
        settleWrite = resolve;
      });
      listener({
        configPath: path.join(root, "openclaw.json"),
        sourceConfig: config,
        runtimeConfig: config,
        persistedHash: hash,
        revision,
        fingerprint: hashRuntimeConfigValue(config),
        sourceFingerprint: hashRuntimeConfigValue(config),
        writtenAtMs: Date.now(),
        afterWrite,
      });
      await vi.advanceTimersByTimeAsync(0);
      return await settled;
    },
    echo() {
      watcher.current?.emit("change", path.join(root, "openclaw.json"));
    },
  };
}

describe("managed restart debt after an equivalent new write", () => {
  it.each([
    { withStoreRef: false, metadata: false },
    { withStoreRef: true, metadata: false },
    { withStoreRef: false, metadata: true },
    { withStoreRef: true, metadata: true },
  ])(
    "keeps restart-pending config separate from active secrets ($withStoreRef, metadata: $metadata)",
    async ({ withStoreRef, metadata }) => {
      const harness = await createHarness(withStoreRef);
      vi.useFakeTimers();
      const activeRequest = tryBeginGatewayRootWorkAdmission();
      expect(activeRequest).not.toBeNull();
      try {
        expect(await harness.write(harness.nextConfig, "patch", 1)).toBe("accepted");
        expect(harness.promoteSnapshot).toHaveBeenCalledOnce();
        expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
        // A new persisted hash (for example formatting) is not the same-raw watcher echo.
        const equivalent = {
          ...harness.nextConfig,
          ...(metadata ? { meta: { lastTouchedVersion: "test-apply" } } : {}),
        };
        expect(await harness.write(equivalent, "apply", 2)).toBe("accepted");
        expect(harness.log.error.mock.calls).toEqual([]);
        expect(harness.promoteSnapshot).toHaveBeenCalledTimes(2);
        harness.echo();
        await vi.advanceTimersByTimeAsync(300);
        expect(harness.log.error.mock.calls).toEqual([]);
        expect(getRuntimeConfigSourceSnapshot()).toEqual(harness.initialConfig);
        expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(harness.initialConfig);
        expect(getRuntimeConfigAppliedHash()).toBe(harness.activeHash);
        activeRequest?.release();
        await vi.advanceTimersByTimeAsync(500);
        await vi.waitFor(() => expect(harness.requestRecoveryRestart).toHaveBeenCalledOnce());
        expect(getRuntimeConfigAppliedHash()).toBe(harness.activeHash);
      } finally {
        activeRequest?.release();
        await harness.reloader.stop();
      }
    },
  );

  it.each(["skipped", "invalid", "reverted", "stopped"] as const)(
    "does not rearm a %s candidate's paused restart",
    async (disposition) => {
      const harness = await createHarness(true);
      vi.useFakeTimers();
      const activeRequest = tryBeginGatewayRootWorkAdmission();
      expect(activeRequest).not.toBeNull();
      try {
        expect(await harness.write(harness.nextConfig, "patch", 1)).toBe("accepted");
        if (disposition === "stopped") {
          await harness.reloader.stop();
        } else if (disposition === "invalid") {
          const invalid: OpenClawConfig = {
            gateway: {
              ...harness.nextConfig.gateway,
              auth: {
                mode: "token",
                token: { source: "store", provider: "default", id: "MISSING_RESTART_TEST_TOKEN" },
              },
            },
          };
          expect(await harness.write(invalid, "invalid", 2)).toContain("config restart failed:");
        } else {
          expect(
            await harness.write(
              disposition === "reverted" ? harness.initialConfig : harness.nextConfig,
              disposition,
              2,
              disposition === "skipped"
                ? { mode: "none", reason: "caller owns application" }
                : { mode: "auto" },
            ),
          ).toBe("accepted");
          harness.echo();
        }
        activeRequest?.release();
        await vi.advanceTimersByTimeAsync(1500);
        expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
        expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(harness.initialConfig);
        expect(getRuntimeConfigAppliedHash()).toBe(harness.activeHash);
        if (disposition === "skipped" || disposition === "invalid") {
          expect(await harness.write(harness.nextConfig, "retry", 3)).toBe("accepted");
          await vi.waitFor(() => expect(harness.requestRecoveryRestart).toHaveBeenCalledOnce());
        }
      } finally {
        activeRequest?.release();
        await harness.reloader.stop();
      }
    },
  );
});
