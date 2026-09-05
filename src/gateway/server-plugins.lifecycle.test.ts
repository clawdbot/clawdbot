/**
 * Tests gateway plugin lifecycle loading, startup, and shutdown behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { markGatewaySigusr1RestartHandled } from "../infra/restart.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { captureEnv } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  CHANNEL_BINDING_IDS,
  clearInstanceBindingProbeCoordinators,
  INSTANCE_BINDING_PROBE_METHOD,
  installInstanceBindingProbeCoordinator,
  writeChannelBindingProbePlugin,
  writeInstanceBindingProbePlugin,
  withPluginServiceStopDeadline,
  type ChannelBindingMonitor,
  type ChannelBindingProof,
  type InstanceBindingProbeCoordinator,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  requireBoundRuntime,
  requestInstanceBindingProbe,
} from "./server-plugins.lifecycle.test-support.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// Remove the shared helper's loader mock after its import so these fixtures register real plugins.
vi.doUnmock("../plugins/loader.js");

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let restoreChannelRuntimeLoader: (() => void) | undefined;

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
  await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName);
  if (options?.channels) {
    await writeChannelBindingProbePlugin(bundledRoot, coordinator.channelName, options.channelIds);
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

installInstanceBindingConfigIo();

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
      clearInstanceBindingProbeCoordinators();
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
      expect(
        firstRegistrationCount,
        JSON.stringify(getActivePluginRegistry()?.diagnostics),
      ).toBeGreaterThan(0);
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
        'Plugin "instance-binding-probe" runtime is no longer active.',
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
          'Plugin "instance-binding-channels" runtime is no longer active.',
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
          'Plugin "instance-binding-channels" runtime is no longer active.',
        );
      }
    },
  );

  it(
    "publishes startup plugins after another Gateway starts during its loader handoff",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();
      const firstPort = await getFreePort();
      const firstStarted = createDeferred();
      const secondStarted = createDeferred();
      const startupSignals = new Map([[firstPort, firstStarted]]);
      const lifecycleEvents: Array<
        Parameters<NonNullable<InstanceBindingProbeCoordinator["onLifecycleEvent"]>>[0]
      > = [];
      coordinator.onLifecycleEvent = (event) => {
        lifecycleEvents.push(event);
        if (event.kind === "start") {
          startupSignals.get(event.port)?.resolve();
        }
      };
      const startupTrace = await import("./server-startup-trace.js");
      const createTrace = startupTrace.createGatewayStartupTrace;
      const pluginLoadFinished = createDeferred();
      const releaseAttachment = createDeferred();
      const traceSpy = vi
        .spyOn(startupTrace, "createGatewayStartupTrace")
        .mockImplementationOnce((...args) => {
          const trace = createTrace(...args);
          const measure = trace.measure.bind(trace);
          trace.measure = async (name, run, options) => {
            const result = await measure(name, run, options);
            if (name === "plugins.runtime-post-bind") {
              pluginLoadFinished.resolve();
              await releaseAttachment.promise;
            }
            return result;
          };
          return trace;
        });
      let firstStarting: ReturnType<typeof startTestGatewayServer> | undefined;
      try {
        firstStarting = startTestGatewayServer(firstPort, {
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "start",
        }).then((server) => {
          started.push(server);
          return server;
        });
        await Promise.race([
          pluginLoadFinished.promise,
          firstStarting.then(() => {
            throw new Error("First Gateway passed its plugin attachment barrier");
          }),
        ]);
        const firstRegistrationCount = coordinator.runtimes.length;
        expect(firstRegistrationCount).toBeGreaterThan(0);

        const secondPort = await getFreePort();
        startupSignals.set(secondPort, secondStarted);
        const second = await startTestGatewayServer(secondPort, {
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "start",
        });
        started.push(second);
        await second.startupSettled;
        await secondStarted.promise;
        expect(coordinator.runtimes.length).toBeGreaterThan(firstRegistrationCount);

        releaseAttachment.resolve();
        const first = await firstStarting;
        await first.startupSettled;
        await firstStarted.promise;
        const { runtime: firstRuntime } = await requireBoundRuntime(
          coordinator.runtimes.slice(0, firstRegistrationCount),
          "first concurrent startup",
        );
        const { runtime: secondRuntime } = await requireBoundRuntime(
          coordinator.runtimes.slice(firstRegistrationCount),
          "second concurrent startup",
        );
        const firstProbe = await requestInstanceBindingProbe(firstRuntime);
        const secondProbe = await requestInstanceBindingProbe(secondRuntime);
        expect(firstProbe.registryId).not.toBe(secondProbe.registryId);
        expect(firstProbe.sessionsId).not.toBe(secondProbe.sessionsId);
        expect(firstProbe.placementId).not.toBe(secondProbe.placementId);
        await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
        await expect(requestInstanceBindingProbe(secondRuntime)).resolves.toEqual(secondProbe);
        expect(lifecycleEvents).toEqual([
          { registryId: secondProbe.registryId, port: secondPort, kind: "start" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "start" },
        ]);

        // A publishes last; closing B must dispatch B's hooks while A remains the default.
        await Promise.all([
          second.close({ reason: "close earlier-published Gateway" }),
          second.close({ reason: "join earlier-published Gateway close" }),
        ]);
        started.splice(started.indexOf(second), 1);
        expect(lifecycleEvents).toEqual([
          { registryId: secondProbe.registryId, port: secondPort, kind: "start" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "start" },
          { registryId: secondProbe.registryId, port: secondPort, kind: "stop" },
        ]);
        await expect(requestInstanceBindingProbe(secondRuntime)).rejects.toThrow(
          'Plugin "instance-binding-probe" runtime is no longer active.',
        );
        await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
        await first.close({ reason: "close remaining concurrent Gateway" });
        started.splice(started.indexOf(first), 1);
        expect(lifecycleEvents).toEqual([
          { registryId: secondProbe.registryId, port: secondPort, kind: "start" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "start" },
          { registryId: secondProbe.registryId, port: secondPort, kind: "stop" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "stop" },
        ]);
      } finally {
        releaseAttachment.resolve();
        await Promise.allSettled([firstStarting]);
        traceSpy.mockRestore();
      }
    },
  );

  it(
    "discards a prepared startup candidate when Gateway close starts before publication",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();
      const kernelModule = await import("./server-kernel.js");
      const createKernel = kernelModule.createGatewayKernel;
      const prepared = createDeferred();
      const release = createDeferred();
      const published = vi.fn();
      const kernelSpy = vi
        .spyOn(kernelModule, "createGatewayKernel")
        .mockImplementationOnce(async (...args) => {
          const kernel = await createKernel(...args);
          const prepare = kernel.prepareAttachedPluginRuntime;
          return {
            ...kernel,
            prepareAttachedPluginRuntime: async (loaded) => {
              const attachment = await prepare(loaded);
              prepared.resolve();
              await release.promise;
              return {
                ...attachment,
                publish: () => {
                  published();
                  attachment.publish();
                },
              };
            },
          };
        });
      try {
        const server = await startTestGatewayServer(await getFreePort(), {
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        started.push(server);
        await prepared.promise;
        const closing = server.close({ reason: "close during startup preparation" });
        release.resolve();
        await Promise.all([closing, server.startupSettled]);
        expect(published).not.toHaveBeenCalled();
        for (const runtime of coordinator.runtimes) {
          expect(await runtime.gateway.isAvailable()).toBe(false);
        }
      } finally {
        release.resolve();
        kernelSpy.mockRestore();
      }
    },
  );

  it(
    "publishes manifest changes on hot reload while preserving Gateway instance bindings",
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
      expect(getGatewayPluginMetadataSnapshot()).toBe(startupMetadata);
      const initialRegistrationCount = coordinator.runtimes.length;
      expect(
        initialRegistrationCount,
        JSON.stringify(getActivePluginRegistry()?.diagnostics),
      ).toBeGreaterThan(0);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      const initialProbe = await requestInstanceBindingProbe(initialRuntime);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const reload = await patchInstanceBindingTestConfig(socket);
      expect(reload.ok, reload.error?.message).toBe(true);
      expect(reload.payload).toMatchObject({
        sentinel: { payload: { stats: { requiresRestart: false } } },
      });
      // Registration happens during staging; metadata changes only at publication.
      await expect
        .poll(() => getGatewayPluginMetadataSnapshot(), { timeout: 300_000 })
        .not.toBe(startupMetadata);
      expect(coordinator.runtimes.length).toBeGreaterThan(initialRegistrationCount);
      const { runtime: reloadedRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(initialRegistrationCount),
        "hot-reloaded",
      );
      const reloadedProbe = await requestInstanceBindingProbe(reloadedRuntime);

      expect(reloadedProbe.registryId).not.toBe(initialProbe.registryId);
      expect(reloadedProbe.sessionsId).toBe(initialProbe.sessionsId);
      expect(reloadedProbe.placementId).toBe(initialProbe.placementId);
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Changed plugin");
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      await expect(requestInstanceBindingProbe(initialRuntime)).rejects.toThrow(
        'Plugin "instance-binding-probe" runtime is no longer active.',
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
    "retains unchanged channel runtimes and renews them only when their plugin reloads",
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
      const { runtime: initialProbeRuntime } = await requireBoundRuntime(
        coordinator.runtimes,
        "initial probe owner",
      );
      const registrationsBeforeReload = coordinator.runtimes.length;
      let reloadEventIndex = proof.events.length;
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
      await expect(requestInstanceBindingProbe(initialProbeRuntime)).rejects.toThrow(
        'Plugin "instance-binding-probe" runtime is no longer active.',
      );
      expect(proof.monitors).toEqual(initialMonitors);
      for (const monitor of initialMonitors) {
        expect(monitor.stopped).toBe(false);
        expect(monitor.abortSignal.aborted).toBe(false);
        await expect(requestInstanceBindingProbe(monitor.runtime)).resolves.toEqual(freshProbe);
      }
      expect(
        proof.events
          .slice(reloadEventIndex)
          .filter((event) =>
            ["start", "stopped", "stop-aborted", "stop-unaborted"].includes(event.event),
          ),
      ).toEqual([]);
      proof.observations.push({ phase: "unchanged-channel-bindings-retained", probes: freshProbe });

      // Reload the channel owner itself to distinguish retained capabilities from stale ones.
      reloadEventIndex = proof.events.length;
      proof.events.push({ event: "channel-owner-reload-request" });
      const registryBeforeChannelReload = getActivePluginRegistry();
      const channelReload = await rpcReq(socket, "plugins.reload", {
        pluginId: "instance-binding-channels",
      });
      expect(channelReload.ok, channelReload.error?.message).toBe(true);
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).not.toBe(registryBeforeChannelReload);
      const currentProbe = await rpcReq<InstanceBindingProbeResult>(
        socket,
        INSTANCE_BINDING_PROBE_METHOD,
        {},
      );
      expect(currentProbe.ok, currentProbe.error?.message).toBe(true);
      const channelProbe = currentProbe.payload;
      if (!channelProbe) {
        throw new Error("channel publication did not return an authoritative probe");
      }
      expect(channelProbe).toEqual({
        // This fixture token identifies the retained probe registration, not the registry.
        registryId: freshProbe.registryId,
        sessionsId: freshProbe.sessionsId,
        placementId: freshProbe.placementId,
        reloadSettled: true,
      });
      await expect(requestInstanceBindingProbe(freshRuntime)).resolves.toEqual(channelProbe);
      proof.observations.push({ phase: "channel-owner-publication", probe: channelProbe });
      for (const monitor of initialMonitors) {
        await expect(requestInstanceBindingProbe(monitor.runtime)).rejects.toThrow(
          'Plugin "instance-binding-channels" runtime is no longer active.',
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
      expect(predecessorsStopped).toBe(true);
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
            stoppedBeforeSuccessorStart: stoppedAt >= 0 && startedAt > stoppedAt,
            startedFromNewRegistration: registeredAt >= 0 && startedAt > registeredAt,
            response,
          };
        }),
      );
      proof.observations.push({ phase: "settled-channels", channels: observations });
      proof.events.push({ event: "channels-observed" });
      expect(
        observations,
        "reloading the channel owner must retire its old runtimes before starting successors",
      ).toEqual(
        initialMonitors.map(({ channelId }) => ({
          channelId,
          activeCount: 1,
          oldStopped: true,
          freshRuntime: true,
          stoppedBeforeSuccessorStart: true,
          startedFromNewRegistration: true,
          response: { ok: true, registryId: channelProbe.registryId },
        })),
      );
    },
  );

  it.each(["rejection", "timeout"] as const)(
    "reports failed plugin cleanup by %s and fences its old instance while keeping the Gateway available",
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
      const initialMetadata = getGatewayPluginMetadataSnapshot();
      const initialRuntimeConfig = getActiveSecretsRuntimeConfigSnapshot()?.config;
      const initialRegistrationCount = coordinator.runtimes.length;
      const initialHandler = initialRegistry?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD];
      expect(initialRegistry).toBeDefined();
      expect(initialMetadata).toBeDefined();
      expect(initialRuntimeConfig).toBeDefined();
      expect(initialHandler, JSON.stringify(initialRegistry?.diagnostics)).toBeTypeOf("function");
      expect(coordinator.serviceStarts).toBe(1);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      await expect(requestInstanceBindingProbe(initialRuntime)).resolves.toMatchObject({
        registryId: expect.any(Number),
      });

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const currentConfig = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(currentConfig.ok).toBe(true);
      const reload = await withPluginServiceStopDeadline(coordinator, () =>
        rpcReq(socket, "plugins.reload", { pluginId: "instance-binding-probe" }),
      );
      expect(reload, reload.error?.message).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          details: { runtime: { phase: "drain", committed: false } },
        },
      });
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      expect(coordinator.serviceStops).toBe(1);
      expect(coordinator.serviceStarts).toBe(1);
      expect(coordinator.runtimes.length).toBeGreaterThan(initialRegistrationCount);
      expect(getGatewayPluginMetadataSnapshot()).toBe(initialMetadata);
      expect(getActiveSecretsRuntimeConfigSnapshot()?.config).toBe(initialRuntimeConfig);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      expect(getActivePluginRegistry()?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD]).toBe(
        initialHandler,
      );
      await expect(requestInstanceBindingProbe(initialRuntime)).rejects.toThrow(
        "was reloaded or disabled; use its current tools",
      );
      for (const candidate of coordinator.runtimes.slice(initialRegistrationCount)) {
        await expect(requestInstanceBindingProbe(candidate)).rejects.toThrow(
          'Plugin "instance-binding-probe" runtime is no longer active.',
        );
      }
      const afterFailure = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(afterFailure.ok).toBe(true);
      expect(afterFailure.payload?.hash).toBe(currentConfig.payload?.hash);
    },
  );
});
