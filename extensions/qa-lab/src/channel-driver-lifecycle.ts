import { createQaBusState } from "./bus-state.js";
import {
  createQaTransportAdapter,
  type QaTransportAdapterFactory,
  type QaTransportAdapterFactoryResult,
  type QaTransportDriver,
} from "./qa-transport-registry.js";

export type QaChannelDriverRuntime = QaTransportAdapterFactoryResult;

export type QaChannelDriverLifecycleState =
  | { status: "stopped" }
  | { runtime: QaChannelDriverRuntime; status: "running" };

export type QaChannelDriverLifecycle = {
  readonly state: QaChannelDriverLifecycleState;
  restart(): Promise<QaChannelDriverRuntime>;
  start(): Promise<QaChannelDriverRuntime>;
  stop(): Promise<void>;
};

export type QaChannelDriverLifecycleScenarioId =
  | "cold-start"
  | "idempotent-start"
  | "restart"
  | "stop"
  | "resume";

type QaChannelDriverLifecycleDeps = {
  createAdapter?: typeof createQaTransportAdapter;
  listAdapterFactories?: () =>
    | readonly QaTransportAdapterFactory[]
    | Promise<readonly QaTransportAdapterFactory[]>;
};

async function listAdapterFactories(): Promise<readonly QaTransportAdapterFactory[]> {
  const { listLiveTransportQaAdapterFactories } = await import("./live-transports/cli.js");
  return listLiveTransportQaAdapterFactories();
}

export function createQaChannelDriverLifecycle(
  params: {
    channelId: string;
    driver: QaTransportDriver;
    outputDir: string;
  },
  deps: QaChannelDriverLifecycleDeps = {},
): QaChannelDriverLifecycle {
  const createAdapter = deps.createAdapter ?? createQaTransportAdapter;
  const discoverAdapterFactories = deps.listAdapterFactories ?? listAdapterFactories;
  let state: QaChannelDriverLifecycleState = { status: "stopped" };

  const lifecycle: QaChannelDriverLifecycle = {
    get state() {
      return state;
    },
    async restart() {
      await lifecycle.stop();
      return await lifecycle.start();
    },
    async start() {
      if (state.status === "running") {
        return state.runtime;
      }
      const runtime = await createAdapter(
        {
          ...params,
          state: createQaBusState(),
        },
        await discoverAdapterFactories(),
      );
      state = { runtime, status: "running" };
      return runtime;
    },
    async stop() {
      if (state.status === "stopped") {
        return;
      }
      const runtime = state.runtime;
      await runtime.cleanupWithoutGateway();
      state = { status: "stopped" };
    },
  };

  return lifecycle;
}

export async function runQaChannelDriverLifecycleScenarios(params: {
  assertStopped(runtime: QaChannelDriverRuntime): Promise<void>;
  lifecycle: QaChannelDriverLifecycle;
  probe(runtime: QaChannelDriverRuntime): Promise<void>;
}): Promise<QaChannelDriverLifecycleScenarioId[]> {
  const results: QaChannelDriverLifecycleScenarioId[] = [];

  const coldStart = await params.lifecycle.start();
  await params.probe(coldStart);
  results.push("cold-start");

  const idempotentStart = await params.lifecycle.start();
  if (idempotentStart !== coldStart) {
    throw new Error("channel driver start replaced an already-running adapter");
  }
  await params.probe(idempotentStart);
  results.push("idempotent-start");

  const restarted = await params.lifecycle.restart();
  await params.assertStopped(idempotentStart);
  await params.probe(restarted);
  results.push("restart");

  await params.lifecycle.stop();
  await params.assertStopped(restarted);
  results.push("stop");

  const resumed = await params.lifecycle.start();
  await params.probe(resumed);
  results.push("resume");

  return results;
}
