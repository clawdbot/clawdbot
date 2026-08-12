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
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
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

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return {
    ...actual,
    clearActivePluginRegistry: async () => {
      teardownOrder.calls.push("registry");
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
    prepareGatewayLifecycle: () => {
      throw new Error("fixture pre-lifecycle failure");
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
});
