// ClawSweeper cycle 41 (P1): the staged pre-bind registry must stay staged through successful
// listener startup. Committing at kernel return retired a surviving embedded Gateway's registry
// while the transport bind could still fail — the bind-failure close then only cleared the
// candidate, leaving the survivor's slot empty and its destructive disable-cleanup already
// fired. These tests drive the REAL startGatewayServerCore: a port-in-use bind failure must
// restore the survivor (registry live, key/mode preserved, snapshot families reactivated), and
// a fully successful second start must still retire the displaced survivor exactly once.
// ClawSweeper cycle 44 (P1): the survivor must stay recoverable PAST the loader's post-bind
// activation too — startup work after it (post-attach sidecars in "start" mode, config-reloader
// registration) can still reject startGatewayServerCore. The activation installs the loaded
// registry but retains the abort marker; the survivor retires only at startup-success finalize,
// so a late failure's close aborts back to it.
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
import type { GatewayClient } from "./client.js";
import { startGatewayServerCore } from "./server-start.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

// Full production (non-minimal) startups: local runs finish well under this, the budget only
// buys headroom for loaded CI runners plus the bind-failure EADDRINUSE retry window (~10s).
const START_BUDGET_MS = 180_000;

// Config-reloader registration is the last real startup step in finishGatewayStartup that can
// reject startGatewayServerCore, and it runs AFTER the loader's post-bind activation: the probe
// observes what the activation left behind at that exact point, and the flag turns the step
// into the reviewer's late-startup failure.
const reloaderFixture = vi.hoisted(() => ({
  failStart: false,
  survivor: null as object | null,
  survivorRetiredAtReloaderStart: null as boolean | null,
  activeRegistryAtReloaderStart: null as object | null,
}));

vi.mock("./server-reload-handlers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-reload-handlers.js")>();
  const [registryLifecycle, pluginRuntime] = await Promise.all([
    import("../plugins/registry-lifecycle.js"),
    import("../plugins/runtime.js"),
  ]);
  return {
    ...actual,
    startManagedGatewayConfigReloader: (
      ...args: Parameters<typeof actual.startManagedGatewayConfigReloader>
    ) => {
      if (reloaderFixture.survivor) {
        reloaderFixture.survivorRetiredAtReloaderStart = registryLifecycle.isPluginRegistryRetired(
          reloaderFixture.survivor as never,
        );
        reloaderFixture.activeRegistryAtReloaderStart = pluginRuntime.getActivePluginRegistry();
      }
      if (reloaderFixture.failStart) {
        throw new Error("fixture late-startup failure");
      }
      return actual.startManagedGatewayConfigReloader(...args);
    },
  };
});

function resetReloaderFixture(): void {
  reloaderFixture.failStart = false;
  reloaderFixture.survivor = null;
  reloaderFixture.survivorRetiredAtReloaderStart = null;
  reloaderFixture.activeRegistryAtReloaderStart = null;
}

// ClawSweeper cycle 45 (P1): a still-serving survivor's request paths must keep seeing the
// survivor's own registry DURING a second start attempt. These hooks open deterministic probe
// windows inside the two staged intervals: transport creation runs after the kernel staged the
// pre-bind attempt and before the listener binds (the pre-bind interval); post-attach return in
// "start" mode runs after the loader's activation and before startup-success finalize (the
// loaded-but-uncommitted interval).
const stagedIntervalFixture = vi.hoisted(() => ({
  onTransportCreate: null as (() => Promise<void>) | null,
  afterPostAttach: null as (() => Promise<void>) | null,
  failAfterPostAttach: false,
}));

vi.mock("./server-runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-runtime-state.js")>();
  return {
    ...actual,
    createGatewayHttpTransport: async (
      ...args: Parameters<typeof actual.createGatewayHttpTransport>
    ) => {
      await stagedIntervalFixture.onTransportCreate?.();
      return await actual.createGatewayHttpTransport(...args);
    },
  };
});

vi.mock("./server-startup-post-attach.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-startup-post-attach.js")>();
  return {
    ...actual,
    startGatewayPostAttachRuntime: async (
      ...args: Parameters<typeof actual.startGatewayPostAttachRuntime>
    ) => {
      const handles = await actual.startGatewayPostAttachRuntime(...args);
      await stagedIntervalFixture.afterPostAttach?.();
      if (stagedIntervalFixture.failAfterPostAttach) {
        throw new Error("fixture post-attach failure");
      }
      return handles;
    },
  };
});

function resetStagedIntervalFixture(): void {
  stagedIntervalFixture.onTransportCreate = null;
  stagedIntervalFixture.afterPostAttach = null;
  stagedIntervalFixture.failAfterPostAttach = false;
}

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

// ClawSweeper cycle 45 (P1): the staged intervals must not strip a concurrently SERVING
// gateway's plugin capabilities. Both tests run a REAL surviving gateway with an observable
// plugin capability (a registered plugin command listed by the commands.list RPC over its own
// authenticated WebSocket client) and probe that request path DURING a second start attempt.
describe("startGatewayServerCore staged-interval survivor request paths", () => {
  const PROBE_COMMAND = "cycle45-survivor-probe";

  function registerSurvivorProbeCommand(registry: PluginRegistry): void {
    registry.commands.push({
      pluginId: "cycle45-survivor-plugin",
      command: {
        name: PROBE_COMMAND,
        description: "cycle 45 staged-interval survivor capability probe",
        handler: () => ({ text: "ok" }),
      },
      source: "cycle45-test",
    });
  }

  async function probeSurvivorCommandNames(client: GatewayClient): Promise<string[]> {
    const payload = await client.request<{ commands: Array<{ name: string }> }>(
      "commands.list",
      {},
    );
    return payload.commands.map((entry) => entry.name);
  }

  function hasProbeCommand(names: readonly string[]): boolean {
    return names.some((name) => name.includes(PROBE_COMMAND));
  }

  it(
    "keeps the survivor's commands.list capability through a pre-bind staged interval",
    { timeout: START_BUDGET_MS },
    async () => {
      const port = await getFreePort();
      const state = await createServerStartTestState("gateway-start-prebind-probe");
      const token = "gateway-start-prebind-probe-token";
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
      let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
      let client: GatewayClient | undefined;
      try {
        // The REAL surviving gateway: a full (non-minimal) start whose loader-activated
        // registry owns the process slot, carrying an observable plugin command.
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "start",
        });
        const survivorRegistry = getActivePluginRegistry();
        expect(survivorRegistry).not.toBeNull();
        registerSurvivorProbeCommand(survivorRegistry!);
        client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          scopes: ["operator.admin"],
        });
        const baseline = await probeSurvivorCommandNames(client);
        console.log(
          `[cycle45-proof] baseline probe (before second start): probeCommandListed=${hasProbeCommand(baseline)}`,
        );
        expect(hasProbeCommand(baseline)).toBe(true);

        // Probe DURING the pre-bind staged interval of the second start attempt: transport
        // creation runs after the kernel staged the pre-bind attempt, before the bind fails
        // on the survivor's own port.
        let probedDuringInterval: {
          activeIsSurvivor: boolean;
          commandNames: string[];
        } | null = null;
        stagedIntervalFixture.onTransportCreate = async () => {
          stagedIntervalFixture.onTransportCreate = null;
          probedDuringInterval = {
            activeIsSurvivor: getActivePluginRegistry() === survivorRegistry,
            commandNames: await probeSurvivorCommandNames(client!),
          };
        };
        await expect(
          startGatewayServerCore(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          }),
        ).rejects.toThrow(/already listening|failed to bind/);

        expect(probedDuringInterval).not.toBeNull();
        const probe = probedDuringInterval! as {
          activeIsSurvivor: boolean;
          commandNames: string[];
        };
        console.log(
          `[cycle45-proof] pre-bind interval probe: activeIsSurvivor=${probe.activeIsSurvivor} probeCommandListed=${hasProbeCommand(probe.commandNames)}`,
        );
        // The still-serving survivor must remain the process root and keep answering its own
        // request paths with its own capabilities while the attempt is staged.
        expect(probe.activeIsSurvivor).toBe(true);
        expect(hasProbeCommand(probe.commandNames)).toBe(true);

        // After the aborted attempt the survivor still serves the capability.
        expect(getActivePluginRegistry()).toBe(survivorRegistry);
        expect(isPluginRegistryRetired(survivorRegistry!)).toBe(false);
        const afterAbort = await probeSurvivorCommandNames(client);
        console.log(
          `[cycle45-proof] post-abort probe: probeCommandListed=${hasProbeCommand(afterAbort)}`,
        );
        expect(hasProbeCommand(afterAbort)).toBe(true);
      } finally {
        resetStagedIntervalFixture();
        if (client) {
          await disconnectGatewayClient(client).catch(() => {});
        }
        try {
          await server?.close({ reason: "cycle45 pre-bind probe done" });
        } finally {
          resetPluginRuntimeStateForTest();
          clearRuntimeConfigSnapshot();
          await state.cleanup();
        }
      }
    },
  );

  it(
    "keeps the survivor's commands.list capability through the loaded-uncommitted interval",
    { timeout: START_BUDGET_MS },
    async () => {
      const survivorPort = await getFreePort();
      const state = await createServerStartTestState("gateway-start-loaded-probe");
      const token = "gateway-start-loaded-probe-token";
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port: survivorPort,
        },
      });
      state.applyEnv();
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
      let client: GatewayClient | undefined;
      try {
        server = await startGatewayServerCore(survivorPort, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "start",
        });
        const survivorRegistry = getActivePluginRegistry();
        expect(survivorRegistry).not.toBeNull();
        registerSurvivorProbeCommand(survivorRegistry!);
        client = await connectGatewayClient({
          url: `ws://127.0.0.1:${survivorPort}`,
          token,
          scopes: ["operator.admin"],
        });
        expect(hasProbeCommand(await probeSurvivorCommandNames(client))).toBe(true);

        // The second attempt binds a FREE port and fails AFTER post-attach returned in
        // "start" mode: the loader's activation already ran, finalize never does. The probe
        // runs exactly inside that loaded-but-uncommitted interval.
        let probedDuringInterval: {
          activeIsSurvivor: boolean;
          survivorRetired: boolean;
          commandNames: string[];
        } | null = null;
        stagedIntervalFixture.failAfterPostAttach = true;
        stagedIntervalFixture.afterPostAttach = async () => {
          stagedIntervalFixture.afterPostAttach = null;
          probedDuringInterval = {
            activeIsSurvivor: getActivePluginRegistry() === survivorRegistry,
            survivorRetired: isPluginRegistryRetired(survivorRegistry!),
            commandNames: await probeSurvivorCommandNames(client!),
          };
        };
        const attemptPort = await getFreePort();
        await expect(
          startGatewayServerCore(attemptPort, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "start",
          }),
        ).rejects.toThrow("fixture post-attach failure");

        expect(probedDuringInterval).not.toBeNull();
        const probe = probedDuringInterval! as {
          activeIsSurvivor: boolean;
          survivorRetired: boolean;
          commandNames: string[];
        };
        console.log(
          `[cycle45-proof] loaded-uncommitted interval probe: activeIsSurvivor=${probe.activeIsSurvivor} survivorRetired=${probe.survivorRetired} probeCommandListed=${hasProbeCommand(probe.commandNames)}`,
        );
        // The attempt's loaded registry owns the slot in this interval, but the survivor's
        // own request path must stay bound to the survivor's registry and capabilities.
        expect(probe.survivorRetired).toBe(false);
        expect(hasProbeCommand(probe.commandNames)).toBe(true);

        // The aborted attempt restored the survivor as process root; capability intact.
        expect(getActivePluginRegistry()).toBe(survivorRegistry);
        expect(isPluginRegistryRetired(survivorRegistry!)).toBe(false);
        const afterAbort = await probeSurvivorCommandNames(client);
        console.log(
          `[cycle45-proof] post-abort probe: probeCommandListed=${hasProbeCommand(afterAbort)}`,
        );
        expect(hasProbeCommand(afterAbort)).toBe(true);
      } finally {
        resetStagedIntervalFixture();
        if (client) {
          await disconnectGatewayClient(client).catch(() => {});
        }
        try {
          await server?.close({ reason: "cycle45 loaded-uncommitted probe done" });
        } finally {
          resetPluginRuntimeStateForTest();
          clearRuntimeConfigSnapshot();
          await state.cleanup();
        }
      }
    },
  );
});

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

  // ClawSweeper cycle 44 (P1): the reviewer's residual — startup fails AFTER the loader's
  // post-bind activation installed the fully loaded registry (here: the config-reloader
  // registration, in "start" mode so post-attach sidecar work already completed inside the
  // try). The activation must have kept the abort marker pointing at the original survivor,
  // so the failure's close tears the loaded attempt registry down and restores the survivor
  // live and un-retired.
  it(
    "restores the surviving gateway when startup fails after the loader's activation",
    { timeout: START_BUDGET_MS },
    async () => {
      const port = await getFreePort();
      const state = await createServerStartTestState("gateway-start-late-failure");
      const token = "gateway-start-late-failure-token";
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
      setActivePluginRegistry(survivor, "embedded-prior-late", "gateway-bindable");
      registerSurvivorSchedulerJob(survivor, schedulerCleanupReasons);
      const runningConfig: OpenClawConfig = { channels: {} };
      setAppliedRuntimeConfigSnapshot(runningConfig, runningConfig);
      const priorSnapshot = getRuntimeConfigSnapshot();
      expect(priorSnapshot).not.toBeNull();
      reloaderFixture.failStart = true;
      reloaderFixture.survivor = survivor;
      try {
        await expect(
          startGatewayServerCore(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "start",
          }),
        ).rejects.toThrow("fixture late-startup failure");
        // At the failure point the activation had already installed the attempt's loaded
        // registry — but the survivor must NOT have been retired with startup still pending.
        expect(reloaderFixture.activeRegistryAtReloaderStart).not.toBeNull();
        expect(reloaderFixture.activeRegistryAtReloaderStart).not.toBe(survivor);
        expect(reloaderFixture.survivorRetiredAtReloaderStart).toBe(false);
        // The close aborted the attempt back to the survivor: live, active, mode preserved,
        // and the attempt's loaded registry torn down.
        expect(getActivePluginRegistry()).toBe(survivor);
        expect(isPluginRegistryRetired(survivor)).toBe(false);
        expect(getActivePluginRegistryKey()).toBe("embedded-prior-late");
        expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
        expect(
          isPluginRegistryRetired(reloaderFixture.activeRegistryAtReloaderStart as PluginRegistry),
        ).toBe(true);
        // Retirement cleanup is fire-and-forget: give any scheduled cleanup a bounded window
        // to land, then prove the survivor's destructive disable cleanup never fired.
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        expect(lifecycleCleanupReasons).toEqual([]);
        expect(schedulerCleanupReasons).toEqual([]);
        expect(survivorSchedulerJobGeneration()).toBeDefined();
        // The failed start restored the survivor's captured config snapshot family.
        expect(getRuntimeConfigSnapshot()).toBe(priorSnapshot);
      } finally {
        resetReloaderFixture();
        clearSecretsRuntimeSnapshotState();
        resetPluginRuntimeStateForTest();
        clearRuntimeConfigSnapshot();
        await state.cleanup();
      }
    },
  );

  // Success-path guard: deferring the survivor's retirement to startup-success finalize must
  // not lose the retirement itself. A fully successful second start still retires the
  // displaced survivor exactly once — at finalize, observably NOT yet at the loader's
  // activation (the config-reloader probe runs between the two) and not a second time from
  // the completed replacement's own close — and ends with the loaded registry installed.
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
      reloaderFixture.survivor = survivor;
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
        // Retirement ordering: at config-reloader registration — after the loader's
        // activation, before startup returned — the survivor was still recoverable. It
        // retires at finalize, when startGatewayServerCore resolves, never at activation.
        expect(reloaderFixture.survivorRetiredAtReloaderStart).toBe(false);
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
          resetReloaderFixture();
          resetPluginRuntimeStateForTest();
          clearRuntimeConfigSnapshot();
          await state.cleanup();
        }
      }
    },
  );
});
