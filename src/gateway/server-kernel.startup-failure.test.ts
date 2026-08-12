// #120332 round 53 (P2): a PRE-LIFECYCLE startup failure must not leave landed-ownership
// state behind. Kernel state prep activates the process-global plugin registry and pins the
// runtime config snapshot before the lifecycle exists; without clearing both, later validation
// (or a same-process retry) treats registrations from a Gateway that never started as landed
// channel owners and applies stale schemas.
import { describe, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotCore,
  listRuntimeAuthProfileStoreSnapshots,
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
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";

// #120332 round 55 (P2): teardown ORDER matters — the registry retires first (plugin-host
// cleanup still reads runtime config and secrets snapshots, as in normal shutdown), snapshots
// scrub afterwards.
const teardownOrder = vi.hoisted(() => ({ calls: [] as string[] }));
// Bootstrap publishes the ambient env-trigger policy BEFORE the config snapshot; failing the
// snapshot load lands in that window, where recovery cannot rely on the snapshot-changed scrub.
const configLoadFailure = vi.hoisted(() => ({ enabled: false }));
// P1 follow-up to cycle 35: the retirement of a SURVIVING gateway's registry happens inside the
// failed attempt, long before the catch runs. Probe the retired flag at the exact failure point
// so the regression cannot hide behind the catch re-marking the registry active.
const lifecycleFailureProbe = vi.hoisted(() => ({
  survivor: null as object | null,
  survivorRetiredAtFailure: null as boolean | null,
}));
// ClawSweeper cycle 38 (P1): failures AFTER prepareGatewayLifecycle succeeds route through
// closeOnStartupFailure. realLifecycle lets those tests run the real lifecycle (and its real
// close path); stubKernelTail completes the post-lifecycle kernel phases without booting the
// full production tail so the success-path commit is reachable at this seam.
const lifecycleStageFixture = vi.hoisted(() => ({
  realLifecycle: false,
  stubKernelTail: false,
}));
// The survivor-stripping fires inside the failed attempt's close, before the kernel catch can
// repair anything: probe the retired flag at the moment the close clears the attempt registry.
const closeClearProbe = vi.hoisted(() => ({
  survivor: null as object | null,
  survivorRetiredAtClear: null as boolean | null,
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  const registryLifecycle = await import("../plugins/registry-lifecycle.js");
  return {
    ...actual,
    clearActivePluginRegistry: async () => {
      teardownOrder.calls.push("registry");
      // Synchronous probe: the clear's own synchronous phase must still run inside this call
      // so restore-ordering against the clear's version-guarded tail stays observable.
      if (closeClearProbe.survivor) {
        closeClearProbe.survivorRetiredAtClear = registryLifecycle.isPluginRegistryRetired(
          closeClearProbe.survivor as never,
        );
      }
      return actual.clearActivePluginRegistry();
    },
  };
});

vi.mock("../secrets/runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/runtime-state.js")>();
  return {
    ...actual,
    clearSecretsRuntimeSnapshotState: () => {
      teardownOrder.calls.push("secrets");
      return actual.clearSecretsRuntimeSnapshotState();
    },
  };
});

vi.mock("./server-startup-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-startup-config.js")>();
  return {
    ...actual,
    loadGatewayStartupConfigSnapshot: (
      ...args: Parameters<typeof actual.loadGatewayStartupConfigSnapshot>
    ) => {
      if (configLoadFailure.enabled) {
        throw new Error("fixture config-load failure");
      }
      return actual.loadGatewayStartupConfigSnapshot(...args);
    },
  };
});

vi.mock("./server-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-lifecycle.js")>();
  return {
    ...actual,
    prepareGatewayLifecycle: async (...args: Parameters<typeof actual.prepareGatewayLifecycle>) => {
      if (lifecycleFailureProbe.survivor) {
        const registryLifecycle = await import("../plugins/registry-lifecycle.js");
        lifecycleFailureProbe.survivorRetiredAtFailure = registryLifecycle.isPluginRegistryRetired(
          lifecycleFailureProbe.survivor as never,
        );
      }
      if (lifecycleStageFixture.realLifecycle) {
        return actual.prepareGatewayLifecycle(...args);
      }
      throw new Error("fixture pre-lifecycle failure");
    },
  };
});

vi.mock("./server-core-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-core-runtime.js")>();
  return {
    ...actual,
    startGatewayCoreRuntime: async (
      input: Parameters<typeof actual.startGatewayCoreRuntime>[0],
    ) => {
      if (lifecycleStageFixture.stubKernelTail) {
        return input.lifecycleRuntime as Awaited<ReturnType<typeof actual.startGatewayCoreRuntime>>;
      }
      return actual.startGatewayCoreRuntime(input);
    },
  };
});

vi.mock("./server-kernel-request-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-kernel-request-runtime.js")>();
  return {
    ...actual,
    prepareGatewayKernelRequestRuntime: async (
      params: Parameters<typeof actual.prepareGatewayKernelRequestRuntime>[0],
    ) => {
      if (lifecycleStageFixture.stubKernelTail) {
        return params.coreRuntime as Awaited<
          ReturnType<typeof actual.prepareGatewayKernelRequestRuntime>
        >;
      }
      return actual.prepareGatewayKernelRequestRuntime(params);
    },
  };
});

describe("createGatewayKernel pre-lifecycle failure", () => {
  it("clears the activated plugin registry and runtime config snapshot", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-prelifecycle-failure",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-prelifecycle-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
      },
    });
    state.applyEnv();
    // Start from a clean slate so the attempt PUBLISHES its own registry and snapshot: this
    // test pins that a failed attempt's own publications are fully cleared (the embedded
    // prior-state preservation is pinned in server-kernel.startup-failure-early.test.ts).
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshotState();
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("fixture pre-lifecycle failure");
      expect(getActivePluginRegistry()).toBeNull();
      expect(getRuntimeConfigSnapshot()).toBeNull();
      // No prior gateway existed: bootstrap's ambient policy and applied hash must not
      // survive the failed attempt, or projections keep applying a loader policy (and
      // config.get keeps reporting an applied revision) from a Gateway that never started.
      expect(getRuntimeAmbientEnvTriggers()).toBeNull();
      expect(getRuntimeConfigAppliedHash()).toBeNull();
      // Bootstrap activated this attempt's own secrets snapshot before the lifecycle failure;
      // with no prior gateway the scrub-on-failure contract leaves every secrets slot cleared.
      expect(getActiveSecretsRuntimeSnapshotState()).toBeNull();
      expect(getLiveSecretsRuntimeAuthStores()).toEqual([]);
      expect(listRuntimeAuthProfileStoreSnapshots()).toEqual([]);
      expect(getActiveRuntimeWebToolsMetadataFromState()).toBeNull();
      // Registry teardown ran BEFORE the snapshot scrub.
      expect(teardownOrder.calls.lastIndexOf("registry")).toBeGreaterThanOrEqual(0);
      expect(teardownOrder.calls.lastIndexOf("registry")).toBeLessThan(
        teardownOrder.calls.lastIndexOf("secrets"),
      );
    } finally {
      await state.cleanup();
    }
  });

  // #120332 round 58 (P2): the ambient env-trigger slot travels with the snapshot family. A
  // surviving embedded Gateway's projections must keep honoring the policy its loader applied
  // even when the failed attempt's bootstrap overwrote the slot. The applied config hash rides
  // along: config.get must keep reporting the revision the surviving loader accepted, not null.
  it("restores the prior applied config hash and ambient env-trigger policy", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-ambient-restore",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-ambient-token";
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
    // The surviving embedded gateway's state: registry + applied snapshot + suppress policy.
    setActivePluginRegistry(createEmptyPluginRegistry(), "embedded-prior-ambient");
    const runningConfig: OpenClawConfig = { channels: {} };
    setAppliedRuntimeConfigSnapshot(runningConfig, runningConfig);
    setRuntimeAmbientEnvTriggers("suppress");
    const priorAppliedHash = getRuntimeConfigAppliedHash();
    expect(priorAppliedHash).not.toBeNull();
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("fixture pre-lifecycle failure");
      expect(getRuntimeAmbientEnvTriggers()).toBe("suppress");
      expect(getRuntimeConfigAppliedHash()).toBe(priorAppliedHash);
    } finally {
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });

  // A failed FIRST start can die AFTER bootstrap publishes the ambient policy but BEFORE it
  // publishes the snapshot: the snapshot-changed restore never runs, so recovery must return
  // the slot to null on its own — a process that runs no gateway must not keep suppressing
  // env-triggered channel claims.
  it("clears the ambient env-trigger policy when no prior gateway existed", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-ambient-null-prior",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-ambient-null-token";
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
    expect(getRuntimeAmbientEnvTriggers()).toBeNull();
    configLoadFailure.enabled = true;
    try {
      await expect(
        createGatewayKernel(port, {
          ambientEnvTriggers: "suppress",
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("fixture config-load failure");
      expect(getRuntimeAmbientEnvTriggers()).toBeNull();
      expect(getRuntimeConfigSnapshot()).toBeNull();
    } finally {
      configLoadFailure.enabled = false;
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });

  // ClawSweeper cycle 35 (P1): a failed SECOND start replaces the active secrets snapshot during
  // bootstrap and dies before a lifecycle exists. Clearing without reactivating the captured
  // prior state strips the surviving embedded Gateway's secrets runtime — active snapshot,
  // auth-store snapshots, web-tool metadata — while registry and config state come back.
  it("restores the surviving gateway's secrets runtime after a failed second start", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-secrets-restore",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-secrets-token";
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
    // The surviving embedded gateway's state: registry + applied snapshot + activated secrets
    // runtime (seeded through the same activation seam gateway startup uses).
    setActivePluginRegistry(createEmptyPluginRegistry(), "embedded-prior-secrets");
    const runningConfig: OpenClawConfig = { channels: {} };
    setAppliedRuntimeConfigSnapshot(runningConfig, runningConfig);
    const agentDir = "/tmp/openclaw-embedded-prior-secrets";
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
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("fixture pre-lifecycle failure");
      // The surviving gateway keeps resolving through its activated secrets runtime.
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
      clearSecretsRuntimeSnapshotState();
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });

  // P1 follow-up to cycle 35: the PRODUCTION bootstrap branch publishes a fresh pre-bind
  // registry; a plain set there would retire the still-running Gateway's registry — firing
  // its "disable" lifecycle hooks and deleting its live scheduler jobs — before the recovery
  // catch can restore anything. The restored registry must be live, not a repointed corpse.
  // Runs WITHOUT the minimal-gateway env: the minimal branch reuses the active registry, so
  // the displacement under test only exists on the production branch.
  it("keeps the surviving gateway's loaded registry live after a failed second start", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-registry-live",
      layout: "home",
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
    const token = "gateway-kernel-registry-live-token";
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
    setActivePluginRegistry(survivor, "embedded-prior-live", "gateway-bindable");
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
    const runningConfig: OpenClawConfig = { channels: {} };
    setAppliedRuntimeConfigSnapshot(runningConfig, runningConfig);
    lifecycleFailureProbe.survivor = survivor;
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("fixture pre-lifecycle failure");
      // At the failure point the attempt had already displaced the survivor; a retired flag
      // there means displacement retired it and its destructive cleanup was already racing.
      expect(lifecycleFailureProbe.survivorRetiredAtFailure).toBe(false);
      expect(getActivePluginRegistry()).toBe(survivor);
      expect(isPluginRegistryRetired(survivor)).toBe(false);
      // Retirement cleanup is fire-and-forget: give any scheduled cleanup a bounded window to
      // land, then prove none ever fired and the survivor's scheduler job is still registered.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(lifecycleCleanupReasons).toEqual([]);
      expect(schedulerCleanupReasons).toEqual([]);
      expect(
        getPluginSessionSchedulerJobGeneration({
          pluginId: "embedded-prior-plugin",
          jobId: "embedded-prior-job",
          sessionKey: "embedded-prior-session",
        }),
      ).toBeDefined();
    } finally {
      lifecycleFailureProbe.survivor = null;
      lifecycleFailureProbe.survivorRetiredAtFailure = null;
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });

  // P1 follow-up to cycle 35: the running Gateway activates plugins as "gateway-bindable", but
  // recovery restored the captured registry with a hard-coded "default" mode — downgrading the
  // surviving registry despite the runtime snapshot contract preserving mode. Same production
  // (non-minimal) displacement path as the loaded-lifecycle regression above.
  it("restores the surviving registry's runtime mode after a failed second start", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-mode-restore",
      layout: "home",
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
    const token = "gateway-kernel-mode-token";
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
    const survivor = createEmptyPluginRegistry();
    setActivePluginRegistry(survivor, "embedded-prior-mode", "gateway-bindable");
    const runningConfig: OpenClawConfig = { channels: {} };
    setAppliedRuntimeConfigSnapshot(runningConfig, runningConfig);
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("fixture pre-lifecycle failure");
      expect(getActivePluginRegistry()).toBe(survivor);
      expect(getActivePluginRegistryKey()).toBe("embedded-prior-mode");
      expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
    } finally {
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });
});

describe("createGatewayKernel lifecycle-stage startup failure", () => {
  // ClawSweeper cycle 38 (P1): committing the staged registry as soon as the lifecycle exists
  // retires the surviving embedded Gateway's registry while startup can still fail — and the
  // lifecycle failure branch only closes the candidate, leaving the slot empty. This drives a
  // REAL post-lifecycle failure (TLS configured but unavailable, thrown by the kernel after
  // prepareGatewayLifecycle) through the real closeOnStartupFailure. Non-minimal: the
  // displacement under test only exists on the production bootstrap branch.
  // Twin of the pre-lifecycle restores: the close also scrubs the SNAPSHOT families — its
  // secrets clear cascades into the config snapshot, applied hash, and ambient policy — so
  // the survivor's seeded snapshot state must come back after the same failure.
  it("keeps the surviving gateway live when startup fails after the lifecycle exists", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-lifecycle-stage-failure",
      layout: "home",
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
    const token = "gateway-kernel-lifecycle-stage-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
        tls: {
          enabled: true,
          autoGenerate: false,
          certPath: state.path("missing-cert.pem"),
          keyPath: state.path("missing-key.pem"),
        },
      },
    });
    state.applyEnv();
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshotState();
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
    setActivePluginRegistry(survivor, "embedded-prior-tls", "gateway-bindable");
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
    const runningConfig: OpenClawConfig = { channels: {} };
    setAppliedRuntimeConfigSnapshot(runningConfig, runningConfig);
    setRuntimeAmbientEnvTriggers("suppress");
    // The survivor's activated secrets runtime, seeded through the same activation seam
    // gateway startup uses (it re-pins the runtime config snapshot with its own clone, so
    // capture the prior snapshot reference and applied hash AFTER activation — matching
    // what the kernel captures at attempt start).
    const agentDir = "/tmp/openclaw-embedded-prior-tls";
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
    lifecycleStageFixture.realLifecycle = true;
    closeClearProbe.survivor = survivor;
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway tls: cert/key missing");
      // When closeOnStartupFailure cleared the attempt registry, a retired survivor means the
      // commit fired mid-attempt and its destructive cleanup was already racing.
      expect(closeClearProbe.survivorRetiredAtClear).toBe(false);
      expect(getActivePluginRegistry()).toBe(survivor);
      expect(isPluginRegistryRetired(survivor)).toBe(false);
      expect(getActivePluginRegistryKey()).toBe("embedded-prior-tls");
      expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
      // Retirement cleanup is fire-and-forget: give any scheduled cleanup a bounded window to
      // land, then prove none ever fired and the survivor's scheduler job is still registered.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(lifecycleCleanupReasons).toEqual([]);
      expect(schedulerCleanupReasons).toEqual([]);
      expect(
        getPluginSessionSchedulerJobGeneration({
          pluginId: "embedded-prior-plugin",
          jobId: "embedded-prior-job",
          sessionKey: "embedded-prior-session",
        }),
      ).toBeDefined();
      // The close scrubbed the snapshot families after its registry clear; the kernel must
      // restore the survivor's captured prior state, not leave the slots nulled.
      expect(getRuntimeConfigSnapshot()).toBe(priorSnapshot);
      expect(getRuntimeConfigAppliedHash()).toBe(priorAppliedHash);
      expect(getRuntimeAmbientEnvTriggers()).toBe("suppress");
      // The surviving gateway keeps resolving through its activated secrets runtime.
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
      lifecycleStageFixture.realLifecycle = false;
      closeClearProbe.survivor = null;
      closeClearProbe.survivorRetiredAtClear = null;
      clearSecretsRuntimeSnapshotState();
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });

  // Fresh-process guard: a FIRST start's post-lifecycle failure has no survivor, so the
  // restore must be a no-op — prior values are null, and every snapshot slot ends cleared,
  // preserving the close's scrub contract for a process that runs no gateway.
  it("scrubs snapshot state when a first start fails after the lifecycle exists", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-lifecycle-stage-first-start",
      layout: "home",
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
    const token = "gateway-kernel-lifecycle-stage-first-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
        tls: {
          enabled: true,
          autoGenerate: false,
          certPath: state.path("missing-cert.pem"),
          keyPath: state.path("missing-key.pem"),
        },
      },
    });
    state.applyEnv();
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshotState();
    lifecycleStageFixture.realLifecycle = true;
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway tls: cert/key missing");
      expect(getActivePluginRegistry()).toBeNull();
      expect(getRuntimeConfigSnapshot()).toBeNull();
      expect(getRuntimeConfigAppliedHash()).toBeNull();
      expect(getRuntimeAmbientEnvTriggers()).toBeNull();
      expect(getActiveSecretsRuntimeSnapshotState()).toBeNull();
      expect(getLiveSecretsRuntimeAuthStores()).toEqual([]);
      expect(getActiveRuntimeWebToolsMetadataFromState()).toBeNull();
    } finally {
      lifecycleStageFixture.realLifecycle = false;
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  });

  // ClawSweeper cycle 41 (P1): committing at kernel return retires the survivor while the
  // transport bind (and the rest of listener startup) can still fail — and that failure's
  // close can only clear the candidate, leaving nothing live. Kernel success must keep the
  // pre-bind registry STAGED so the post-kernel failure close aborts back to the survivor;
  // the commit belongs to the loader's startup-plugin activation after the listener binds
  // (the success path is pinned in server-start.startup-failure.test.ts).
  it("keeps the survivor staged past kernel success so a bind failure restores it", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-lifecycle-stage-success",
      layout: "home",
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
    const token = "gateway-kernel-lifecycle-stage-success-token";
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
    setActivePluginRegistry(survivor, "embedded-prior-success", "gateway-bindable");
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
    lifecycleStageFixture.realLifecycle = true;
    lifecycleStageFixture.stubKernelTail = true;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    try {
      kernel = await createGatewayKernel(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      // The attempt's pre-bind registry stays OFF-SLOT: the still-serving survivor remains
      // the process root at kernel return — transport creation and the listener bind still
      // lie ahead, and the survivor's readers must keep resolving its own registry.
      expect(getActivePluginRegistry()).toBe(survivor);
      expect(isPluginRegistryRetired(survivor)).toBe(false);
      // The bind-failure close (startGatewayServerCore's catch) aborts the staged attempt
      // off-slot, leaving the survivor live — key, mode, lifecycle, and scheduler job intact.
      const closing = kernel.closeOnStartupFailure();
      kernel = undefined;
      await closing;
      expect(getActivePluginRegistry()).toBe(survivor);
      expect(isPluginRegistryRetired(survivor)).toBe(false);
      expect(getActivePluginRegistryKey()).toBe("embedded-prior-success");
      expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(lifecycleCleanupReasons).toEqual([]);
      expect(schedulerCleanupReasons).toEqual([]);
      expect(
        getPluginSessionSchedulerJobGeneration({
          pluginId: "embedded-prior-plugin",
          jobId: "embedded-prior-job",
          sessionKey: "embedded-prior-session",
        }),
      ).toBeDefined();
    } finally {
      lifecycleStageFixture.realLifecycle = false;
      lifecycleStageFixture.stubKernelTail = false;
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        resetPluginRuntimeStateForTest();
        clearRuntimeConfigSnapshot();
        await state.cleanup();
      }
    }
  });
});
