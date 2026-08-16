import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../process/exec-output.js";
import { createChildAdapter } from "../process/supervisor/adapters/child.js";
import {
  completeWorkerLaunchDescriptor,
  parseWorkerLaunchPlan,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import { parseNodeWorkerConnectionFailureMessage } from "../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import { formatWorkerConnectionFailure } from "../worker/worker-connection-contract.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import { resolveNodeWorkerEntry } from "./node-worker-entry.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerLaunchReceipt,
  type NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import {
  createNodeWorkerCredentialScrubber,
  NODE_WORKER_STDERR_MAX_BYTES,
  NODE_WORKER_STDOUT_MAX_BYTES,
  parseNodeWorkerSuccessfulResult,
  sanitizeNodeWorkerDiagnostic,
  type NodeWorkerCredentialScrubber,
} from "./node-worker-output.js";
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
  inspectOwnedNodeWorkerTree,
  signalOwnedNodeWorkerTree,
  waitForOwnedNodeWorkerTreeDeath,
} from "./node-worker-tree-control.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

type ChildAdapter = Awaited<ReturnType<typeof createChildAdapter>>;
type StopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;
type ActiveBase = {
  launchId: string;
  planHash: string;
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity;
};
type RunningChild = ActiveBase & {
  state: "running";
  adapter: ChildAdapter;
  done: Promise<void>;
  journalReady: Promise<void>;
  releaseJournal: () => void;
  scrubber: NodeWorkerCredentialScrubber;
  connectionFailure: { errorText?: string };
  stopState?: StopState;
};
type TerminalOutcome = Readonly<{
  state: NodeWorkerTerminalState;
  resultJson?: string;
  errorText?: string;
}>;
type ObservedTerminal = ActiveBase & {
  state: "observed";
  outcome: TerminalOutcome;
  persistenceError?: unknown;
};
type ActiveOwnership = RunningChild | ObservedTerminal;
type NodeWorkerSupervisorOptions = {
  bundleRoot?: string;
  env?: NodeJS.ProcessEnv;
  capacity?: number;
  capacityWaitMs?: number;
  onAvailabilityChanged?: (available: boolean) => void;
  workspace?: NodeWorkerWorkspaceRuntime;
};

function sameProcessIdentity(
  left: NodeWorkerProcessIdentity | null,
  right: NodeWorkerProcessIdentity | null,
): boolean {
  return (
    left?.pid === right?.pid &&
    left?.startTime === right?.startTime &&
    (left !== null) === (right !== null)
  );
}

function receiptMatchesOwner(
  receipt: NodeWorkerLaunchReceipt,
  supervisor: NodeWorkerProcessIdentity,
  worker: NodeWorkerProcessIdentity | null,
): boolean {
  return (
    sameProcessIdentity(receipt.supervisor, supervisor) &&
    sameProcessIdentity(receipt.worker, worker)
  );
}

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, ActiveOwnership>();
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly bundleRoot: string;
  private readonly store: NodeWorkerLaunchStore;
  private readonly workerEnv: NodeJS.ProcessEnv;
  private readonly capacity: NodeWorkerCapacity;
  private readonly workspace: NodeWorkerWorkspaceRuntime;
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
    this.workspace =
      options.workspace ??
      new NodeWorkerWorkspaceRuntime({ root: this.bundleRoot, env: this.workerEnv });
    this.capacity = new NodeWorkerCapacity(this.store, options);
  }

  private requireSupervisorIdentity(): NodeWorkerProcessIdentity {
    return (this.supervisorIdentity ??= requireNodeWorkerProcessIdentity(process.pid));
  }

  initialize(): Promise<void> {
    return (this.initializationPromise ??= this.capacity.initialize(async (receipt) => {
      await this.recoverRunning(receipt, false);
    }));
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
    if (descriptor.admission.handshake.bundleHash !== input.expectedBundleHash) {
      throw new Error("node worker descriptor bundle hash does not match the launch bundle");
    }
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
    const supervisor = this.requireSupervisorIdentity();
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
        !receiptMatchesOwner(receipt, active.supervisor, active.worker)
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
      const cancelled = this.capacity.finishCancelled({
        expected,
        supervisor: receipt.supervisor,
        worker: null,
      });
      await startup;
      return this.store.getMatching(expected) ?? cancelled;
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
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return receipt;
    }
    if (workerState === "live") {
      const beforeSignal = this.store.getMatching(expected);
      if (
        beforeSignal?.state !== "running" ||
        !receiptMatchesOwner(beforeSignal, receipt.supervisor, receipt.worker)
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
        !receiptMatchesOwner(beforeSignal, receipt.supervisor, receipt.worker)
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
          .filter((active): active is RunningChild => active.state === "running")
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

  private reconcileActiveTerminal(active: ObservedTerminal): NodeWorkerLaunchReceipt {
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
    if (receipt.state !== "running" || !receipt.worker) {
      return receipt;
    }
    const previousSupervisor = inspectNodeWorkerProcessIdentity(receipt.supervisor);
    if (previousSupervisor !== "dead" && previousSupervisor !== "reused") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    if (workerState === "live") {
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
    }
    if (workerState !== "dead") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    return this.capacity.finish(
      {
        launchId: receipt.launchId,
        planHash: receipt.planHash,
        supervisor: receipt.supervisor,
        worker: receipt.worker,
        state: "interrupted",
        errorText: "node host stopped before the worker launch completed",
      },
      notifyCapacity,
    );
  }

  private async startClaimed(params: {
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
  }): Promise<NodeWorkerLaunchReceipt> {
    const credential = params.descriptor.admission.credential;
    const scrubber = createNodeWorkerCredentialScrubber(credential);
    // Turn cancellation can beat the child's admission retry deadline. Retain the
    // producer's latest cause so the durable terminal receipt does not become generic.
    const connectionFailure: { errorText?: string } = {};
    registerSecretValueForRedaction(credential);
    let adapter: ChildAdapter;
    try {
      const entry = resolveNodeWorkerEntry({
        bundleRoot: this.bundleRoot,
        expectedBundleHash: params.input.expectedBundleHash,
        gatewayNamespace: params.input.gatewayNamespace,
      });
      adapter = await createChildAdapter({
        argv: [process.execPath, entry, "--internal-worker-ipc"],
        env: this.workerEnv,
        exactEnv: true,
        ownedWorker: true,
        onWorkerMessage: (message) => {
          const diagnostic = parseNodeWorkerConnectionFailureMessage(message);
          if (!diagnostic) {
            return;
          }
          connectionFailure.errorText = diagnostic.cause
            ? formatWorkerConnectionFailure(
                params.descriptor.connectionEndpoint,
                sanitizeNodeWorkerDiagnostic(
                  diagnostic.cause,
                  "node worker gateway connection failed",
                  scrubber.scrub,
                ),
              )
            : undefined;
        },
        input: JSON.stringify(params.descriptor),
      });
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
    let journalReleased = false;
    let releaseJournalPromise!: () => void;
    const journalReady = new Promise<void>((resolve) => {
      releaseJournalPromise = resolve;
    });
    const releaseJournal = () => {
      if (!journalReleased) {
        journalReleased = true;
        releaseJournalPromise();
      }
    };
    const active = {
      state: "running",
      adapter,
      journalReady,
      launchId: params.input.launchId,
      planHash: params.planHash,
      releaseJournal,
      scrubber,
      connectionFailure,
      supervisor: params.supervisor,
      worker,
    } as RunningChild;
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
      });
    } catch (error) {
      active.releaseJournal();
      await this.stopChild(active, "interrupted").catch(() => undefined);
      throw error;
    }
    active.releaseJournal();
    if (running.state === "cancelled" || running.state === "interrupted") {
      await this.stopChild(active, running.state);
      return this.store.get(active.launchId) ?? running;
    }
    if (running.state !== "running") {
      adapter.closeStartGate?.();
      return running;
    }
    if (this.closed) {
      await this.stopChild(active, "interrupted");
      return this.store.get(active.launchId) ?? running;
    }
    try {
      await adapter.openStartGate?.();
    } catch {
      await this.stopChild(active, "interrupted");
      return this.store.get(active.launchId) ?? running;
    }
    return running;
  }

  private async observeChild(active: RunningChild): Promise<void> {
    const stdout = createCapturedOutputBuffers();
    const stderr = createCapturedOutputBuffers();
    active.adapter.onStdout((chunk) =>
      appendCapturedOutput(stdout, chunk, NODE_WORKER_STDOUT_MAX_BYTES, "head"),
    );
    active.adapter.onStderr((chunk) =>
      appendCapturedOutput(
        stderr,
        chunk,
        NODE_WORKER_STDERR_MAX_BYTES + active.scrubber.maxRepresentationBytes,
        "tail",
      ),
    );
    let outcome: TerminalOutcome;
    try {
      const exit = await active.adapter.wait();
      await active.journalReady;
      if (active.stopState) {
        outcome = Object.freeze({
          state: active.stopState,
          errorText:
            active.connectionFailure.errorText ??
            (active.stopState === "cancelled"
              ? "node worker launch cancelled"
              : "node worker launch interrupted during node-host shutdown"),
        });
      } else if (exit.code === 0 && exit.signal === null) {
        try {
          outcome = Object.freeze({
            state: "completed",
            resultJson: parseNodeWorkerSuccessfulResult(stdout, active.scrubber.scrub),
          });
        } catch (error) {
          outcome = Object.freeze({
            state: "failed",
            errorText: sanitizeNodeWorkerDiagnostic(
              error,
              "invalid worker result",
              active.scrubber.scrub,
            ),
          });
        }
      } else {
        const detail = finalizeCapturedOutput(stderr, "tail", true).toString("utf8");
        const exitLabel = exit.signal ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
        outcome = Object.freeze({
          state: "failed",
          errorText:
            active.connectionFailure.errorText ??
            sanitizeNodeWorkerDiagnostic(
              `node worker failed with ${exitLabel}${detail ? `: ${detail}` : ""}`,
              "node worker failed",
              active.scrubber.scrub,
            ),
        });
      }
    } catch (error) {
      await active.journalReady;
      outcome = Object.freeze({
        state: active.stopState ?? "failed",
        errorText:
          active.connectionFailure.errorText ??
          sanitizeNodeWorkerDiagnostic(error, "node worker wait failed", active.scrubber.scrub),
      });
    } finally {
      active.adapter.dispose();
    }
    const observed: ObservedTerminal = {
      state: "observed",
      launchId: active.launchId,
      planHash: active.planHash,
      supervisor: active.supervisor,
      worker: active.worker,
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

  private async stopChild(active: RunningChild, state: StopState): Promise<void> {
    active.stopState ??= state;
    active.adapter.kill("SIGTERM");
    const forceKill = setTimeout(() => active.adapter.kill("SIGKILL"), STOP_GRACE_MS);
    forceKill.unref?.();
    try {
      await active.done;
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
