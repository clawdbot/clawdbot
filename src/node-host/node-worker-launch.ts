import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type {
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchReceipt,
  NodeWorkerLaunchStore,
  NodeWorkerContainerIdentity,
} from "./node-worker-launch-store.js";
import {
  prepareNodeWorkerLaunchTransport,
  startNodeWorkerLaunchTransport,
  type NodeWorkerChildAdapter,
} from "./node-worker-launch-transport.js";
import {
  createNodeWorkerCredentialScrubber,
  sanitizeNodeWorkerDiagnostic,
} from "./node-worker-output.js";
import {
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import type { NodeWorkerLaunchInput } from "./node-worker-supervisor-contract.js";
import {
  createNodeWorkerActiveTurn,
  createNodeWorkerJournalGate,
  nodeWorkerEnvironmentBinding,
  type NodeWorkerActiveOwnership,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
} from "./node-worker-supervisor-ownership.js";
import { nodeWorkerDescriptorSecrets } from "./node-worker-turn-lifecycle.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

type NodeWorkerLaunchContext = {
  bundleRoot: string;
  workerEnv: NodeJS.ProcessEnv;
  engineEnv: NodeJS.ProcessEnv;
  store: NodeWorkerLaunchStore;
  turns: NodeWorkerTurnStore;
  capacity: NodeWorkerCapacity;
  containerEngine?: NodeWorkerContainerEngine;
  containerImage?: string;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  requireContainerLifecycle: () => NodeWorkerContainerLifecycle;
  active: Map<string, NodeWorkerActiveOwnership>;
  isClosed: () => boolean;
  observeChild: (active: NodeWorkerRunningChild) => Promise<void>;
  stopChild: (active: NodeWorkerRunningChild, state: NodeWorkerStopState) => Promise<void>;
};

/** Starts one physical owner behind the durable journal gate, independent of turn reuse. */
export async function startNodeWorkerChild(
  context: NodeWorkerLaunchContext,
  params: {
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    claim: NodeWorkerLaunchClaim;
    signal?: AbortSignal;
  },
): Promise<NodeWorkerLaunchReceipt> {
  const sensitiveValues = nodeWorkerDescriptorSecrets(params.descriptor);
  const scrubber = createNodeWorkerCredentialScrubber(sensitiveValues);
  // Turn cancellation can beat the child's admission retry deadline. Retain the
  // producer's latest cause so the durable terminal receipt does not become generic.
  const connectionFailure: { errorText?: string } = {};
  for (const value of sensitiveValues) {
    registerSecretValueForRedaction(value);
  }
  let adapter: NodeWorkerChildAdapter;
  let container: NodeWorkerContainerIdentity | undefined;
  try {
    const prepared = await prepareNodeWorkerLaunchTransport({
      bundleRoot: context.bundleRoot,
      workerEnv: context.workerEnv,
      engineEnv: context.engineEnv,
      input: params.input,
      descriptor: params.descriptor,
      connectionFailure,
      scrubber,
      store: context.store,
      containerEngine: context.containerEngine,
      containerLifecycle: context.containerLifecycle,
      containerImage: context.containerImage,
    });
    if (prepared.kind === "terminal") {
      return prepared.receipt;
    }
    adapter = prepared.adapter;
    container = prepared.container;
  } catch (error) {
    return context.capacity.finish({
      launchId: params.input.launchId,
      planHash: params.planHash,
      supervisor: params.supervisor,
      worker: null,
      state: "failed",
      errorText: sanitizeNodeWorkerDiagnostic(error, "node worker spawn failed", scrubber.scrub),
    });
  }
  if (!adapter.pid) {
    if (container) {
      await context.requireContainerLifecycle().remove(container, params.input);
    }
    adapter.kill("SIGKILL");
    adapter.dispose();
    return context.capacity.finish({
      launchId: params.input.launchId,
      planHash: params.planHash,
      supervisor: params.supervisor,
      worker: null,
      state: "failed",
      errorText: "node worker spawn did not return a process id",
    });
  }
  let worker: NodeWorkerProcessIdentity;
  try {
    worker = requireNodeWorkerProcessIdentity(adapter.pid);
  } catch (error) {
    if (container) {
      await context.requireContainerLifecycle().remove(container, params.input);
    }
    adapter.kill("SIGKILL");
    await adapter.wait().catch(() => undefined);
    adapter.dispose();
    return context.capacity.finish({
      launchId: params.input.launchId,
      planHash: params.planHash,
      supervisor: params.supervisor,
      worker: null,
      state: "failed",
      errorText: sanitizeNodeWorkerDiagnostic(
        error,
        "node worker process identity unavailable",
        scrubber.scrub,
      ),
    });
  }
  const { journalReady, releaseJournal } = createNodeWorkerJournalGate();
  const active = {
    state: "running",
    binding: nodeWorkerEnvironmentBinding(params.input),
    turn: createNodeWorkerActiveTurn(params.claim),
    retiring: false,
    adapter,
    journalReady,
    gatewayNamespace: params.input.gatewayNamespace,
    launchId: params.input.launchId,
    planHash: params.planHash,
    releaseJournal,
    scrubber,
    connectionFailure,
    supervisor: params.supervisor,
    worker,
    ...(container ? { container } : {}),
  } as NodeWorkerRunningChild; // SAFETY: done is assigned synchronously below; observation waits on journalReady before publishing state.
  active.done = context.observeChild(active);
  context.active.set(active.launchId, active);
  void active.done.catch(() => undefined);
  let running: NodeWorkerLaunchReceipt;
  try {
    running = context.store.markRunning({
      launchId: active.launchId,
      planHash: active.planHash,
      supervisor: params.supervisor,
      worker,
      ...(container ? { container } : {}),
    });
  } catch (error) {
    active.releaseJournal();
    if (container) {
      await context.stopChild(active, "interrupted");
      context.active.delete(active.launchId);
      context.capacity.finish({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: params.supervisor,
        worker: null,
        state: "failed",
        errorText: sanitizeNodeWorkerDiagnostic(
          error,
          "node worker container identity could not be persisted",
          scrubber.scrub,
        ),
      });
    } else {
      await context.stopChild(active, "interrupted").catch(() => undefined);
    }
    throw error;
  }
  active.releaseJournal();
  if (running.state === "cancelled" || running.state === "interrupted") {
    await context.stopChild(active, running.state);
    return context.store.get(active.launchId) ?? running;
  }
  if (running.state !== "running") {
    if (container) {
      await context.stopChild(active, "interrupted");
    } else {
      adapter.closeStartGate?.();
    }
    return running;
  }
  if (context.isClosed() || params.signal?.aborted || active.turn?.cancelled) {
    await context.stopChild(active, context.isClosed() ? "interrupted" : "cancelled");
    return context.store.get(active.launchId) ?? running;
  }
  try {
    await startNodeWorkerLaunchTransport({
      adapter,
      descriptor: params.descriptor,
      container,
      isCurrent: () =>
        context.active.get(active.launchId) === active &&
        !context.isClosed() &&
        !params.signal?.aborted &&
        active.turn?.cancelled === false,
    });
  } catch {
    await context.stopChild(active, active.turn?.cancelled ? "cancelled" : "interrupted");
    return context.store.get(active.launchId) ?? running;
  }
  return context.turns.get(params.input.launchId) ?? running;
}
