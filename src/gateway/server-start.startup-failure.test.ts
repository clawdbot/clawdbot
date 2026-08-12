// ClawSweeper cycle 41 (P1): the staged pre-bind registry must stay staged through successful
// listener startup. Committing at kernel return retired a surviving embedded Gateway's registry
// while the transport bind could still fail — the bind-failure close then only cleared the
// candidate, leaving the survivor's slot empty and its destructive disable-cleanup already
// fired. These tests drive the REAL startGatewayServerCore: a port-in-use bind failure must
// restore the survivor (registry live, key/mode preserved, snapshot families reactivated), and
// a fully successful second start must still retire the displaced survivor exactly once.
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotCore,
} from "../agents/auth-profiles/runtime-snapshots.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeAmbientEnvTriggers,
  getRuntimeConfigAppliedHash,
  getRuntimeConfigSnapshot,
  setAppliedRuntimeConfigSnapshot,
  setRuntimeAmbientEnvTriggers,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPluginSessionSchedulerJobGeneration,
  registerPluginSessionSchedulerJob,
} from "../plugins/host-hook-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotState,
  getLiveSecretsRuntimeAuthStores,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { startGatewayServerCore } from "./server-start.js";

// Full production (non-minimal) startups: local runs finish well under this, the budget only
// buys headroom for loaded CI runners plus the bind-failure EADDRINUSE retry window (~10s).
const START_BUDGET_MS = 180_000;

async function createServerStartTestState(label: string): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    label,
    layout: "home",
    applyEnv: false,
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      VITEST: "1",
    },
  });
  // Keep the post-bind plugin load deterministic and light: an empty bundled dir means the
  // startup-plugin activation runs (the commit point under test) without materializing any
  // bundled plugin runtime.
  const { mkdir } = await import("node:fs/promises");
  const bundledDir = state.path("empty-bundled-plugins");
  await mkdir(bundledDir, { recursive: true });
  state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
  return state;
}

function createObservableSurvivor(): {
  survivor: PluginRegistry;
  lifecycleCleanupReasons: string[];
  schedulerCleanupReasons: string[];
} {
  // The surviving embedded gateway: a LOADED registry whose retirement is observable — a
  // runtime lifecycle cleanup hook plus a live dynamic scheduler job it owns.
  const lifecycleCleanupReasons: string[] = [];
  const schedulerCleanupReasons: string[] = [];
  const survivor: PluginRegistry = {
    ...createEmptyPluginRegistry(),
    runtimeLifecycles: [
      {
        pluginId: "embedded-prior-plugin",
        lifecycle: {
          id: "embedded-prior-lifecycle",
          cleanup: (ctx) => {
            lifecycleCleanupReasons.push(ctx.reason);
          },
        },
        source: "test",
      },
    ],
  };
  return { survivor, lifecycleCleanupReasons, schedulerCleanupReasons };
}

function registerSurvivorSchedulerJob(
  survivor: PluginRegistry,
  schedulerCleanupReasons: string[],
): void {
  const schedulerJob = registerPluginSessionSchedulerJob({
    pluginId: "embedded-prior-plugin",
    job: {
      id: "embedded-prior-job",
      sessionKey: "embedded-prior-session",
      kind: "watchdog",
      cleanup: (ctx) => {
        schedulerCleanupReasons.push(ctx.reason);
      },
    },
    ownerRegistry: survivor,
  });
  expect(schedulerJob).toBeDefined();
}

function survivorSchedulerJobGeneration() {
  return getPluginSessionSchedulerJobGeneration({
    pluginId: "embedded-prior-plugin",
    jobId: "embedded-prior-job",
    sessionKey: "embedded-prior-session",
  });
}

async function occupyLoopbackPort(port: number): Promise<() => Promise<void>> {
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });
}

describe("startGatewayServerCore late startup failure", () => {
  // The reviewer's scenario: the second embedded start survives the whole kernel, then fails
  // at the transport bind (port in use). The catch's close must abort the still-staged
  // attempt back to the survivor, and the snapshot families the close scrubbed must come
  // back — otherwise the surviving gateway keeps running with a retired registry corpse and
  // no secrets/config runtime.
  it(
    "restores the surviving gateway when the second start fails to bind",
    { timeout: START_BUDGET_MS },
    async () => {
      const port = await getFreePort();
      const state = await createServerStartTestState("gateway-start-bind-failure");
      const token = "gateway-start-bind-failure-token";
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
      });
      state.applyEnv();
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      clearSecretsRuntimeSnapshotState();
      const { survivor, lifecycleCleanupReasons, schedulerCleanupReasons } =
        createObservableSurvivor();
      setActivePluginRegistry(survivor, "embedded-prior-bind", "gateway-bindable");
      registerSurvivorSchedulerJob(survivor, schedulerCleanupReasons);
      const runningConfig: OpenClawConfig = { channels: {} };
      setAppliedRuntimeConfigSnapshot(runningConfig, runningConfig);
      setRuntimeAmbientEnvTriggers("suppress");
      // The survivor's activated secrets runtime, seeded through the same activation seam
      // gateway startup uses (it re-pins the runtime config snapshot with its own clone, so
      // capture the prior snapshot reference and applied hash AFTER activation — matching
      // what the kernel captures at attempt start).
      const agentDir = "/tmp/openclaw-embedded-prior-bind";
      const priorSecrets: PreparedSecretsRuntimeSnapshot = {
        sourceConfig: runningConfig,
        config: runningConfig,
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:embedded-prior": {
                  type: "api_key",
                  provider: "openai",
                  key: "sk-embedded-prior",
                },
              },
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "configured", selectedProvider: "brave", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      };
      activateSecretsRuntimeSnapshotState({
        snapshot: priorSecrets,
        refreshContext: null,
        refreshHandler: null,
      });
      const priorSnapshot = getRuntimeConfigSnapshot();
      expect(priorSnapshot).not.toBeNull();
      const priorAppliedHash = getRuntimeConfigAppliedHash();
      expect(priorAppliedHash).not.toBeNull();
      const releasePort = await occupyLoopbackPort(port);
      try {
        await expect(
          startGatewayServerCore(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          }),
        ).rejects.toThrow(/already listening|failed to bind/);
        // The staged attempt aborted back to the survivor: live, active, mode preserved.
        expect(getActivePluginRegistry()).toBe(survivor);
        expect(isPluginRegistryRetired(survivor)).toBe(false);
        expect(getActivePluginRegistryKey()).toBe("embedded-prior-bind");
        expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
        // Retirement cleanup is fire-and-forget: give any scheduled cleanup a bounded window
        // to land, then prove none ever fired and the scheduler job is still registered.
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        expect(lifecycleCleanupReasons).toEqual([]);
        expect(schedulerCleanupReasons).toEqual([]);
        expect(survivorSchedulerJobGeneration()).toBeDefined();
        // The close scrubbed the snapshot families after its registry clear; the failed start
        // must restore the survivor's captured prior state, not leave the slots nulled.
        expect(getRuntimeConfigSnapshot()).toBe(priorSnapshot);
        expect(getRuntimeConfigAppliedHash()).toBe(priorAppliedHash);
        expect(getRuntimeAmbientEnvTriggers()).toBe("suppress");
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(runningConfig);
        expect(
          getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:embedded-prior"],
        ).toMatchObject({ key: "sk-embedded-prior" });
        expect(getLiveSecretsRuntimeAuthStores()).toMatchObject([
          {
            agentDir,
            store: { profiles: { "openai:embedded-prior": { key: "sk-embedded-prior" } } },
          },
        ]);
        expect(getActiveRuntimeWebToolsMetadataFromState()?.search).toMatchObject({
          providerSource: "configured",
          selectedProvider: "brave",
        });
      } finally {
        await releasePort();
        clearSecretsRuntimeSnapshotState();
        resetPluginRuntimeStateForTest();
        clearRuntimeConfigSnapshot();
        await state.cleanup();
      }
    },
  );

  // Success-path guard: deferring the commit to the loader's post-bind activation must not
  // lose the retirement itself. A fully successful second start still retires the displaced
  // survivor exactly once — the activation commit's retirement, not a second one from the
  // completed replacement's own close — and ends with the loaded registry installed.
  it(
    "retires the displaced survivor exactly once when the second start fully succeeds",
    { timeout: START_BUDGET_MS },
    async () => {
      const port = await getFreePort();
      const state = await createServerStartTestState("gateway-start-success");
      const token = "gateway-start-success-token";
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
      });
      state.applyEnv();
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      const { survivor, lifecycleCleanupReasons, schedulerCleanupReasons } =
        createObservableSurvivor();
      setActivePluginRegistry(survivor, "embedded-prior-success", "gateway-bindable");
      registerSurvivorSchedulerJob(survivor, schedulerCleanupReasons);
      let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
      try {
        // "start" (not "defer"): close never awaits a still-deferred sidecar sequence, so a
        // deferred run outlives this test and bleeds its startup spans/registry work into the
        // next file sharing this isolate=false worker (server-kernel.test.ts's timeline).
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "start",
        });
        // The loaded startup registry owns the slot; the displaced survivor retired once,
        // with its disable-time lifecycle and scheduler cleanup fired.
        expect(getActivePluginRegistry()).not.toBe(survivor);
        expect(getActivePluginRegistry()).not.toBeNull();
        expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
        expect(isPluginRegistryRetired(survivor)).toBe(true);
        await vi.waitFor(() => {
          expect(lifecycleCleanupReasons).toEqual(["disable"]);
          expect(schedulerCleanupReasons).toEqual(["disable"]);
        });
        expect(survivorSchedulerJobGeneration()).toBeUndefined();
        // The completed replacement's own close must not fire a SECOND survivor retirement.
        const closing = server.close({ reason: "server-start success guard done" });
        server = undefined;
        await closing;
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        expect(lifecycleCleanupReasons).toEqual(["disable"]);
        expect(schedulerCleanupReasons).toEqual(["disable"]);
      } finally {
        try {
          await server?.close({ reason: "server-start success guard cleanup" });
        } finally {
          resetPluginRuntimeStateForTest();
          clearRuntimeConfigSnapshot();
          await state.cleanup();
        }
      }
    },
  );
});
