import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { withTimeout } from "../infra/fs-safe.js";
import {
  completeWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import {
  validateNodeWorkerLaunchInput,
  type NodeWorkerEnvironmentStopInput,
} from "../worker/node-supervisor-protocol.js";
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
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import { sendNodeWorkerInput } from "./node-worker-launch-transport.js";
import { startNodeWorkerChild } from "./node-worker-launch.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  nodeWorkerPlanHash,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
} from "./node-worker-supervisor-contract.js";
import {
  nodeWorkerEnvironmentBinding,
  nodeWorkerEnvironmentKey,
  nodeWorkerEnvironmentMatches,
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerActiveOwnership,
  type NodeWorkerEnvironmentBinding,
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
import {
  settleNodeWorkerTurn,
  startNodeWorkerTurn,
  waitForNodeWorkerRetirement,
} from "./node-worker-turn-lifecycle.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, NodeWorkerActiveOwnership>();
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly bundleRoot: string;
  private readonly store: NodeWorkerLaunchStore;
  private readonly turns: NodeWorkerTurnStore;
  private readonly admissions = new Map<
    string,
    {
      binding: NodeWorkerEnvironmentBinding;
      launchId: string;
      planHash: string;
      abort: AbortController;
      done: Promise<NodeWorkerLaunchReceipt>;
    }
  >();
  private readonly stoppingEnvironments = new Map<string, number>();
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
    this.turns = new NodeWorkerTurnStore({ env });
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
    rawInput: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    const input = validateNodeWorkerLaunchInput(structuredClone(rawInput));
    const descriptor = completeWorkerLaunchDescriptor(input.descriptor, connectionEndpoint);
    const planHash = nodeWorkerPlanHash(input);
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    const binding = nodeWorkerEnvironmentBinding(input);
    const key = nodeWorkerEnvironmentKey(binding);
    if (this.stoppingEnvironments.has(key)) {
      throw new Error("node worker environment is stopping");
    }
    const admission = this.admissions.get(key);
    if (admission) {
      if (admission.launchId !== input.launchId || admission.planHash !== planHash) {
        throw new Error("node worker environment already has a turn being admitted");
      }
      return await admission.done;
    }
    const abort = new AbortController();
    const done = this.launchAdmitted(
      input,
      descriptor,
      planHash,
      signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
    );
    const pending = { binding, launchId: input.launchId, planHash, abort, done };
    this.admissions.set(key, pending);
    try {
      return await done;
    } finally {
      if (this.admissions.get(key) === pending) {
        this.admissions.delete(key);
      }
    }
  }

  private async launchAdmitted(
    input: NodeWorkerLaunchInput,
    descriptor: WorkerLaunchDescriptor,
    planHash: string,
    signal: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    await this.initialize();
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
    signal.throwIfAborted();
    const previous = this.turns.get(input.launchId);
    if (previous) {
      this.turns.claim({
        claim: claimInput,
        ownerLaunchId: previous.ownerLaunchId,
        supervisor: previous.supervisor,
        worker: previous.worker,
      });
      return (await this.status(input.launchId)) ?? previous;
    }
    const binding = nodeWorkerEnvironmentBinding(input);
    for (const owner of this.active.values()) {
      if (nodeWorkerEnvironmentKey(owner.binding) !== nodeWorkerEnvironmentKey(binding)) {
        continue;
      }
      if (owner.state === "observed") {
        this.reconcileActiveTerminal(owner);
        continue;
      }
      await this.statusOwner(owner.launchId);
      await waitForNodeWorkerRetirement(owner, signal);
      signal.throwIfAborted();
      if (this.active.get(owner.launchId) !== owner) {
        continue;
      }
      if (owner.turn) {
        throw new Error("node worker environment already has an active turn");
      }
      if (owner.stopState || owner.retiring) {
        throw new Error("node worker environment cleanup is incomplete");
      }
      if (JSON.stringify(owner.binding) !== JSON.stringify(binding)) {
        if (
          binding.ownerEpoch < owner.binding.ownerEpoch ||
          (binding.ownerEpoch === owner.binding.ownerEpoch &&
            binding.placementGeneration < owner.binding.placementGeneration)
        ) {
          throw new Error("node worker launch belongs to a replaced environment");
        }
        await this.stopChild(owner, "interrupted");
        if (this.active.get(owner.launchId) === owner) {
          throw new Error("node worker environment cleanup is incomplete");
        }
        signal.throwIfAborted();
        continue;
      }
      return await startNodeWorkerTurn({
        active: owner,
        descriptor,
        claim: claimInput,
        signal,
        store: this.turns,
        cancel: (expected) => this.cancel(expected),
        stopChild: (active, state) => this.stopChild(active, state),
      });
    }
    const claim = await this.capacity.claim(claimInput, supervisor, signal);
    if (claim.action === "recover") {
      await this.recoverRunning(claim.receipt);
    }
    if (claim.action !== "start") {
      // A pruned turn can share the first launch's ID. Its physical anchor is
      // cleanup authority, never a substitute receipt for that expired turn.
      throw new Error("node worker turn receipt expired; request a fresh turn");
    }
    try {
      this.turns.claim({ claim: claimInput, ownerLaunchId: input.launchId, supervisor });
    } catch (error) {
      this.capacity.finish({
        ...claimInput,
        supervisor,
        worker: null,
        state: "failed",
        errorText: "node worker turn could not be journaled",
      });
      throw error;
    }
    let cancellation: Promise<NodeWorkerLaunchReceipt | undefined> | undefined;
    const cancelClaimed = () => {
      cancellation ??= this.cancel(claimInput);
      void cancellation.catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelClaimed, { once: true });
    const startup = startNodeWorkerChild(
      {
        bundleRoot: this.bundleRoot,
        workerEnv: this.workerEnv,
        engineEnv: this.engineEnv,
        store: this.store,
        turns: this.turns,
        capacity: this.capacity,
        containerEngine: this.containerEngine,
        containerImage: this.containerImage,
        containerLifecycle: this.containerLifecycle,
        requireContainerLifecycle: () => this.requireContainerLifecycle(),
        active: this.active,
        isClosed: () => this.closed,
        observeChild: (active) => this.observeChild(active),
        stopChild: (active, state) => this.stopChild(active, state),
      },
      {
        input,
        descriptor,
        planHash,
        supervisor,
        signal,
        claim: claimInput,
      },
    );
    this.starting.set(input.launchId, startup);
    if (signal?.aborted) {
      cancelClaimed();
    }
    try {
      const receipt = await startup;
      return cancellation ? ((await cancellation) ?? receipt) : receipt;
    } finally {
      signal?.removeEventListener("abort", cancelClaimed);
      if (this.starting.get(input.launchId) === startup) {
        this.starting.delete(input.launchId);
      }
    }
  }

  async status(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const turn = this.turns.get(launchId);
    if (turn) {
      if (
        this.active.get(turn.ownerLaunchId)?.state === "observed" ||
        turn.state === "pending" ||
        turn.state === "running"
      ) {
        await this.statusOwner(turn.ownerLaunchId);
      }
      return this.turns.get(launchId);
    }
    return undefined;
  }

  private async statusOwner(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
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
    const claimed = this.turns.getMatching(expected);
    const claimedOwner = claimed && this.active.get(claimed.ownerLaunchId);
    if (
      claimedOwner?.state === "running" &&
      claimedOwner.turn?.claim.launchId === expected.launchId
    ) {
      // Close admission synchronously: cancellation can arrive inside markRunning,
      // before its continuation opens the child's start gate.
      claimedOwner.turn.cancelled = true;
    }
    await this.initialize();
    const receipt = this.turns.getMatching(expected);
    if (!receipt) {
      return undefined;
    }
    if (receipt.state !== "pending" && receipt.state !== "running") {
      return await this.status(receipt.launchId);
    }
    const active = this.active.get(receipt.ownerLaunchId);
    if (active?.state !== "running" || active.turn?.claim.launchId !== expected.launchId) {
      const owner = this.store.get(receipt.ownerLaunchId);
      if (owner) {
        await this.cancelOwner(owner);
      }
      return this.turns.getMatching(expected);
    }
    const turn = active.turn;
    turn.cancelled = true;
    try {
      // A worker that stopped reading can block the write as well as the reply.
      await withTimeout(
        sendNodeWorkerInput(active.adapter, { type: "cancel", turnId: expected.launchId }).then(
          () => turn.done,
        ),
        STOP_GRACE_MS + FORCE_STOP_WAIT_MS,
        { message: "node worker turn cancellation did not settle" },
      );
    } catch {
      if (this.active.get(active.launchId) === active && active.turn === turn) {
        await this.stopChild(active, "cancelled");
      }
    }
    return this.turns.getMatching(expected);
  }

  async stopEnvironment(expected: NodeWorkerEnvironmentStopInput): Promise<void> {
    const key = nodeWorkerEnvironmentKey(expected);
    this.stoppingEnvironments.set(key, (this.stoppingEnvironments.get(key) ?? 0) + 1);
    try {
      const admission = this.admissions.get(key);
      if (admission && nodeWorkerEnvironmentMatches(admission.binding, expected)) {
        admission.abort.abort(new Error("node worker environment stopped"));
        await admission.done.catch(() => undefined);
      }
      await this.initialize();
      for (const owner of this.active.values()) {
        if (!nodeWorkerEnvironmentMatches(owner.binding, expected)) {
          continue;
        }
        if (owner.state === "running") {
          await this.stopChild(owner, "interrupted");
        }
        const observed = this.active.get(owner.launchId);
        if (observed?.state === "observed") {
          this.reconcileActiveTerminal(observed);
        } else if (observed) {
          throw new Error("node worker environment cleanup is incomplete");
        }
      }
      for (const owner of this.store.listNonterminal()) {
        if (nodeWorkerEnvironmentMatches(owner, expected)) {
          await this.cancelOwner(owner);
          const remaining = this.store.get(owner.launchId);
          if (remaining?.state === "pending" || remaining?.state === "running") {
            throw new Error("node worker environment is still owned by another supervisor");
          }
        }
      }
    } finally {
      const remaining = this.stoppingEnvironments.get(key)! - 1;
      if (remaining === 0) {
        this.stoppingEnvironments.delete(key);
      } else {
        this.stoppingEnvironments.set(key, remaining);
      }
    }
  }

  private async cancelOwner(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const receipt = this.store.getMatching(expected);
    if (!receipt || (receipt.state !== "pending" && receipt.state !== "running")) {
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
        return await this.cancelOwner(expected);
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
      return await this.cancelOwner(expected);
    }
    return await recoverNodeWorkerLaunch({
      receipt,
      store: this.store,
      capacity: this.capacity,
      containerLifecycle: this.containerLifecycle,
      notifyCapacity: true,
      state: "cancelled",
    });
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.capacity.close();
    for (const admission of this.admissions.values()) {
      admission.abort.abort(new Error("node worker supervisor is closed"));
    }
    const operation = (async () => {
      const errors: unknown[] = [];
      await this.initializationPromise?.catch((error: unknown) => errors.push(error));
      await Promise.allSettled([...this.admissions.values()].map((admission) => admission.done));
      await Promise.allSettled(this.starting.values());
      const stopped = await Promise.allSettled(
        [...this.active.values()]
          .filter((active): active is NodeWorkerRunningChild => active.state === "running")
          .map((active) => this.stopChild(active, "interrupted")),
      );
      errors.push(...stopped.flatMap((r) => (r.status === "rejected" ? [r.reason] : [])));
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
      if (errors.length > 0) {
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "node worker terminal reconciliation failed");
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

  private async observeChild(active: NodeWorkerRunningChild): Promise<void> {
    const outcome = await observeNodeWorkerChildOutput(
      active,
      (frame) => {
        settleNodeWorkerTurn(active, frame, this.turns);
      },
      () => active.turn?.claim.launchId,
    );
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
      binding: active.binding,
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
    active.turn?.settle();
    active.turn = undefined;
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
