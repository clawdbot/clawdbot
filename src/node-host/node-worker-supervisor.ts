import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  redactRegisteredSecretValues,
  registerSecretValueForRedaction,
} from "../logging/secret-redaction-registry.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../process/exec-output.js";
import { createChildAdapter } from "../process/supervisor/adapters/child.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerLaunchReceipt,
  type NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
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

const STDOUT_MAX_BYTES = 64 * 1024;
const STDERR_MAX_BYTES = 4 * 1024;
const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

type ChildAdapter = Awaited<ReturnType<typeof createChildAdapter>>;
type StopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;
type CredentialScrubber = {
  maxRepresentationBytes: number;
  scrub: (text: string) => string;
};
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
  scrubber: CredentialScrubber;
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

function resolveWorkerEntry(params: {
  bundleRoot: string;
  bundleHash: string;
  gatewayNamespace: string;
}): string {
  const root = fs.realpathSync.native(params.bundleRoot);
  const bundle = fs.realpathSync.native(
    path.join(root, params.gatewayNamespace, "bundles", params.bundleHash),
  );
  if (!isPathInside(root, bundle)) {
    throw new Error("node worker bundle resolves outside its configured root");
  }
  const entry = fs.realpathSync.native(path.join(bundle, "openclaw.mjs"));
  if (!isPathInside(bundle, entry) || !fs.statSync(entry).isFile()) {
    throw new Error("node worker entry must be a regular file inside its bundle");
  }
  return entry;
}

function createCredentialScrubber(credential: string): CredentialScrubber {
  const representations = new Set([
    credential,
    encodeURIComponent(credential),
    JSON.stringify(credential).slice(1, -1),
  ]);
  const ordered = [...representations].toSorted((left, right) => right.length - left.length);
  return {
    maxRepresentationBytes: Math.max(
      ...ordered.map((representation) => Buffer.byteLength(representation, "utf8")),
    ),
    scrub: (text) => {
      let scrubbed = text;
      for (const representation of ordered) {
        scrubbed = scrubbed.replaceAll(representation, "[REDACTED]");
      }
      return scrubbed;
    },
  };
}

function redactLaunchText(value: string, scrubCredential: (text: string) => string): string {
  const launchRedacted = scrubCredential(value);
  const exactRedacted = redactRegisteredSecretValues(launchRedacted, () => "[REDACTED]");
  return redactToolPayloadText(exactRedacted);
}

function sanitizeDiagnostic(
  value: string,
  fallback: string,
  scrubCredential: (text: string) => string,
): string {
  const oneLine = redactLaunchText(value, scrubCredential).replace(/\s+/gu, " ").trim();
  return truncateUtf8Suffix(oneLine || fallback, STDERR_MAX_BYTES);
}

function successfulResult(
  stdout: ReturnType<typeof createCapturedOutputBuffers>,
  scrubCredential: (text: string) => string,
): string {
  if (stdout.truncatedBytes > 0) {
    throw new Error(`worker stdout exceeded ${STDOUT_MAX_BYTES} bytes`);
  }
  const raw = finalizeCapturedOutput(stdout, "head", true).toString("utf8").trim();
  const redacted = redactLaunchText(raw, scrubCredential);
  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted) as unknown;
  } catch (error) {
    throw new Error("worker returned invalid JSON output", { cause: error });
  }
  const result = JSON.stringify(parsed);
  if (Buffer.byteLength(result, "utf8") > STDOUT_MAX_BYTES) {
    throw new Error(`worker result exceeded ${STDOUT_MAX_BYTES} bytes`);
  }
  return result;
}

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
  private supervisorIdentity?: NodeWorkerProcessIdentity;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: { bundleRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    this.bundleRoot = path.resolve(
      options.bundleRoot ?? path.join(resolveStateDir(env), "node-host"),
    );
    this.store = new NodeWorkerLaunchStore({ env });
    this.workerEnv = snapshotNodeWorkerEnv(env);
  }

  private requireSupervisorIdentity(): NodeWorkerProcessIdentity {
    return (this.supervisorIdentity ??= requireNodeWorkerProcessIdentity(process.pid));
  }

  async launch(input: NodeWorkerLaunchInput): Promise<NodeWorkerLaunchReceipt> {
    if (!GATEWAY_NAMESPACE_PATTERN.test(input.gatewayNamespace)) {
      throw new Error("gateway namespace must be a safe bounded path component");
    }
    if (!BUNDLE_HASH_PATTERN.test(input.bundleHash)) {
      throw new Error("node worker bundle hash must be 64 lowercase hexadecimal characters");
    }
    if (!Number.isSafeInteger(input.placementGeneration) || input.placementGeneration < 0) {
      throw new Error("node worker placement generation must be a non-negative safe integer");
    }
    const descriptor = parseWorkerLaunchDescriptor(structuredClone(input.descriptor));
    if (descriptor.admission.handshake.bundleHash !== input.bundleHash) {
      throw new Error("node worker descriptor bundle hash does not match the launch bundle");
    }
    const planHash = nodeWorkerPlanHash({
      bundleHash: input.bundleHash,
      descriptor,
      gatewayNamespace: input.gatewayNamespace,
      placementGeneration: input.placementGeneration,
    });
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
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    const supervisor = this.requireSupervisorIdentity();
    const claim = this.store.claim(
      {
        launchId: input.launchId,
        planHash,
        gatewayNamespace: input.gatewayNamespace,
        environmentId: descriptor.admission.environmentId,
        sessionId: descriptor.admission.sessionId,
        ownerEpoch: descriptor.admission.ownerEpoch,
        placementGeneration: input.placementGeneration,
        runId: descriptor.assignment.runId,
      },
      supervisor,
    );
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
    const active = this.active.get(launchId);
    if (active?.state === "observed") {
      return this.reconcileActiveTerminal(active);
    }
    return this.store.get(launchId);
  }

  async cancel(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
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
      const cancelled = this.store.finishCancelled({
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
      return this.store.finishCancelled({
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
    return this.store.finishCancelled({
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
    const operation = (async () => {
      await Promise.allSettled(this.starting.values());
      await Promise.all(
        [...this.active.values()]
          .filter((active): active is RunningChild => active.state === "running")
          .map(async (active) => await this.stopChild(active, "interrupted")),
      );
      const errors: unknown[] = [];
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
      const receipt = this.store.finish({
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

  private async recoverRunning(receipt: NodeWorkerLaunchReceipt): Promise<NodeWorkerLaunchReceipt> {
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
    return this.store.finish({
      launchId: receipt.launchId,
      planHash: receipt.planHash,
      supervisor: receipt.supervisor,
      worker: receipt.worker,
      state: "interrupted",
      errorText: "node host stopped before the worker launch completed",
    });
  }

  private async startClaimed(params: {
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
  }): Promise<NodeWorkerLaunchReceipt> {
    const credential = params.descriptor.admission.credential;
    const scrubber = createCredentialScrubber(credential);
    registerSecretValueForRedaction(credential);
    let adapter: ChildAdapter;
    try {
      const entry = resolveWorkerEntry({
        bundleRoot: this.bundleRoot,
        bundleHash: params.input.bundleHash,
        gatewayNamespace: params.input.gatewayNamespace,
      });
      adapter = await createChildAdapter({
        argv: [process.execPath, entry, "worker", "--internal-worker-ipc"],
        env: this.workerEnv,
        exactEnv: true,
        ownedWorker: true,
        input: JSON.stringify(params.descriptor),
      });
    } catch (error) {
      return this.store.finish({
        launchId: params.input.launchId,
        planHash: params.planHash,
        supervisor: params.supervisor,
        worker: null,
        state: "failed",
        errorText: sanitizeDiagnostic(
          formatErrorMessage(error),
          "node worker spawn failed",
          scrubber.scrub,
        ),
      });
    }
    if (!adapter.pid) {
      adapter.kill("SIGKILL");
      adapter.dispose();
      return this.store.finish({
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
      return this.store.finish({
        launchId: params.input.launchId,
        planHash: params.planHash,
        supervisor: params.supervisor,
        worker: null,
        state: "failed",
        errorText: sanitizeDiagnostic(
          formatErrorMessage(error),
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
      appendCapturedOutput(stdout, chunk, STDOUT_MAX_BYTES, "head"),
    );
    active.adapter.onStderr((chunk) =>
      appendCapturedOutput(
        stderr,
        chunk,
        STDERR_MAX_BYTES + active.scrubber.maxRepresentationBytes,
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
            active.stopState === "cancelled"
              ? "node worker launch cancelled"
              : "node worker launch interrupted during node-host shutdown",
        });
      } else if (exit.code === 0 && exit.signal === null) {
        try {
          outcome = Object.freeze({
            state: "completed",
            resultJson: successfulResult(stdout, active.scrubber.scrub),
          });
        } catch (error) {
          outcome = Object.freeze({
            state: "failed",
            errorText: sanitizeDiagnostic(
              formatErrorMessage(error),
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
          errorText: sanitizeDiagnostic(
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
        errorText: sanitizeDiagnostic(
          formatErrorMessage(error),
          "node worker wait failed",
          active.scrubber.scrub,
        ),
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
  options: {
    bundleRoot?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): NodeWorkerSupervisor {
  return new NodeWorkerSupervisor(options);
}
