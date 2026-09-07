import { isDeepStrictEqual } from "node:util";
import {
  NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
} from "../../infra/node-commands.js";
import type { WorkerDesktopApp, WorkerDesktopEndpoint } from "../../plugins/types.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import type { DesktopObserveRequester } from "../desktop/observe-requester.js";
import {
  DesktopSessionStaleOwnerError,
  type DesktopSessionRegistry,
} from "../desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import type { WorkerDesktopObserveResult } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const APP_LAUNCH_TIMEOUT_MS = 30_000;

type NodeDesktopBinding = {
  environmentId: string;
  leaseId: string;
  nodeDeviceId: string;
  ownerEpoch: number;
  desktop: WorkerDesktopEndpoint;
};

type NodeDesktopRuntime = {
  transport: NodeWorkerSupervisorTransport;
  streamBroker: NodeDesktopStreamBroker;
};

type ActiveNodeDesktopStream = {
  binding: NodeDesktopBinding;
  controller: AbortController;
  ticket?: ReturnType<NodeDesktopStreamBroker["mint"]>;
  invocation?: ReturnType<NodeWorkerSupervisorTransport["invoke"]>;
  reservation?: ReturnType<DesktopSessionRegistry["reserveObserver"]>;
  reservationTransferred: boolean;
  stream?: import("node:stream").Duplex;
  unclaimedTimer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
};

type ActiveNodeDesktopLaunch = {
  binding: NodeDesktopBinding;
  app: WorkerDesktopApp;
  controller: AbortController;
  operation: Promise<void>;
};

type WorkerNodeDesktopCarrierOptions = {
  store: Pick<WorkerEnvironmentStore, "get">;
  desktopRegistry: DesktopSessionRegistry;
};

function snapshotNodeDesktopBinding(record: WorkerEnvironmentRecord): NodeDesktopBinding {
  if (
    (record.state !== "ready" && record.state !== "idle" && record.state !== "attached") ||
    record.destroyRequestedAtMs !== null ||
    !record.leaseId ||
    !record.nodeDeviceId ||
    record.sshEndpoint !== null ||
    !record.desktop
  ) {
    throw new Error("Worker environment node desktop owner is not active");
  }
  return {
    environmentId: record.environmentId,
    leaseId: record.leaseId,
    nodeDeviceId: record.nodeDeviceId,
    ownerEpoch: record.ownerEpoch,
    desktop: structuredClone(record.desktop),
  };
}

function isBindingCurrent(
  store: Pick<WorkerEnvironmentStore, "get">,
  binding: NodeDesktopBinding,
): boolean {
  const current = store.get(binding.environmentId);
  return Boolean(
    current &&
    (current.state === "ready" || current.state === "idle" || current.state === "attached") &&
    current.destroyRequestedAtMs === null &&
    current.leaseId === binding.leaseId &&
    current.nodeDeviceId === binding.nodeDeviceId &&
    current.sshEndpoint === null &&
    current.ownerEpoch === binding.ownerEpoch &&
    current.desktop !== null &&
    isDeepStrictEqual(current.desktop, binding.desktop),
  );
}

function invocationError(
  result: Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>,
): Error {
  const message = result.error?.message?.trim();
  return new Error(message || "worker node desktop stream closed before attachment");
}

function requireLaunchReady(
  result: Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>,
): void {
  if (!result.ok) {
    throw invocationError(result);
  }
  let payload: unknown;
  try {
    payload = result.payloadJSON ? JSON.parse(result.payloadJSON) : undefined;
  } catch {
    throw new Error("Worker environment node desktop launcher returned malformed JSON");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !("status" in payload) ||
    payload.status !== "ready"
  ) {
    throw new Error("Worker environment node desktop launcher returned an invalid result");
  }
}

function launchKey(binding: NodeDesktopBinding, app: WorkerDesktopApp): string {
  return `${binding.environmentId}\0${app.id}`;
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Worker environment node desktop operation aborted");
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signalError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signalError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Node desktop operation failed"));
      },
    );
  });
}

/** Carries one durable worker environment's desktop over its private node connection. */
export function createWorkerNodeDesktopCarrier(options: WorkerNodeDesktopCarrierOptions) {
  let runtime: NodeDesktopRuntime | undefined;
  const claimedEpochs = new Map<string, number>();
  const activeStreams = new Set<ActiveNodeDesktopStream>();
  const activeLaunches = new Map<string, ActiveNodeDesktopLaunch>();

  const bindingIsCurrent = (
    binding: NodeDesktopBinding,
    capturedRuntime: NodeDesktopRuntime,
    node: NodeWorkerSupervisorNodeProof,
  ): boolean =>
    // A broker ticket proves the node connection only. The durable environment row remains
    // the authority for whether that connection may still act for this desktop owner.
    runtime === capturedRuntime &&
    isBindingCurrent(options.store, binding) &&
    capturedRuntime.transport.isCurrent(node, false);

  const findCurrentNode = async (
    binding: NodeDesktopBinding,
    capturedRuntime: NodeDesktopRuntime,
    signal: AbortSignal,
  ): Promise<NodeWorkerSupervisorNodeProof> => {
    signal.throwIfAborted();
    const nodes = await raceWithSignal(capturedRuntime.transport.listCurrentNodes(), signal);
    signal.throwIfAborted();
    const node = nodes.find((candidate) => candidate.nodeId === binding.nodeDeviceId);
    if (!node || !bindingIsCurrent(binding, capturedRuntime, node)) {
      throw new Error("Worker environment node desktop connection is not current");
    }
    return node;
  };

  const retireStream = (active: ActiveNodeDesktopStream): void => {
    if (active.stopped) {
      return;
    }
    active.stopped = true;
    clearTimeout(active.unclaimedTimer);
    active.ticket?.cancel();
    active.controller.abort(new Error("Worker environment node desktop owner stopped"));
    if (!active.reservationTransferred) {
      active.reservation?.release();
    }
    active.stream?.destroy();
    activeStreams.delete(active);
  };

  const stopStream = async (active: ActiveNodeDesktopStream): Promise<void> => {
    retireStream(active);
    await active.invocation?.catch(() => undefined);
  };

  const stopLaunch = async (active: ActiveNodeDesktopLaunch): Promise<void> => {
    active.controller.abort(new Error("Worker environment node desktop owner stopped"));
    await active.operation.catch(() => undefined);
  };

  const stopOwnedOperations = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    const streams = [...activeStreams].filter(
      (active) =>
        active.binding.environmentId === environmentId &&
        (ownerEpoch === undefined || active.binding.ownerEpoch === ownerEpoch),
    );
    const launches = [...activeLaunches.values()].filter(
      (active) =>
        active.binding.environmentId === environmentId &&
        (ownerEpoch === undefined || active.binding.ownerEpoch === ownerEpoch),
    );
    await Promise.all([...streams.map(stopStream), ...launches.map(stopLaunch)]);
  };

  const claimOwner = async (binding: NodeDesktopBinding): Promise<void> => {
    let advanced: boolean;
    try {
      advanced = options.desktopRegistry.claimOwnerEpoch(binding.environmentId, binding.ownerEpoch);
    } catch (error) {
      if (error instanceof DesktopSessionStaleOwnerError) {
        throw new Error("Worker environment node desktop owner epoch is stale", { cause: error });
      }
      throw error;
    }
    const previousEpoch = claimedEpochs.get(binding.environmentId);
    if (previousEpoch === undefined || binding.ownerEpoch > previousEpoch) {
      claimedEpochs.set(binding.environmentId, binding.ownerEpoch);
    }
    if (!advanced) {
      return;
    }
    const staleStreams = [...activeStreams].filter(
      (active) =>
        active.binding.environmentId === binding.environmentId &&
        active.binding.ownerEpoch < binding.ownerEpoch,
    );
    const staleLaunches = [...activeLaunches.values()].filter(
      (active) =>
        active.binding.environmentId === binding.environmentId &&
        active.binding.ownerEpoch < binding.ownerEpoch,
    );
    await options.desktopRegistry.stopSuperseded(binding.environmentId, binding.ownerEpoch);
    await Promise.all([...staleStreams.map(stopStream), ...staleLaunches.map(stopLaunch)]);
  };

  const observe = async (request: {
    record: WorkerEnvironmentRecord;
    control: boolean;
    requester?: DesktopObserveRequester;
  }): Promise<WorkerDesktopObserveResult> => {
    const binding = snapshotNodeDesktopBinding(request.record);
    const active: ActiveNodeDesktopStream = {
      binding,
      controller: new AbortController(),
      reservationTransferred: false,
      stopped: false,
    };
    // Publish ownership before discovery can yield so drain/destroy can abort this attempt.
    activeStreams.add(active);
    try {
      await claimOwner(binding);
      active.controller.signal.throwIfAborted();
      await options.desktopRegistry.activate({
        sourceKey: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        teardown: async () => {
          await stopOwnedOperations(binding.environmentId, binding.ownerEpoch);
        },
      });
      active.controller.signal.throwIfAborted();
      const capturedRuntime = runtime;
      if (!capturedRuntime) {
        throw new Error("Worker environment node desktop runtime is unavailable");
      }
      const node = await findCurrentNode(binding, capturedRuntime, active.controller.signal);
      active.reservation = options.desktopRegistry.reserveObserver(
        binding.environmentId,
        binding.ownerEpoch,
      );
      if (!active.reservation) {
        throw new Error("Worker environment desktop observer limit reached");
      }
      active.ticket = capturedRuntime.streamBroker.mint({
        nodeId: node.nodeId,
        connId: node.connId,
        pairingGeneration: node.pairingGeneration,
      });
      active.invocation = capturedRuntime.transport.invoke({
        node,
        command: NODE_WORKER_DESKTOP_STREAM_COMMAND,
        params: {
          ticket: active.ticket.ticket,
          attachPath: active.ticket.attachPath,
          port: binding.desktop.port,
          ...(binding.desktop.passwordFilePath
            ? { passwordFilePath: binding.desktop.passwordFilePath }
            : {}),
        },
        timeoutMs: 0,
        signal: active.controller.signal,
        isDispatchAuthorized: () => bindingIsCurrent(binding, capturedRuntime, node),
      });
      // A successful stream invoke returns only after the outbound splice closes. Before
      // attachment, any invoke result is therefore a terminal startup failure.
      const invocationFinished = active.invocation.then((result) => {
        throw invocationError(result);
      });
      void invocationFinished.catch(() => undefined);
      const attached = await Promise.race([active.ticket.attached, invocationFinished]);
      active.stream = attached.stream;
      if (!bindingIsCurrent(binding, capturedRuntime, node)) {
        throw new Error("Worker environment node desktop owner changed before attachment");
      }
      if (attached.auth !== "vnc-password" || !attached.vncPassword) {
        throw new Error("Worker environment node desktop did not provide VNC authentication");
      }
      const { DESKTOP_OBSERVE_PATH, mintDesktopObserverToken } =
        await import("../desktop/observe-bridge.js");
      if (!bindingIsCurrent(binding, capturedRuntime, node)) {
        throw new Error("Worker environment node desktop owner changed before publication");
      }
      const attachment = options.desktopRegistry.publishStream({
        sourceKey: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        stream: attached.stream,
        reservation: active.reservation,
      });
      if (!attachment) {
        throw new Error("Worker environment node desktop owner changed before publication");
      }
      active.reservationTransferred = true;
      const issuedAtMs = Date.now();
      const minted = mintDesktopObserverToken({
        sourceKey: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        control: request.control,
        requester: request.requester,
        attachment,
        preauth: {
          auth: "vnc-password",
          credentials: { password: attached.vncPassword },
        },
        nowMs: issuedAtMs,
      });
      active.unclaimedTimer = setTimeout(
        () => {
          if (options.desktopRegistry.hasPendingStream(binding.environmentId, attachment)) {
            void stopStream(active);
          }
        },
        Math.max(0, minted.expiresAtMs - Date.now()),
      );
      active.unclaimedTimer.unref?.();
      void active.invocation.finally(() => retireStream(active)).catch(() => undefined);
      return {
        transport: "rfb",
        wsPath: `${DESKTOP_OBSERVE_PATH}?token=${minted.token}`,
        expiresAtMs: minted.expiresAtMs,
        control: request.control,
      };
    } catch (error) {
      await stopStream(active);
      throw error;
    }
  };

  const launchApp = (request: {
    record: WorkerEnvironmentRecord;
    app: WorkerDesktopApp;
  }): Promise<void> => {
    const binding = snapshotNodeDesktopBinding(request.record);
    const advertisedApp = binding.desktop.apps?.find((app) => app.id === request.app.id);
    if (!advertisedApp || !isDeepStrictEqual(advertisedApp, request.app)) {
      return Promise.reject(
        new Error("Worker environment node desktop app descriptor is not current"),
      );
    }
    const app = structuredClone(advertisedApp);
    const key = launchKey(binding, app);
    const previous = activeLaunches.get(key);
    if (
      previous?.binding.ownerEpoch === binding.ownerEpoch &&
      isDeepStrictEqual(previous.app, app)
    ) {
      return previous.operation;
    }
    const controller = new AbortController();
    const operation = Promise.resolve().then(async () => {
      await claimOwner(binding);
      if (previous) {
        previous.controller.abort(
          new Error("Worker environment node desktop launch owner replaced"),
        );
        await previous.operation.catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      const capturedRuntime = runtime;
      if (!capturedRuntime) {
        throw new Error("Worker environment node desktop runtime is unavailable");
      }
      const node = await findCurrentNode(binding, capturedRuntime, controller.signal);
      if (activeLaunches.get(key) !== entry) {
        throw new Error("Worker environment node desktop launch owner was replaced");
      }
      const result = await capturedRuntime.transport.invoke({
        node,
        command: NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
        params: app,
        timeoutMs: APP_LAUNCH_TIMEOUT_MS,
        signal: controller.signal,
        isDispatchAuthorized: () => bindingIsCurrent(binding, capturedRuntime, node),
      });
      requireLaunchReady(result);
      if (!bindingIsCurrent(binding, capturedRuntime, node)) {
        throw new Error("Worker environment node desktop launch owner changed");
      }
    });
    const entry: ActiveNodeDesktopLaunch = {
      binding,
      app,
      controller,
      operation,
    };
    // Stateful launch is visible to teardown before node discovery or dispatch begins.
    activeLaunches.set(key, entry);
    void operation
      .finally(() => {
        if (activeLaunches.get(key) === entry) {
          activeLaunches.delete(key);
        }
      })
      .catch(() => undefined);
    return operation;
  };

  const stop = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    await Promise.all([
      options.desktopRegistry.stop(environmentId, ownerEpoch),
      stopOwnedOperations(environmentId, ownerEpoch),
    ]);
  };

  const stopAll = async (): Promise<void> => {
    await Promise.all(
      [...claimedEpochs].map(([environmentId, ownerEpoch]) => stop(environmentId, ownerEpoch)),
    );
  };

  return {
    bindRuntime(next: NodeDesktopRuntime): void {
      runtime = next;
    },
    launchApp,
    observe,
    stop,
    stopAll,
  };
}

export type WorkerNodeDesktopCarrier = ReturnType<typeof createWorkerNodeDesktopCarrier>;
