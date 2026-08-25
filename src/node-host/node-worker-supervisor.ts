import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  completeWorkerLaunchDescriptor,
  parseWorkerLaunchPlan,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import {
  observeNodeWorkerChildOutput,
  type NodeWorkerTerminalOutcome,
} from "./node-worker-launch-observation.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerContainerIdentity,
  type NodeWorkerLaunchReceipt,
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
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  assertNodeWorkerLaunchIdentity,
  nodeWorkerPlanHash,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
} from "./node-worker-supervisor-contract.js";
import {
  createNodeWorkerJournalGate,
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerActiveOwnership,
  type NodeWorkerObservedTerminal,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
  type NodeWorkerSupervisorOptions,
} from "./node-worker-supervisor-ownership.js";
import { recoverNodeWorkerLaunch } from "./node-worker-supervisor-recovery.js";
import {
  inspectOwnedNodeWorkerTree,
  signalOwnedNodeWorkerTree,
  waitForOwnedNodeWorkerTreeDeath,
} from "./node-worker-tree-control.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, NodeWorkerActiveOwnership>();
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly bundleRoot: string;
  private readonly store: NodeWorkerLaunchStore;
  private readonly workerEnv: NodeJS.ProcessEnv;
  private readonly engineEnv: NodeJS.ProcessEnv;
  private readonly capacity: NodeWorkerCapacity;
  private readonly workspace: NodeWorkerWorkspaceRuntime;
  private readonly containerEngine?: NodeWorkerContainerEngine;
  private readonly containerLifecycle?: NodeWorkerContainerLifecycle;
  private readonly containerImage?: string;
  private supervisorIdentity?: NodeWorkerProcessIdentity;
  private initializationPromise?: Promise<void>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: NodeWorkerSupervisorOptions = {}) {
    const env = options.env ?? process.env;
    this.bundleRoot = path.resolve(
      options.bundleRoot ?? path.join(resolveStateDir(env), "node-host"),
    );
    this.store = new NodeWorkerLaunchStore({ env });
    this.workerEnv = snapshotNodeWorkerEnv(env);
    this.engineEnv = { ...process.env, ...env };
    this.containerEngine = options.containerEngine;
    this.containerLifecycle = options.containerEngine
      ? new NodeWorkerContainerLifecycle(options.containerEngine, this.bundleRoot, this.store)
      : undefined;
    this.containerImage = options.containerImage;
    this.workspace =
      options.workspace ??
      new NodeWorkerWorkspaceRuntime({ root: this.bundleRoot, env: this.workerEnv });
    this.capacity = new NodeWorkerCapacity(this.store, options);
  }

  initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    const initialization = (async () => {
      if (this.containerLifecycle) {
        await this.containerLifecycle.initialize();
      }
      await this.capacity.initialize(async (receipt) => {
        await this.recoverRunning(receipt, false);
      });
    })().catch((error: unknown) => {
      if (this.initializationPromise === initialization) {
        this.initializationPromise = undefined;
      }
      throw error;
    });
    return (this.initializationPromise = initialization);
  }

  private requireContainerLifecycle(): NodeWorkerContainerLifecycle {
    if (!this.containerLifecycle) {
      throw new Error("node worker container isolation has no available engine");
    }
    return this.containerLifecycle;
  }

  async launch(
    input: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    if (!GATEWAY_NAMESPACE_PATTERN.test(input.gatewayNamespace)) {
      throw new Error("gateway namespace must be a safe bounded path component");
    }
    if (!BUNDLE_HASH_PATTERN.test(input.expectedBundleHash)) {
      throw new Error("node worker bundle hash must be 64 lowercase hexadecimal characters");
    }
    if (!Number.isSafeInteger(input.placementGeneration) || input.placementGeneration < 0) {
      throw new Error("node worker placement generation must be a non-negative safe integer");
    }
    const plan = parseWorkerLaunchPlan(structuredClone(input.descriptor));
    const descriptor = completeWorkerLaunchDescriptor(plan, connectionEndpoint);
    assertNodeWorkerLaunchIdentity(input, descriptor);
    const planHash = nodeWorkerPlanHash(input);
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    await this.initialize();
    const local = this.active.get(input.launchId);
    if (local) {
      if (local.planHash !== planHash) {
        throw new Error(`node worker launch ${input.launchId} was replayed with a different plan`);
      }
      if (local.state === "observed") {
        return this.reconcileActiveTerminal(local);
      }
      const receipt = this.store.get(input.launchId);
      if (receipt) {
        return receipt;
      }
    }
    const supervisor = (this.supervisorIdentity ??= requireNodeWorkerProcessIdentity(process.pid));
    const claimInput = {
      launchId: input.launchId,
      planHash,
      gatewayNamespace: input.gatewayNamespace,
      environmentId: descriptor.admission.environmentId,
      sessionId: descriptor.admission.sessionId,
      ownerEpoch: descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: descriptor.assignment.runId,
    };
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    const claim = await this.capacity.claim(claimInput, supervisor, signal);
    if (claim.action === "recover") {
      return await this.recoverRunning(claim.receipt);
    }
    if (claim.action === "replay") {
      const replay = this.active.get(input.launchId);
      if (replay?.planHash === planHash && replay.state === "observed") {
        return this.reconcileActiveTerminal(replay);
      }
      const startup = this.starting.get(input.launchId);
      return startup && claim.receipt.state === "pending" ? await startup : claim.receipt;
    }
    const startup = this.startClaimed({ input, descriptor, planHash, supervisor });
    this.starting.set(input.launchId, startup);
    try {
      return await startup;
    } finally {
      if (this.starting.get(input.launchId) === startup) {
        this.starting.delete(input.launchId);
      }
    }
  }

  async status(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const active = this.active.get(launchId);
    if (active?.state === "observed") {
      return this.reconcileActiveTerminal(active);
    }
    if (active?.state === "running") {
      if (active.container) {
        const inspection = await this.requireContainerLifecycle().inspect(active.container, active);
        if (inspection === "unknown") {
          return this.store.get(launchId);
        }
        if (inspection === "reused") {
          throw new Error(`node worker launch ${launchId} lost its container ownership`);
        }
        if (inspection === "live") {
          const clientState = inspectNodeWorkerProcessIdentity(active.worker);
          if (clientState !== "dead" && clientState !== "reused") {
            return this.store.get(launchId);
          }
          // Observe the dead attach client's result before fencing its still-running owner.
          await active.done;
          if (this.active.get(launchId) === active) {
            await this.stopChild(active, "interrupted");
          }
        } else {
          await this.cleanupActiveContainer(active);
          await active.done;
          if (active.deferredOutcome) {
            this.observeTerminalOutcome(active, active.deferredOutcome);
          }
        }
        const observed = this.active.get(launchId);
        return observed?.state === "observed"
          ? this.reconcileActiveTerminal(observed)
          : this.store.get(launchId);
      }
      const workerState = inspectNodeWorkerProcessIdentity(active.worker);
      if (workerState === "dead" || workerState === "reused") {
        let treeState = inspectOwnedNodeWorkerTree(active.worker);
        if (treeState === "live") {
          await signalOwnedNodeWorkerTree(active.worker, "SIGTERM");
          treeState = await waitForOwnedNodeWorkerTreeDeath(active.worker, STOP_GRACE_MS);
        }
        if (treeState === "live") {
          await signalOwnedNodeWorkerTree(active.worker, "SIGKILL");
          await waitForOwnedNodeWorkerTreeDeath(active.worker, FORCE_STOP_WAIT_MS);
        }
        await active.done;
        const observed = this.active.get(launchId);
        if (observed?.state === "observed") {
          return this.reconcileActiveTerminal(observed);
        }
      }
      return this.store.get(launchId);
    }
    const receipt = this.store.get(launchId);
    return receipt?.state === "running" ? await this.recoverRunning(receipt) : receipt;
  }

  async retainWorkspaces(
    input: NodeWorkerWorkspaceRetainInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerWorkspaceRetainResult> {
    await this.initialize();
    return await this.workspace.applyRetainSnapshot(
      input,
      () => this.store.listNonterminal(),
      signal,
    );
  }

  async cancel(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const receipt = this.store.getMatching(expected);
    if (!receipt || receipt.state === "completed" || receipt.state === "failed") {
      return receipt;
    }
    if (receipt.state === "interrupted" || receipt.state === "cancelled") {
      return receipt;
    }
    const active = this.active.get(expected.launchId);
    if (active) {
      if (
        active.planHash !== expected.planHash ||
        !nodeWorkerReceiptMatchesOwner(receipt, active.supervisor, active.worker, active.container)
      ) {
        return receipt;
      }
      if (active.state === "running") {
        await this.stopChild(active, "cancelled");
      }
      const observed = this.active.get(expected.launchId);
      if (observed?.state === "observed") {
        return this.reconcileActiveTerminal(observed);
      }
      return this.store.getMatching(expected);
    }
    const startup = this.starting.get(expected.launchId);
    if (startup && receipt.state === "pending" && receipt.supervisor.pid === process.pid) {
      if (this.containerEngine) {
        // Startup may already own a container while its create/start client is
        // in flight; retain the durable slot until normal cancellation fences it.
        await startup;
        return await this.cancel(expected);
      }
      const cancelled = this.capacity.finishCancelled({
        expected,
        supervisor: receipt.supervisor,
        worker: null,
      });
      await startup;
      return this.store.getMatching(expected) ?? cancelled;
    }
    if (startup && receipt.container && receipt.supervisor.pid === process.pid) {
      await startup;
      return await this.cancel(expected);
    }
    const supervisorState = inspectNodeWorkerProcessIdentity(receipt.supervisor);
    if (supervisorState === "live" || supervisorState === "unknown") {
      return receipt;
    }
    if (!receipt.worker) {
      return this.capacity.finishCancelled({
        expected,
        supervisor: receipt.supervisor,
        worker: null,
      });
    }
    if (receipt.container) {
      const containerState = await this.requireContainerLifecycle().inspect(
        receipt.container,
        receipt,
      );
      if (containerState === "unknown" || containerState === "reused") {
        return receipt;
      }
      const beforeSignal = this.store.getMatching(expected);
      if (
        beforeSignal?.state !== "running" ||
        !nodeWorkerReceiptMatchesOwner(
          beforeSignal,
          receipt.supervisor,
          receipt.worker,
          receipt.container,
        )
      ) {
        return beforeSignal;
      }
      await this.requireContainerLifecycle().remove(receipt.container, receipt);
      return this.capacity.finishCancelled({
        expected,
        supervisor: receipt.supervisor,
        worker: receipt.worker,
      });
    }
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return receipt;
    }
    if (workerState === "live") {
      const beforeSignal = this.store.getMatching(expected);
      if (
        beforeSignal?.state !== "running" ||
        !nodeWorkerReceiptMatchesOwner(beforeSignal, receipt.supervisor, receipt.worker)
      ) {
        return beforeSignal;
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      const beforeSignal = this.store.getMatching(expected);
      if (
        beforeSignal?.state !== "running" ||
        !nodeWorkerReceiptMatchesOwner(beforeSignal, receipt.supervisor, receipt.worker)
      ) {
        return beforeSignal;
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
    }
    if (workerState !== "dead") {
      return this.store.getMatching(expected);
    }
    return this.capacity.finishCancelled({
      expected,
      supervisor: receipt.supervisor,
      worker: receipt.worker,
    });
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.capacity.close();
    const operation = (async () => {
      const errors: unknown[] = [];
      if (this.initializationPromise) {
        try {
          await this.initializationPromise;
        } catch (error) {
          errors.push(error);
        }
      }
      await Promise.allSettled(this.starting.values());
      await Promise.all(
        [...this.active.values()]
          .filter((active): active is NodeWorkerRunningChild => active.state === "running")
          .map(async (active) => await this.stopChild(active, "interrupted")),
      );
      for (const active of this.active.values()) {
        if (active.state !== "observed") {
          continue;
        }
        try {
          this.reconcileActiveTerminal(active);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "node worker terminal reconciliation failed");
      }
    })();
    const closePromise = operation.finally(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = undefined;
      }
    });
    this.closePromise = closePromise;
    return closePromise;
  }

  private reconcileActiveTerminal(active: NodeWorkerObservedTerminal): NodeWorkerLaunchReceipt {
    try {
      const receipt = this.capacity.finish({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: active.supervisor,
        worker: active.worker,
        ...active.outcome,
      });
      if (receipt.state === "pending" || receipt.state === "running") {
        throw new Error(`node worker launch ${active.launchId} terminal state was not persisted`);
      }
      if (this.active.get(active.launchId) === active) {
        this.active.delete(active.launchId);
      }
      return receipt;
    } catch (error) {
      active.persistenceError = error;
      throw error;
    }
  }

  private async recoverRunning(
    receipt: NodeWorkerLaunchReceipt,
    notifyCapacity = true,
  ): Promise<NodeWorkerLaunchReceipt> {
    return await recoverNodeWorkerLaunch({
      receipt,
      store: this.store,
      capacity: this.capacity,
      containerLifecycle: this.containerLifecycle,
      notifyCapacity,
    });
  }

  private async startClaimed(params: {
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
  }): Promise<NodeWorkerLaunchReceipt> {
    const credential = params.descriptor.admission.credential;
    const endpoint = params.descriptor.connectionEndpoint;
    const cloudflareAccess = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
    const sensitiveValues = cloudflareAccess
      ? [credential, cloudflareAccess.clientId, cloudflareAccess.clientSecret]
      : [credential];
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
        bundleRoot: this.bundleRoot,
        workerEnv: this.workerEnv,
        engineEnv: this.engineEnv,
        input: params.input,
        descriptor: params.descriptor,
        connectionFailure,
        scrubber,
        store: this.store,
        containerEngine: this.containerEngine,
        containerLifecycle: this.containerLifecycle,
        containerImage: this.containerImage,
      });
      if (prepared.kind === "terminal") {
        return prepared.receipt;
      }
      adapter = prepared.adapter;
      container = prepared.container;
    } catch (error) {
      return this.capacity.finish({
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
        await this.requireContainerLifecycle().remove(container, params.input);
      }
      adapter.kill("SIGKILL");
      adapter.dispose();
      return this.capacity.finish({
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
        await this.requireContainerLifecycle().remove(container, params.input);
      }
      adapter.kill("SIGKILL");
      await adapter.wait().catch(() => undefined);
      adapter.dispose();
      return this.capacity.finish({
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
    } as NodeWorkerRunningChild;
    active.done = this.observeChild(active);
    this.active.set(active.launchId, active);
    void active.done.catch(() => undefined);
    let running: NodeWorkerLaunchReceipt;
    try {
      running = this.store.markRunning({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: params.supervisor,
        worker,
        ...(container ? { container } : {}),
      });
    } catch (error) {
      active.releaseJournal();
      if (container) {
        await this.stopChild(active, "interrupted");
        this.active.delete(active.launchId);
        this.capacity.finish({
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
        await this.stopChild(active, "interrupted").catch(() => undefined);
      }
      throw error;
    }
    active.releaseJournal();
    if (running.state === "cancelled" || running.state === "interrupted") {
      await this.stopChild(active, running.state);
      return this.store.get(active.launchId) ?? running;
    }
    if (running.state !== "running") {
      if (container) {
        await this.stopChild(active, "interrupted");
      } else {
        adapter.closeStartGate?.();
      }
      return running;
    }
    if (this.closed) {
      await this.stopChild(active, "interrupted");
      return this.store.get(active.launchId) ?? running;
    }
    try {
      await startNodeWorkerLaunchTransport({ adapter, descriptor: params.descriptor, container });
    } catch {
      await this.stopChild(active, "interrupted");
      return this.store.get(active.launchId) ?? running;
    }
    return running;
  }

  private async observeChild(active: NodeWorkerRunningChild): Promise<void> {
    const outcome = await observeNodeWorkerChildOutput(active);
    if (active.container) {
      try {
        await this.cleanupActiveContainer(active);
      } catch {
        // Keep the launch running until a later cancel/status can prove the
        // container was removed; failed cleanup must never release its slot.
        active.deferredOutcome = outcome;
        return;
      }
    }
    this.observeTerminalOutcome(active, outcome);
  }

  private observeTerminalOutcome(
    active: NodeWorkerRunningChild,
    outcome: NodeWorkerTerminalOutcome,
  ): void {
    const observed: NodeWorkerObservedTerminal = {
      state: "observed",
      gatewayNamespace: active.gatewayNamespace,
      launchId: active.launchId,
      planHash: active.planHash,
      supervisor: active.supervisor,
      worker: active.worker,
      ...(active.container ? { container: active.container } : {}),
      outcome,
    };
    if (this.active.get(active.launchId) !== active) {
      return;
    }
    this.active.set(active.launchId, observed);
    try {
      this.reconcileActiveTerminal(observed);
    } catch {
      // The observed outcome stays owned in memory for the next supervisor operation.
    }
  }

  private async cleanupActiveContainer(active: NodeWorkerRunningChild): Promise<void> {
    if (!active.container) {
      return;
    }
    if (!active.containerCleanup) {
      const cleanup = this.requireContainerLifecycle()
        .remove(active.container, active)
        .finally(() => {
          if (active.containerCleanup === cleanup) {
            active.containerCleanup = undefined;
          }
        });
      active.containerCleanup = cleanup;
    }
    await active.containerCleanup;
  }

  private async stopChild(
    active: NodeWorkerRunningChild,
    state: NodeWorkerStopState,
  ): Promise<void> {
    active.stopState ??= state;
    if (active.container) {
      // The attach client owns no workload; fence the container and prove its
      // removal before its launch can become terminal or release capacity.
      await this.cleanupActiveContainer(active);
    }
    active.adapter.kill("SIGTERM");
    const forceKill = setTimeout(() => active.adapter.kill("SIGKILL"), STOP_GRACE_MS);
    forceKill.unref?.();
    try {
      await active.done;
      if (active.deferredOutcome) {
        this.observeTerminalOutcome(active, active.deferredOutcome);
      }
    } finally {
      clearTimeout(forceKill);
    }
  }
}

export function createNodeWorkerSupervisor(
  options: NodeWorkerSupervisorOptions = {},
): NodeWorkerSupervisor {
  return new NodeWorkerSupervisor(options);
}
