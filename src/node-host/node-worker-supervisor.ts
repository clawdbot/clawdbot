import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stableStringify } from "@openclaw/normalization-core";
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
import { signalProcessTree } from "../process/kill-tree.js";
import { createChildAdapter } from "../process/supervisor/adapters/child.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
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

const STDOUT_MAX_BYTES = 64 * 1024;
const STDERR_MAX_BYTES = 4 * 1024;
const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;
const RECOVERY_POLL_MS = 25;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type NodeWorkerLaunchInput = {
  launchId: string;
  gatewayNamespace: string;
  bundleHash: string;
  placementGeneration: number;
  descriptor: WorkerLaunchDescriptor;
};

type ChildAdapter = Awaited<ReturnType<typeof createChildAdapter>>;
type StopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;
type OwnedTreeState = "live" | "dead" | "unknown";
type ActiveChild = {
  adapter: ChildAdapter;
  done: Promise<NodeWorkerLaunchReceipt>;
  journalReady: Promise<void>;
  launchId: string;
  planHash: string;
  releaseJournal: () => void;
  scrubCredential: (text: string) => string;
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity;
  stopState?: StopState;
};

function nodeWorkerPlanHash(params: {
  bundleHash: string;
  descriptor: WorkerLaunchDescriptor;
  gatewayNamespace: string;
  placementGeneration: number;
}): string {
  return createHash("sha256").update(stableStringify(params)).digest("hex");
}

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

function createCredentialScrubber(credential: string): (text: string) => string {
  const representations = new Set([
    credential,
    encodeURIComponent(credential),
    JSON.stringify(credential).slice(1, -1),
  ]);
  const ordered = [...representations].toSorted((left, right) => right.length - left.length);
  return (text) => {
    let scrubbed = text;
    for (const representation of ordered) {
      scrubbed = scrubbed.replaceAll(representation, "[REDACTED]");
    }
    return scrubbed;
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
  return truncateUtf8Prefix(oneLine || fallback, STDERR_MAX_BYTES);
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

function inspectPosixProcessGroup(pid: number): OwnedTreeState {
  try {
    process.kill(-pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "dead" : "unknown";
  }
}

function inspectOwnedWorkerTree(worker: NodeWorkerProcessIdentity): OwnedTreeState {
  const root = inspectNodeWorkerProcessIdentity(worker);
  if (root === "reused") {
    return "dead";
  }
  if (root === "live") {
    return "live";
  }
  if (root === "unknown") {
    return "unknown";
  }
  return process.platform === "win32" ? "dead" : inspectPosixProcessGroup(worker.pid);
}

async function signalOwnedWorkerTree(
  worker: NodeWorkerProcessIdentity,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  const root = inspectNodeWorkerProcessIdentity(worker);
  if (root === "reused" || root === "unknown") {
    return;
  }
  await new Promise<void>((resolve) => {
    signalProcessTree(worker.pid, signal, { detached: true, onComplete: resolve });
  });
}

async function waitForOwnedWorkerTreeDeath(
  worker: NodeWorkerProcessIdentity,
  timeoutMs: number,
): Promise<OwnedTreeState> {
  const deadline = Date.now() + timeoutMs;
  let state = inspectOwnedWorkerTree(worker);
  while (state === "live" && Date.now() < deadline) {
    await delay(RECOVERY_POLL_MS);
    state = inspectOwnedWorkerTree(worker);
  }
  return state;
}

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, ActiveChild>();
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly bundleRoot: string;
  private readonly store: NodeWorkerLaunchStore;
  private supervisorIdentity?: NodeWorkerProcessIdentity;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: { bundleRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    this.bundleRoot = path.resolve(
      options.bundleRoot ?? path.join(resolveStateDir(env), "node-host"),
    );
    this.store = new NodeWorkerLaunchStore({ env });
  }

  private requireSupervisorIdentity(): NodeWorkerProcessIdentity {
    return (this.supervisorIdentity ??= requireNodeWorkerProcessIdentity(process.pid));
  }

  async launch(input: NodeWorkerLaunchInput): Promise<NodeWorkerLaunchReceipt> {
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
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

  status(launchId: string): NodeWorkerLaunchReceipt | undefined {
    return this.store.get(launchId);
  }

  async cancel(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    const active = this.active.get(launchId);
    if (active) {
      await this.stopChild(active, "cancelled");
      return this.store.get(launchId);
    }
    const startup = this.starting.get(launchId);
    const receipt = this.store.get(launchId);
    if (!receipt || receipt.state === "completed" || receipt.state === "failed") {
      return receipt;
    }
    if (receipt.state === "interrupted" || receipt.state === "cancelled") {
      return receipt;
    }
    if (!startup || receipt.state !== "pending" || receipt.supervisor.pid !== process.pid) {
      return receipt;
    }
    const cancelled = this.store.finish({
      launchId,
      planHash: receipt.planHash,
      supervisor: this.requireSupervisorIdentity(),
      worker: null,
      state: "cancelled",
      errorText: "node worker launch cancelled",
    });
    await startup;
    return this.store.get(launchId) ?? cancelled;
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      await Promise.allSettled(this.starting.values());
      await Promise.all(
        [...this.active.values()].map(async (active) => {
          await this.stopChild(active, "interrupted");
        }),
      );
    })();
    return this.closePromise;
  }

  private async recoverRunning(receipt: NodeWorkerLaunchReceipt): Promise<NodeWorkerLaunchReceipt> {
    if (receipt.state !== "running" || !receipt.worker) {
      return receipt;
    }
    const previousSupervisor = inspectNodeWorkerProcessIdentity(receipt.supervisor);
    if (previousSupervisor !== "dead" && previousSupervisor !== "reused") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    let workerState = inspectOwnedWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    if (workerState === "live") {
      await signalOwnedWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      await signalOwnedWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
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
    const scrubCredential = createCredentialScrubber(credential);
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
          scrubCredential,
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
          scrubCredential,
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
      adapter,
      journalReady,
      launchId: params.input.launchId,
      planHash: params.planHash,
      releaseJournal,
      scrubCredential,
      supervisor: params.supervisor,
      worker,
    } as ActiveChild;
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

  private async observeChild(active: ActiveChild): Promise<NodeWorkerLaunchReceipt> {
    const stdout = createCapturedOutputBuffers();
    const stderr = createCapturedOutputBuffers();
    active.adapter.onStdout((chunk) =>
      appendCapturedOutput(stdout, chunk, STDOUT_MAX_BYTES, "head"),
    );
    active.adapter.onStderr((chunk) =>
      appendCapturedOutput(stderr, chunk, STDERR_MAX_BYTES, "tail"),
    );
    try {
      const exit = await active.adapter.wait();
      await active.journalReady;
      if (active.stopState) {
        return this.store.finish({
          launchId: active.launchId,
          planHash: active.planHash,
          supervisor: active.supervisor,
          worker: active.worker,
          state: active.stopState,
          errorText:
            active.stopState === "cancelled"
              ? "node worker launch cancelled"
              : "node worker launch interrupted during node-host shutdown",
        });
      }
      if (exit.code === 0 && exit.signal === null) {
        try {
          return this.store.finish({
            launchId: active.launchId,
            planHash: active.planHash,
            supervisor: active.supervisor,
            worker: active.worker,
            state: "completed",
            resultJson: successfulResult(stdout, active.scrubCredential),
          });
        } catch (error) {
          return this.store.finish({
            launchId: active.launchId,
            planHash: active.planHash,
            supervisor: active.supervisor,
            worker: active.worker,
            state: "failed",
            errorText: sanitizeDiagnostic(
              formatErrorMessage(error),
              "invalid worker result",
              active.scrubCredential,
            ),
          });
        }
      }
      const detail = finalizeCapturedOutput(stderr, "tail", true).toString("utf8");
      const exitLabel = exit.signal ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
      return this.store.finish({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: active.supervisor,
        worker: active.worker,
        state: "failed",
        errorText: sanitizeDiagnostic(
          `node worker failed with ${exitLabel}${detail ? `: ${detail}` : ""}`,
          "node worker failed",
          active.scrubCredential,
        ),
      });
    } catch (error) {
      await active.journalReady;
      return this.store.finish({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: active.supervisor,
        worker: active.worker,
        state: active.stopState ?? "failed",
        errorText: sanitizeDiagnostic(
          formatErrorMessage(error),
          "node worker wait failed",
          active.scrubCredential,
        ),
      });
    } finally {
      active.adapter.dispose();
      if (this.active.get(active.launchId) === active) {
        this.active.delete(active.launchId);
      }
    }
  }

  private async stopChild(active: ActiveChild, state: StopState): Promise<void> {
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
