// Synthetic plugin fixtures for Gateway instance and channel lifecycle tests.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";

export const INSTANCE_BINDING_PROBE_KEY = Symbol.for("openclaw.test.gatewayInstanceBindingProbe");
export const INSTANCE_BINDING_PROBE_METHOD = "instanceBinding.probe";

export type InstanceBindingProbeResult = {
  registryId: number;
  sessionsId: number;
  placementId: number;
  reloadSettled?: boolean;
};

export const CHANNEL_BINDING_IDS = ["binding-first", "binding-second"] as const;
export type ChannelBindingMonitor = {
  channelId: string;
  runtimeId: number;
  runtime: PluginRuntime;
  abortSignal: AbortSignal;
  stopped: boolean;
};
export type ChannelBindingProof = {
  events: Array<{ event: string; channelId?: string; runtimeId?: number }>;
  monitors: ChannelBindingMonitor[];
  observations: unknown[];
};

export type InstanceBindingProbeCoordinator = {
  identify: (value: object) => number;
  nextRegistryId: number;
  runtimes: PluginRuntime[];
  serviceStarts: number;
  serviceStops: number;
  serviceStopCompletion: ReturnType<typeof createDeferred<void>>;
  serviceStopFailure?: "rejection" | "timeout";
  channelProof?: ChannelBindingProof;
  channelIds?: readonly string[];
  channelStops?: Array<Pick<ChannelBindingMonitor, "channelId" | "runtimeId" | "abortSignal">>;
  channelCleanup?: Map<ChannelBindingMonitor, { release: () => void; finished: Promise<void> }>;
};

export function installInstanceBindingProbeCoordinator(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
  channels?: boolean;
}): InstanceBindingProbeCoordinator {
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const coordinator: InstanceBindingProbeCoordinator = {
    identify(value) {
      const existing = ids.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const id = nextId++;
      ids.set(value, id);
      return id;
    },
    nextRegistryId: 1,
    runtimes: [],
    serviceStarts: 0,
    serviceStops: 0,
    serviceStopCompletion: createDeferred(),
    ...(options?.channels ? { channelProof: { events: [], monitors: [], observations: [] } } : {}),
    ...(options?.serviceStopFailure ? { serviceStopFailure: options.serviceStopFailure } : {}),
  };
  (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY] = coordinator;
  return coordinator;
}

export async function writeInstanceBindingProbePlugin(bundledRoot: string): Promise<void> {
  const pluginDir = path.join(bundledRoot, "instance-binding-probe");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: "instance-binding-probe",
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: "instance-binding-probe",
      name: "Startup plugin",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: "instance-binding-probe",
  register(api) {
    const coordinator = globalThis[Symbol.for("openclaw.test.gatewayInstanceBindingProbe")];
    const registryId = coordinator.nextRegistryId++;
    coordinator.runtimes.push(api.runtime);
    if (coordinator.serviceStopFailure) {
      api.registerService({
        id: "instance-binding-service",
        start() {
          coordinator.serviceStarts += 1;
        },
        stop() {
          coordinator.serviceStops += 1;
          if (coordinator.serviceStopFailure === "rejection") {
            return Promise.reject(new Error("instance-binding service cleanup rejected"));
          }
          if (coordinator.serviceStopFailure === "timeout") {
            return coordinator.serviceStopCompletion.promise;
          }
        },
      });
    }
    api.registerGatewayMethod("${INSTANCE_BINDING_PROBE_METHOD}", ({ context, respond }) => {
      respond(true, {
        registryId,
        sessionsId: coordinator.identify(context.sessionCompanion),
        placementId: coordinator.identify(context.workerSessionPlacementService),
        ...(coordinator.channelProof ? { reloadSettled: context.isConfigReloadSettled() } : {}),
      });
    }, { scope: "operator.read" });
  },
};
`,
  );
}

export async function writeChannelBindingProbePlugin(
  bundledRoot: string,
  channelIds: readonly string[] = CHANNEL_BINDING_IDS,
): Promise<void> {
  const pluginDir = path.join(bundledRoot, "instance-binding-channels");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "instance-binding-channels",
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "instance-binding-channels",
      channels: channelIds,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: "instance-binding-channels",
  register(api) {
    const coordinator = globalThis[Symbol.for("openclaw.test.gatewayInstanceBindingProbe")];
    const proof = coordinator.channelProof;
    const runtimeId = coordinator.identify(api.runtime);
    for (const channelId of coordinator.channelIds ?? ${JSON.stringify(CHANNEL_BINDING_IDS)}) {
      proof.events.push({ event: "register", channelId, runtimeId });
      api.registerChannel({
        id: channelId,
        meta: { id: channelId, label: channelId, selectionLabel: channelId,
          docsPath: "/channels", blurb: "Synthetic lifecycle channel" },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ accountId: "default", enabled: true }),
          isConfigured: () => true,
        },
        gateway: {
          startAccount(ctx) {
            const monitor = { channelId, runtimeId, runtime: api.runtime,
              abortSignal: ctx.abortSignal, stopped: false };
            proof.monitors.push(monitor);
            proof.events.push({ event: "start", channelId, runtimeId });
            ctx.setStatus({ accountId: ctx.accountId, connected: true, lifecycle: "ready" });
            let release;
            const lifetime = new Promise((resolve) => {
              release = () => {
                ctx.abortSignal.removeEventListener("abort", release);
                resolve();
              };
              if (ctx.abortSignal.aborted) { release(); return; }
              ctx.abortSignal.addEventListener("abort", release, { once: true });
            });
            const finished = lifetime.finally(() => {
              monitor.stopped = true;
              proof.events.push({ event: "stopped", channelId, runtimeId });
            });
            coordinator.channelCleanup?.set(monitor, { release, finished });
            return finished;
          },
          async stopAccount(ctx) {
            coordinator.channelStops?.push({ channelId, runtimeId, abortSignal: ctx.abortSignal });
            proof.events.push({ event: ctx.abortSignal.aborted ? "stop-aborted" : "stop-unaborted",
              channelId, runtimeId });
          },
        },
      });
    }
  },
};
`,
  );
}
