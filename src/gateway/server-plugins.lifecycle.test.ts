/**
 * Tests gateway plugin lifecycle loading, startup, and shutdown behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { markGatewaySigusr1RestartHandled } from "../infra/restart.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { captureEnv } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  CHANNEL_BINDING_IDS,
  INSTANCE_BINDING_PROBE_KEY,
  INSTANCE_BINDING_PROBE_METHOD,
  installInstanceBindingProbeCoordinator,
  writeChannelBindingProbePlugin,
  writeInstanceBindingProbePlugin,
  type ChannelBindingMonitor,
  type ChannelBindingProof,
  type InstanceBindingProbeCoordinator,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let restoreChannelRuntimeLoader: (() => void) | undefined;

async function requireBoundRuntime(
  runtimes: readonly PluginRuntime[],
  label: string,
): Promise<{ runtime: PluginRuntime }> {
  for (const runtime of runtimes) {
    if (await runtime.gateway.isAvailable()) {
      // Plugin runtimes are proxies. Keep the async result non-thenable so
      // Promise assimilation does not materialize the broad runtime graph.
      return { runtime };
    }
  }
  throw new Error(`${label} Gateway did not register an instance-bound plugin runtime`);
}

function requestInstanceBindingProbe(runtime: PluginRuntime) {
  return runtime.gateway.request<InstanceBindingProbeResult>(
    INSTANCE_BINDING_PROBE_METHOD,
    {},
    { scopes: ["operator.read"] },
  );
}

async function prepareInstanceBindingTest(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
  channels?: boolean;
  channelIds?: readonly string[];
}) {
  const configIo = await import("../config/io.js");
  const actualIo = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  // These RPCs await the writer's runtime receipt, which the shared IO mock does not publish.
  const configWriter = vi
    .spyOn(configIo, "writeConfigFile")
    .mockImplementation(actualIo.writeConfigFile);
  onTestFinished(() => configWriter.mockRestore());
  const coordinator = installInstanceBindingProbeCoordinator(options);
  const bundledRoot = tempDirs.make("openclaw-instance-binding-");
  await writeInstanceBindingProbePlugin(bundledRoot);
  if (options?.channels) {
    await writeChannelBindingProbePlugin(bundledRoot, options.channelIds);
  }
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
  }
  const config = {
    plugins: {
      enabled: true,
      allow: [
        "instance-binding-probe",
        ...(options?.channels ? ["instance-binding-channels"] : []),
      ],
      entries: {
        "instance-binding-probe": { enabled: true },
        ...(options?.channels ? { "instance-binding-channels": { enabled: true } } : {}),
      },
    },
  };
  const { loadPluginLookUpTable } = await import("../plugins/plugin-lookup-table.js");
  expect(loadPluginLookUpTable({ config, env: process.env }).startup.pluginIds).toContain(
    "instance-binding-probe",
  );
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
  if (coordinator.channelProof) {
    // Keep the real host factory in Vitest's module graph; fixture plugins still
    // load normally, with their original registry and instance runtime options.
    const [loaderModule, sdkAlias, fullRuntime] = await Promise.all([
      import("../plugins/loader-module-runtime.js"),
      import("../plugins/sdk-alias.js"),
      import("../plugins/runtime/index.js"),
    ]);
    const observation = {
      phase: "runtime-module-loader",
      resolvedTargets: [] as string[],
      factoryCalls: 0,
    };
    coordinator.channelProof.observations.push(observation);
    const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
    const createLoader = loaderModule.createPluginModuleLoader;
    const loaderSpy = vi
      .spyOn(loaderModule, "createPluginModuleLoader")
      .mockImplementation((loaderOptions) => {
        const load = createLoader(loaderOptions);
        return (modulePath) => {
          if (modulePath === resolveRuntime.mock.results.at(-1)?.value?.resolvedPath) {
            observation.resolvedTargets.push(modulePath);
            return {
              createPluginRuntime: (
                ...args: Parameters<typeof fullRuntime.createPluginRuntime>
              ) => {
                observation.factoryCalls += 1;
                return fullRuntime.createPluginRuntime(...args);
              },
            };
          }
          return load(modulePath);
        };
      });
    restoreChannelRuntimeLoader = () => {
      loaderSpy.mockRestore();
      resolveRuntime.mockRestore();
    };
  }
  return { coordinator, bundledRoot };
}

async function patchInstanceBindingTestConfig(
  socket: Awaited<ReturnType<typeof connectWebchatClient>>,
) {
  const current = await rpcReq<{ hash?: string }>(socket, "config.get", {});
  expect(current.ok).toBe(true);
  expect(current.payload?.hash).toBeTypeOf("string");
  return await rpcReq(socket, "config.patch", {
    raw: JSON.stringify({
      plugins: {
        entries: {
          "instance-binding-probe": { subagent: { allowModelOverride: true } },
        },
      },
    }),
    baseHash: current.payload?.hash,
  });
}

describe("gateway plugin instance bindings", () => {
  const started: Array<Awaited<ReturnType<typeof startTestGatewayServer>>> = [];
  const sockets: Array<Awaited<ReturnType<typeof connectWebchatClient>>> = [];
  const finishServiceStops: Array<() => void> = [];

  let channelProof: ChannelBindingProof | undefined;
  let channelCleanup: InstanceBindingProbeCoordinator["channelCleanup"];
  let channelEnv: ReturnType<typeof captureEnv> | undefined;
  let skippedBefore: { channels?: string; providers?: string } | undefined;

  afterEach(async () => {
    // Synthetic recovery emits no signal for a run loop to consume. Reopen admission
    // before teardown joins background work that may be waiting behind that fence.
    markGatewaySigusr1RestartHandled();
    // The replacement deadline has already been observed. Let the original
    // synthetic stop finish before final close releases its retained state.
    for (const finish of finishServiceStops.splice(0)) {
      finish();
    }
    const closingSockets = sockets.splice(0);
    const socketClosures = closingSockets.map((socket) =>
      socket.readyState === socket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
          }),
    );
    let serversClosed = false;
    try {
      for (const socket of closingSockets) {
        socket.close();
      }
      for (const server of started.splice(0).toReversed()) {
        await server.close({ reason: "instance binding cleanup" });
      }
      serversClosed = true;
      await Promise.all(socketClosures);
      if (channelCleanup) {
        // Only failure cleanup may release a monitor omitted by real close. Both
        // Gateways are fenced first; immutable close observations remain the verdict.
        const entries = [...channelCleanup];
        const stranded = entries.filter(([monitor]) => !monitor.stopped);
        channelProof?.observations.push({
          phase: "close-failure-cleanup",
          released: stranded.map(([monitor]) => ({
            channelId: monitor.channelId,
            runtimeId: monitor.runtimeId,
          })),
        });
        for (const [, cleanup] of stranded) {
          cleanup.release();
        }
        await Promise.all(entries.map(([, { finished }]) => finished));
        await expect
          .poll(() => entries.every(([{ abortSignal }]) => abortSignal.aborted), {
            timeout: 30_000,
          })
          .toBe(true);
        channelProof?.observations.push({ phase: "close-cleanup-monitors-joined" });
      }
    } finally {
      restoreChannelRuntimeLoader?.();
      restoreChannelRuntimeLoader = undefined;
      channelEnv?.restore();
      channelEnv = undefined;
      channelCleanup = undefined;
      delete (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY];
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      if (channelProof) {
        const proof = channelProof;
        channelProof = undefined;
        const cleanup = {
          serversClosed,
          socketsClosed: closingSockets.every((socket) => socket.readyState === socket.CLOSED),
          monitorsStopped: proof.monitors.every(
            (monitor) => monitor.stopped && monitor.abortSignal.aborted,
          ),
          skipEnvRestored:
            process.env.OPENCLAW_SKIP_CHANNELS === skippedBefore?.channels &&
            process.env.OPENCLAW_SKIP_PROVIDERS === skippedBefore?.providers,
        };
        proof.events.push({ event: "cleanup" });
        console.info(
          "PROOF_126547_LEDGER:" +
            JSON.stringify({
              ...proof,
              monitors: proof.monitors.map(({ channelId, runtimeId, stopped, abortSignal }) => ({
                channelId,
                runtimeId,
                stopped,
                aborted: abortSignal.aborted,
              })),
              cleanup,
            }),
        );
        expect(cleanup).toEqual({
          serversClosed: true,
          socketsClosed: true,
          monitorsStopped: true,
          skipEnvRestored: true,
        });
      }
      skippedBefore = undefined;
    }
  });

  it(
    "keeps unscoped plugin work bound to each real Gateway across reverse shutdown",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();

      const first = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(first);
      await first.startupSettled;
      const sharedMetadata = getGatewayPluginMetadataSnapshot();
      expect(sharedMetadata).toBeDefined();

      await expect(
        startTestGatewayServer(await getFreePort(), {
          bind: "loopback",
          host: "0.0.0.0",
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway bind=loopback resolved to non-loopback host");
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      const firstRegistrationCount = coordinator.runtimes.length;
      expect(firstRegistrationCount).toBeGreaterThan(0);
      const { runtime: firstRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, firstRegistrationCount),
        "first",
      );

      const second = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(second);
      await second.startupSettled;
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      expect(coordinator.runtimes.length).toBeGreaterThan(firstRegistrationCount);
      const { runtime: secondRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(firstRegistrationCount),
        "second",
      );

      const firstProbe = await requestInstanceBindingProbe(firstRuntime);
      const secondProbe = await requestInstanceBindingProbe(secondRuntime);
      expect(firstProbe.registryId).not.toBe(secondProbe.registryId);
      expect(firstProbe.sessionsId).not.toBe(secondProbe.sessionsId);
      expect(firstProbe.placementId).not.toBe(secondProbe.placementId);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await expect(
        secondRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });

      await second.close({ reason: "close last-started Gateway first" });
      started.pop();
      clearPluginMetadataLifecycleCaches();
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      await expect(requestInstanceBindingProbe(secondRuntime)).rejects.toThrow(
        "In-process gateway dispatch requires a gateway request scope or instance binding",
      );
      await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await first.close({ reason: "close final Gateway metadata owner" });
      started.pop();
      expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
    },
  );

  it(
    "closes only its own channels while another real Gateway owns colliding channel IDs",
    { timeout: 600_000 },
    async () => {
      const firstIds = ["binding-a-only", "binding-shared"];
      const secondIds = ["binding-b-only", "binding-shared"];
      const { coordinator } = await prepareInstanceBindingTest({
        channels: true,
        channelIds: [...new Set([...firstIds, ...secondIds])],
      });
      const proof = coordinator.channelProof;
      if (!proof) {
        throw new Error("channel binding fixture was not installed");
      }
      channelProof = proof;
      channelCleanup = coordinator.channelCleanup = new Map();
      const stopHooks: NonNullable<InstanceBindingProbeCoordinator["channelStops"]> = [];
      coordinator.channelStops = stopHooks;
      skippedBefore = {
        channels: process.env.OPENCLAW_SKIP_CHANNELS,
        providers: process.env.OPENCLAW_SKIP_PROVIDERS,
      };
      channelEnv = captureEnv(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"]);
      delete process.env.OPENCLAW_SKIP_CHANNELS;
      delete process.env.OPENCLAW_SKIP_PROVIDERS;

      // Each activation registers its own plugin instances without changing shared config.
      coordinator.channelIds = firstIds;
      const first = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(first);
      await first.startupSettled;
      await expect.poll(() => proof.monitors.length, { timeout: 30_000 }).toBe(2);
      const firstMonitors = [...proof.monitors].toSorted((a, b) =>
        a.channelId.localeCompare(b.channelId),
      );
      expect(firstMonitors.map(({ channelId }) => channelId)).toEqual(firstIds);
      const firstRegistry = getActivePluginRegistry();
      expect(firstRegistry).toBeTruthy();
      const firstProbes = await Promise.all(
        firstMonitors.map(({ runtime }) => requestInstanceBindingProbe(runtime)),
      );
      expect(firstProbes[0]).toEqual(firstProbes[1]);

      coordinator.channelIds = secondIds;
      const second = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(second);
      await second.startupSettled;
      await expect.poll(() => proof.monitors.length, { timeout: 30_000 }).toBe(4);
      const secondMonitors = proof.monitors
        .filter((monitor) => !firstMonitors.includes(monitor))
        .toSorted((a, b) => a.channelId.localeCompare(b.channelId));
      expect(secondMonitors.map(({ channelId }) => channelId)).toEqual(secondIds);
      const secondRegistry = getActivePluginRegistry();
      expect(secondRegistry).toBeTruthy();
      expect(secondRegistry).not.toBe(firstRegistry);
      expect(new Set(firstMonitors.map(({ runtimeId }) => runtimeId)).size).toBe(1);
      expect(new Set(secondMonitors.map(({ runtimeId }) => runtimeId)).size).toBe(1);
      expect(new Set(proof.monitors.map(({ runtimeId }) => runtimeId)).size).toBe(2);
      expect(new Set(proof.monitors.map(({ abortSignal }) => abortSignal)).size).toBe(4);
      const secondProbes = await Promise.all(
        secondMonitors.map(({ runtime }) => requestInstanceBindingProbe(runtime)),
      );
      expect(secondProbes[0]).toEqual(secondProbes[1]);
      for (const secondProbe of secondProbes) {
        for (const firstProbe of firstProbes) {
          expect(secondProbe.registryId).not.toBe(firstProbe.registryId);
          expect(secondProbe.sessionsId).not.toBe(firstProbe.sessionsId);
          expect(secondProbe.placementId).not.toBe(firstProbe.placementId);
        }
      }
      expect(
        proof.monitors.every(({ stopped, abortSignal }) => !stopped && !abortSignal.aborted),
      ).toBe(true);
      expect(stopHooks).toEqual([]);
      await expect(
        Promise.all(firstMonitors.map(({ runtime }) => requestInstanceBindingProbe(runtime))),
      ).resolves.toEqual(firstProbes);
      proof.observations.push({ phase: "two-gateways-started", firstProbes, secondProbes });

      const snapshot = (monitors: readonly ChannelBindingMonitor[]) =>
        monitors.map((monitor) => ({
          channelId: monitor.channelId,
          runtimeId: monitor.runtimeId,
          stopped: monitor.stopped,
          aborted: monitor.abortSignal.aborted,
          stopHooks: stopHooks
            .filter(
              ({ channelId, runtimeId }) =>
                channelId === monitor.channelId && runtimeId === monitor.runtimeId,
            )
            .map(({ abortSignal }) => ({
              ownSignal: abortSignal === monitor.abortSignal,
              aborted: abortSignal.aborted,
            })),
        }));
      const expected = (monitors: readonly ChannelBindingMonitor[], stopped: boolean) =>
        monitors.map(({ channelId, runtimeId }) => ({
          channelId,
          runtimeId,
          stopped,
          aborted: stopped,
          stopHooks: stopped ? [{ ownSignal: true, aborted: true }] : [],
        }));

      proof.events.push({ event: "first-close-request" });
      await first.close({ reason: "close first Gateway while second remains active" });
      started.splice(started.indexOf(first), 1);
      const afterFirstClose = {
        first: snapshot(firstMonitors),
        second: snapshot(secondMonitors),
      };
      proof.observations.push({ phase: "first-close-completed", ...afterFirstClose });
      for (const { runtime } of firstMonitors) {
        await expect(requestInstanceBindingProbe(runtime)).rejects.toThrow(
          "In-process gateway dispatch requires a gateway request scope or instance binding",
        );
      }
      const survivingProbes = await Promise.all(
        secondMonitors.map(({ runtime }) => requestInstanceBindingProbe(runtime)),
      );
      expect(survivingProbes).toEqual(secondProbes);
      proof.observations.push({ phase: "second-gateway-still-bound", probes: survivingProbes });
      expect(
        afterFirstClose,
        "Gateway close must select and join its own channels without borrowing another registry",
      ).toEqual({ first: expected(firstMonitors, true), second: expected(secondMonitors, false) });

      proof.events.push({ event: "second-close-request" });
      await second.close({ reason: "close remaining channel Gateway" });
      started.splice(started.indexOf(second), 1);
      const afterBothClose = snapshot([...firstMonitors, ...secondMonitors]);
      proof.observations.push({ phase: "both-closes-completed", channels: afterBothClose });
      expect(afterBothClose).toEqual(expected([...firstMonitors, ...secondMonitors], true));
      expect(proof.monitors).toHaveLength(4);
      for (const { runtime } of secondMonitors) {
        await expect(requestInstanceBindingProbe(runtime)).rejects.toThrow(
          "In-process gateway dispatch requires a gateway request scope or instance binding",
        );
      }
    },
  );

  it(
    "keeps startup metadata through hot reload and discovers manifest changes after Gateway restart",
    { timeout: 600_000 },
    async () => {
      const { coordinator, bundledRoot } = await prepareInstanceBindingTest();

      const port = await getFreePort();
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;
      const startupMetadata = getGatewayPluginMetadataSnapshot();
      expect(startupMetadata?.byPluginId.get("instance-binding-probe")?.name).toBe(
        "Startup plugin",
      );
      const manifestPath = path.join(bundledRoot, "instance-binding-probe", "openclaw.plugin.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: "Changed plugin" }));
      const initialRegistrationCount = coordinator.runtimes.length;
      expect(initialRegistrationCount).toBeGreaterThan(0);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      const initialProbe = await requestInstanceBindingProbe(initialRuntime);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const reload = await patchInstanceBindingTestConfig(socket);
      expect(reload.ok, reload.error?.message).toBe(true);
      await expect
        .poll(() => coordinator.runtimes.length, { timeout: 300_000 })
        .toBeGreaterThan(initialRegistrationCount);
      const { runtime: reloadedRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(initialRegistrationCount),
        "hot-reloaded",
      );
      const reloadedProbe = await requestInstanceBindingProbe(reloadedRuntime);

      expect(reloadedProbe.registryId).not.toBe(initialProbe.registryId);
      expect(reloadedProbe.sessionsId).toBe(initialProbe.sessionsId);
      expect(reloadedProbe.placementId).toBe(initialProbe.placementId);
      expect(getGatewayPluginMetadataSnapshot()).toBe(startupMetadata);
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Startup plugin");
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      await expect(requestInstanceBindingProbe(initialRuntime)).rejects.toThrow(
        "In-process gateway dispatch requires a gateway request scope or instance binding",
      );
      await expect(
        reloadedRuntime.subagent.getSessionMessages({
          sessionKey: "agent:main:main",
          limit: 1,
        }),
      ).resolves.toEqual({ messages: [] });

      socket.close();
      sockets.splice(sockets.indexOf(socket), 1);
      await server.close({ reason: "plugin metadata restart" });
      started.splice(started.indexOf(server), 1);
      const restarted = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(restarted);
      await restarted.startupSettled;
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Changed plugin");
    },
  );

  it(
    "restarts every channel holding a retired runtime after unrelated plugin config reload",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest({ channels: true });
      const proof = coordinator.channelProof;
      if (!proof) {
        throw new Error("channel binding fixture was not installed");
      }
      channelProof = proof;
      skippedBefore = {
        channels: process.env.OPENCLAW_SKIP_CHANNELS,
        providers: process.env.OPENCLAW_SKIP_PROVIDERS,
      };
      channelEnv = captureEnv(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"]);
      delete process.env.OPENCLAW_SKIP_CHANNELS;
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
      const port = await getFreePort();
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;
      await expect.poll(() => proof.monitors.length, { timeout: 30_000 }).toBe(2);
      const initialMonitors = [...proof.monitors];
      expect(initialMonitors.map((monitor) => monitor.channelId).toSorted()).toEqual([
        ...CHANNEL_BINDING_IDS,
      ]);
      const initialProbes = await Promise.all(
        initialMonitors.map((monitor) => requestInstanceBindingProbe(monitor.runtime)),
      );
      expect(initialProbes[0]).toEqual(initialProbes[1]);
      for (const probe of initialProbes) {
        expect(probe.reloadSettled).toBe(true);
      }
      proof.observations.push({ phase: "initial", probes: initialProbes });
      proof.events.push({ event: "initial-requests-succeeded" });
      const registrationsBeforeReload = coordinator.runtimes.length;
      const reloadEventIndex = proof.events.length;
      proof.events.push({ event: "reload-request" });
      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const reload = await patchInstanceBindingTestConfig(socket);
      expect(reload.ok, reload.error?.message).toBe(true);
      await expect
        .poll(() => coordinator.runtimes.length, { timeout: 300_000 })
        .toBeGreaterThan(registrationsBeforeReload);
      const { runtime: freshRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(registrationsBeforeReload),
        "reloaded",
      );
      await expect
        .poll(async () => (await requestInstanceBindingProbe(freshRuntime)).reloadSettled, {
          timeout: 30_000,
        })
        .toBe(true);
      const freshProbe = await requestInstanceBindingProbe(freshRuntime);
      for (const initialProbe of initialProbes) {
        expect(freshProbe.registryId).not.toBe(initialProbe.registryId);
        expect(freshProbe.sessionsId).toBe(initialProbe.sessionsId);
        expect(freshProbe.placementId).toBe(initialProbe.placementId);
      }
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      proof.observations.push({ phase: "replacement", probe: freshProbe });
      proof.events.push({ event: "reload-settled" });
      for (const monitor of initialMonitors) {
        await expect(requestInstanceBindingProbe(monitor.runtime)).rejects.toThrow(
          "In-process gateway dispatch requires a gateway request scope or instance binding",
        );
        proof.observations.push({
          phase: "retired-binding-rejected",
          channelId: monitor.channelId,
          runtimeId: monitor.runtimeId,
        });
      }
      const predecessorsStopped = initialMonitors.every(
        (monitor) => monitor.stopped && monitor.abortSignal.aborted,
      );
      proof.observations.push({ phase: "successor-handoff", predecessorsStopped });
      // Starts hand off before their setImmediate callback; a retired live predecessor is
      // already a failure, while a completed predecessor permits waiting for its successor.
      if (predecessorsStopped) {
        await expect
          .poll(
            () =>
              proof.monitors
                .filter((monitor) => !monitor.stopped)
                .map((monitor) => monitor.channelId)
                .toSorted(),
            { timeout: 30_000 },
          )
          .toEqual([...CHANNEL_BINDING_IDS]);
      }
      const observations = await Promise.all(
        initialMonitors.map(async (initial) => {
          const active = proof.monitors.filter(
            (monitor) => monitor.channelId === initial.channelId && !monitor.stopped,
          );
          const monitor = active[0];
          const response = monitor
            ? await requestInstanceBindingProbe(monitor.runtime).then(
                (value) => ({ ok: true, registryId: value.registryId }),
                (error: unknown) => ({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
            : { ok: false, error: "no active channel monitor" };
          const events = proof.events.slice(reloadEventIndex);
          const stoppedAt = events.findIndex(
            (event) =>
              event.event === "stopped" &&
              event.channelId === initial.channelId &&
              event.runtimeId === initial.runtimeId,
          );
          const registrationStartedAt = events.findIndex((event) => event.event === "register");
          const registeredAt = events.findIndex(
            (event) =>
              event.event === "register" &&
              event.channelId === initial.channelId &&
              event.runtimeId === monitor?.runtimeId,
          );
          const startedAt = events.findIndex(
            (event) =>
              event.event === "start" &&
              event.channelId === initial.channelId &&
              event.runtimeId === monitor?.runtimeId,
          );
          return {
            channelId: initial.channelId,
            activeCount: active.length,
            oldStopped: initial.stopped && initial.abortSignal.aborted,
            freshRuntime: monitor !== undefined && monitor.runtime !== initial.runtime,
            stoppedBeforeRegistration: stoppedAt >= 0 && registrationStartedAt > stoppedAt,
            startedFromNewRegistration: registeredAt >= 0 && startedAt > registeredAt,
            response,
          };
        }),
      );
      proof.observations.push({ phase: "settled-channels", channels: observations });
      proof.events.push({ event: "channels-observed" });
      expect(
        observations,
        "settled plugin replacement must renew every retained channel runtime",
      ).toEqual(
        initialMonitors.map(({ channelId }) => ({
          channelId,
          activeCount: 1,
          oldStopped: true,
          freshRuntime: true,
          stoppedBeforeRegistration: true,
          startedFromNewRegistration: true,
          response: { ok: true, registryId: freshProbe.registryId },
        })),
      );
    },
  );

  it.each(["rejection", "timeout"] as const)(
    "retains the previous registry when real plugin replacement cleanup fails by %s",
    { timeout: 600_000 },
    async (serviceStopFailure) => {
      const { coordinator } = await prepareInstanceBindingTest({ serviceStopFailure });
      finishServiceStops.push(coordinator.serviceStopCompletion.resolve);
      const hotReloadRecovery = vi.fn(() => {
        // No run loop consumes this synthetic emission, so release its signal-admission lease.
        markGatewaySigusr1RestartHandled();
        return { status: "emitted" as const };
      });
      const port = await getFreePort();
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;

      const initialRegistry = getActivePluginRegistry();
      const initialRuntimeConfig = getActiveSecretsRuntimeConfigSnapshot()?.config;
      const initialRegistrationCount = coordinator.runtimes.length;
      const initialHandler = initialRegistry?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD];
      expect(initialRegistry).toBeDefined();
      expect(initialRuntimeConfig).toBeDefined();
      expect(initialHandler).toBeTypeOf("function");
      expect(coordinator.serviceStarts).toBe(1);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const reload = await patchInstanceBindingTestConfig(socket);
      expect(reload).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining("not applied to the active Gateway (failed)"),
        },
      });

      await expect.poll(() => hotReloadRecovery.mock.calls.length, { timeout: 30_000 }).toBe(1);
      expect(coordinator.serviceStops).toBe(1);
      expect(coordinator.serviceStarts).toBe(1);
      expect(coordinator.runtimes).toHaveLength(initialRegistrationCount);
      expect(getActiveSecretsRuntimeConfigSnapshot()?.config).toBe(initialRuntimeConfig);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      expect(getActivePluginRegistry()?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD]).toBe(
        initialHandler,
      );
    },
  );
});

// A real plugin registry replacement must own accounts before their first route exists.
describe("Gateway plugin replacement channel ownership", () => {
  const channelId = "reload-webhook";
  const channelKey = Symbol.for("openclaw.test.reloadWebhookChannel");
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
  let releasePending = createDeferredCore();

  afterEach(async () => {
    releasePending.resolve();
    socket?.close();
    await server?.close({ reason: "webhook reload cleanup" });
    delete (globalThis as Record<PropertyKey, unknown>)[channelKey];
    delete (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY];
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  });

  it.each([
    {
      name: "hands off live and pending webhook accounts while preserving a manual stop",
      teardownFails: false,
    },
    {
      name: "keeps channels fenced while recovery retries failed service teardown",
      teardownFails: true,
    },
  ])("$name", { timeout: 120_000 }, async ({ teardownFails }) => {
    releasePending = createDeferredCore();
    const starts = new Map<string, number>();
    const channel: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: channelId,
        config: {
          listAccountIds: () => ["active", "pending", "parked"],
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
      }),
      gateway: {
        async startAccount({ accountId, abortSignal, setStatus }) {
          const generation = (starts.get(accountId) ?? 0) + 1;
          starts.set(accountId, generation);
          const aborted = new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (accountId === "pending" && generation === 1) {
            await Promise.race([releasePending.promise, aborted]);
          }
          if (abortSignal.aborted) {
            return;
          }
          const unregister = registerPluginHttpRoute({
            path: `/reload-webhook/${accountId}`,
            auth: "plugin",
            pluginId: channelId,
            accountId,
            throwOnFailure: true,
            handler: (_req, res) => {
              const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
              res.setHeader(
                "x-webhook-registry",
                registry === getActivePluginRegistry() ? "current" : "stale",
              );
              res.end(`${accountId}:${generation}`);
            },
          });
          setStatus({ accountId, running: true, connected: true, lifecycle: "ready" });
          try {
            await aborted;
          } finally {
            unregister();
          }
        },
      },
    };
    (globalThis as Record<PropertyKey, unknown>)[channelKey] = channel;
    const coordinator = installInstanceBindingProbeCoordinator(
      teardownFails ? { serviceStopFailure: "rejection" } : undefined,
    );
    const bundledRoot = tempDirs.make("openclaw-instance-binding-");
    await writeInstanceBindingProbePlugin(bundledRoot);
    const pluginDir = path.join(bundledRoot, channelId);
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: channelId,
        type: "commonjs",
        main: "index.js",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: channelId,
        activation: { onStartup: true },
        channels: [channelId],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      `module.exports = {
      id: "reload-webhook",
      register(api) { api.registerChannel({ plugin: globalThis[Symbol.for("openclaw.test.reloadWebhookChannel")] }); }
    };`,
    );
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Gateway fixture did not set config path");
    }
    const config = loadGatewayTestConfig();
    config.plugins = {
      ...config.plugins,
      enabled: true,
      allow: ["instance-binding-probe", channelId],
      entries: {
        ...config.plugins?.entries,
        "instance-binding-probe": { enabled: true },
        [channelId]: { enabled: true },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const port = await getFreePort();
    const hotReloadRecovery = vi.fn(() => ({
      status: teardownFails ? ("failed" as const) : ("emitted" as const),
    }));
    // Use the real runtime in Vitest's graph; native loading evaluates its mocked graph again.
    const runtimeModule = await import("../plugins/runtime/index.js");
    const loaderModule = await import("../plugins/loader-module-runtime.js");
    const createLazyRuntime = loaderModule.createLazyPluginRuntime;
    const runtimeLoader = vi
      .spyOn(loaderModule, "createLazyPluginRuntime")
      .mockImplementation((params) =>
        createLazyRuntime({ ...params, loadPluginModule: () => runtimeModule }),
      );
    onTestFinished(() => runtimeLoader.mockRestore());
    server = await startTestGatewayServer(port, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      sidecarStartup: "start",
      hotReloadRecovery,
    });
    await server.startupSettled;
    const probe = async (accountId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/reload-webhook/${accountId}`, {
        method: "POST",
      });
      return {
        status: response.status,
        body: await response.text(),
        registry: response.headers.get("x-webhook-registry"),
      };
    };
    await expect
      .poll(() => [...starts.keys()].toSorted(), { timeout: 30_000 })
      .toEqual(["active", "parked", "pending"]);
    expect(await probe("active")).toEqual({
      status: 200,
      body: "active:1",
      registry: "current",
    });
    expect((await probe("pending")).status).toBe(404);
    socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
    const stopped = await rpcReq(socket, "channels.stop", {
      channel: channelId,
      accountId: "parked",
    });
    expect(stopped.ok, stopped.error?.message).toBe(true);
    expect((await probe("parked")).status).toBe(404);

    const initialRegistry = getActivePluginRegistry();
    config.plugins.entries!["instance-binding-probe"] = {
      enabled: true,
      subagent: { allowModelOverride: true },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    if (teardownFails) {
      await expect
        .poll(() => hotReloadRecovery.mock.calls.length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(coordinator.serviceStops).toBe(1);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      expect(starts.get("active")).toBe(1);
      const restarted = await rpcReq(socket, "channels.start", {
        channel: channelId,
        accountId: "active",
      });
      expect(restarted.ok).toBe(false);
      expect(restarted.error?.message).toContain("plugins are reloading; retry");
      expect(starts.get("active")).toBe(1);
      expect((await probe("active")).status).toBe(404);
      return;
    }
    await expect
      .poll(() => getActivePluginRegistry() !== initialRegistry, { timeout: 180_000 })
      .toBe(true);
    await expect
      .poll(() => probe("active"), { timeout: 30_000 })
      .toEqual({ status: 200, body: "active:2", registry: "current" });
    await expect
      .poll(() => probe("pending"), { timeout: 30_000 })
      .toEqual({ status: 200, body: "pending:2", registry: "current" });
    releasePending.resolve();
    expect(await probe("pending")).toEqual({
      status: 200,
      body: "pending:2",
      registry: "current",
    });
    expect((await probe("parked")).status).toBe(404);
    expect(starts.get("parked")).toBe(1);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  });
});
