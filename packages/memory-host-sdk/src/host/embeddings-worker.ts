// Memory Host SDK module implements embeddings worker behavior.
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { stableHomebrewNodePathCandidates } from "@openclaw/normalization-core/stable-node-path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_LOCAL_MODEL } from "./embedding-defaults.js";
import {
  createLocalEmbeddingWorkerFailureError,
  LOCAL_EMBEDDING_WORKER_ERROR_CODES,
} from "./embedding-worker-errors.js";
import type { LocalEmbeddingProviderRuntimeOptions } from "./embeddings.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderCallOptions,
  EmbeddingProviderOptions,
} from "./embeddings.types.js";
import {
  attachLocalEmbeddingRuntimeFacts,
  type LocalEmbeddingRuntimeFacts,
} from "./local-embedding-runtime-facts.js";

// Parent-side local embedding worker client for isolating node-llama-cpp state.

/** Request payloads sent from the parent process to the local embedding worker child. */
type LocalEmbeddingWorkerRequestPayload =
  | {
      type: "initialize";
      options: EmbeddingProviderOptions;
    }
  | {
      type: "embedQuery";
      options: EmbeddingProviderOptions;
      text: string;
    }
  | {
      type: "embedBatch";
      options: EmbeddingProviderOptions;
      texts: string[];
    }
  | {
      type: "close";
    };

type LocalEmbeddingWorkerRequest = LocalEmbeddingWorkerRequestPayload & { id: number };

/** Response payloads sent from the local embedding worker child back to the parent. */
type LocalEmbeddingWorkerResponse =
  | {
      id: number;
      ok: true;
      value?: number[] | number[][];
      runtimeFacts?: LocalEmbeddingRuntimeFacts;
    }
  | {
      id: number;
      ok: false;
      runtimeFacts?: LocalEmbeddingRuntimeFacts;
      error:
        | string
        | {
            message?: string;
            code?: string;
          };
    };

/** Pending parent request plus abort cleanup. */
type PendingRequest = {
  resolve: (value: number[] | number[][] | undefined) => void;
  reject: (err: unknown) => void;
  abort?: () => void;
};

/** Resolve the worker child script for source, package, and bundled runtime layouts. */
function resolveDefaultWorkerScriptPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentPath);
  const currentName = path.basename(currentPath);
  const sibling =
    extension === ".ts"
      ? "embeddings-worker-child.ts"
      : currentName.startsWith("embeddings-worker.")
        ? "embeddings-worker-child.js"
        : "memory-core-local-embedding-worker.js";
  return path.join(path.dirname(currentPath), sibling);
}

/** Keep only local embedding options that are safe and necessary to send over IPC. */
function serializeLocalEmbeddingOptions(
  options: EmbeddingProviderOptions,
  runtimeOptions?: LocalEmbeddingProviderRuntimeOptions,
): EmbeddingProviderOptions {
  return {
    config: {},
    provider: "local",
    model: options.model,
    fallback: "none",
    outputDimensionality: options.outputDimensionality,
    local: {
      ...options.local,
      ...(runtimeOptions?.nodeLlamaCppImportUrl
        ? { nodeLlamaCppImportUrl: runtimeOptions.nodeLlamaCppImportUrl }
        : {}),
    } as EmbeddingProviderOptions["local"],
  };
}

/** Create a typed failure for unexpected worker process exits. */
function createWorkerExitError(code: number | null, signal: NodeJS.Signals | null): Error {
  const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  return createLocalEmbeddingWorkerFailureError({
    message: `Local embedding worker exited unexpectedly (${detail})`,
    code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.exited,
    reason: signal ? "signal" : "exit",
    exitCode: code,
    signal,
  });
}

function createWorkerShutdownError(): Error {
  return createLocalEmbeddingWorkerFailureError({
    message: "Local embedding worker exited unexpectedly (shutdown)",
    code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.exited,
    reason: "exit",
  });
}

/** Convert worker response errors into Error objects while preserving worker error codes. */
function createWorkerResponseError(error: LocalEmbeddingWorkerResponse & { ok: false }): Error {
  if (typeof error.error === "object" && error.error) {
    const message = error.error.message || "Local embedding worker failed";
    const workerError = new Error(message) as Error & { code?: string };
    if (error.error.code) {
      workerError.code = error.error.code;
    }
    return workerError;
  }
  return new Error(error.error || "Local embedding worker failed");
}

const WORKER_UNSAFE_EXEC_ARGV_FLAGS = new Set(["--inspect", "--inspect-brk"]);

const WORKER_UNSAFE_EXEC_ARGV_FLAGS_WITH_VALUE = new Set([
  "--eval",
  "-e",
  "--print",
  "-p",
  "--input-type",
  "--inspect-port",
]);

const WORKER_UNSAFE_EXEC_ARGV_OPTION_PREFIXES = [
  "--eval=",
  "--print=",
  "--input-type=",
  "--inspect=",
  "--inspect-brk=",
  "--inspect-port=",
];

const WORKER_CLOSE_GRACE_MS = 250;

type WorkerTerminationWaitResult = {
  terminated: boolean;
  error?: unknown;
};

/** Wait for a confirmed terminal child event while remembering process errors. */
async function waitForWorkerTermination(
  child: ChildProcess,
  timeoutMs: number,
): Promise<WorkerTerminationWaitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { terminated: true };
  }
  return await new Promise<WorkerTerminationWaitResult>((resolve) => {
    let processError: unknown;
    const cleanup = () => {
      child.off("exit", onTerminated);
      child.off("close", onTerminated);
      child.off("error", onError);
      clearTimeout(timeout);
    };
    const settle = (result: WorkerTerminationWaitResult) => {
      cleanup();
      resolve(result);
    };
    const onTerminated = () => settle({ terminated: true });
    const onError = (err: unknown) => {
      processError ??= err;
    };
    child.once("exit", onTerminated);
    child.once("close", onTerminated);
    child.on("error", onError);
    const timeout = setTimeout(() => settle({ terminated: false, error: processError }), timeoutMs);
    timeout.unref?.();
  });
}

/** Send a worker signal without letting synchronous or reported failures hang shutdown. */
function signalWorker(child: ChildProcess, signal: NodeJS.Signals): unknown {
  try {
    if (!child.kill(signal)) {
      return new Error(`Failed to send ${signal} to local embedding worker`);
    }
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Drop execArgv flags that would make forked workers debug/eval stateful or unsafe. */
function resolveWorkerExecArgv(): string[] {
  const args: string[] = [];
  let skipNext = false;
  for (const arg of process.execArgv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (WORKER_UNSAFE_EXEC_ARGV_FLAGS.has(arg)) {
      continue;
    }
    if (WORKER_UNSAFE_EXEC_ARGV_FLAGS_WITH_VALUE.has(arg)) {
      skipNext = true;
      continue;
    }
    if (WORKER_UNSAFE_EXEC_ARGV_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    args.push(arg);
  }
  return args;
}

async function resolveWorkerExecPath(nodePath: string): Promise<string> {
  for (const candidate of stableHomebrewNodePathCandidates(nodePath)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next Homebrew-managed stable path.
    }
  }
  return nodePath;
}

/** IPC client that serializes local embedding calls through one child process. */
class LocalEmbeddingWorkerClient {
  private child: ChildProcess | null = null;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private requestTail: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private lastRuntimeFacts: LocalEmbeddingRuntimeFacts | undefined;

  constructor(
    private readonly scriptPath: string,
    private readonly execPath: string,
  ) {}

  /** Start or reuse the child worker and initialize its provider. */
  async initialize(options: EmbeddingProviderOptions): Promise<void> {
    await this.send({ type: "initialize", options });
  }

  /** Request one query embedding from the child worker. */
  async embedQuery(
    options: EmbeddingProviderOptions,
    text: string,
    callOptions?: EmbeddingProviderCallOptions,
  ): Promise<number[]> {
    const result = await this.enqueueRequest({ type: "embedQuery", options, text }, callOptions);
    return Array.isArray(result) ? (result as number[]) : [];
  }

  /** Request a batch of embeddings from the child worker. */
  async embedBatch(
    options: EmbeddingProviderOptions,
    texts: string[],
    callOptions?: EmbeddingProviderCallOptions,
  ): Promise<number[][]> {
    const result = await this.enqueueRequest({ type: "embedBatch", options, texts }, callOptions);
    return Array.isArray(result) ? (result as number[][]) : [];
  }

  getRuntimeFacts(): LocalEmbeddingRuntimeFacts | undefined {
    return this.lastRuntimeFacts;
  }

  /** Ask the child to close gracefully, then force shutdown after a short grace period. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.shutdownPromise;
      if (this.child) {
        await this.shutdownChild();
      }
      return;
    }
    this.closed = true;
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }
    const child = this.child;
    if (!child) {
      return;
    }
    if (!child.connected) {
      await this.shutdownChild();
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    const closeRequest = this.send({ type: "close" }, undefined, true).then(
      () => "closed" as const,
    );
    const closeTimeout = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), WORKER_CLOSE_GRACE_MS);
      timeout.unref?.();
    });
    let gracefulCloseError: unknown;
    try {
      const result = await Promise.race([closeRequest, closeTimeout]);
      if (result === "timeout") {
        closeRequest.catch(() => {});
      }
    } catch (err) {
      gracefulCloseError = err;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      await this.shutdownChild();
    }
    if (gracefulCloseError) {
      process.emitWarning(
        toErrorObject(gracefulCloseError, "Local embedding worker graceful close failed"),
        { code: "LOCAL_EMBEDDING_WORKER_CLOSE" },
      );
    }
  }

  /** Ensure the child process exists and has lifecycle failure handlers installed. */
  private ensureChild(): ChildProcess {
    const current = this.child;
    if (current) {
      if (current.connected) {
        return current;
      }
      if (current.exitCode === null && current.signalCode === null) {
        throw new Error("Local embedding worker IPC disconnected before process termination");
      }
      this.child = null;
    }

    const child = fork(this.scriptPath, [], {
      execPath: this.execPath,
      execArgv: resolveWorkerExecArgv(),
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("message", (message) => this.handleMessage(message));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      this.rejectPending(createWorkerExitError(code, signal));
    });
    child.on("close", () => {
      // Spawn failures can close without an exit event. Close is terminal, so
      // the next request may safely create a replacement worker.
      if (this.child === child) {
        this.child = null;
      }
    });
    child.on("error", (err) => {
      // An error does not guarantee that the process exited. Keep the handle so
      // close can retry termination instead of spawning beside an unknown child.
      this.rejectPending(
        createLocalEmbeddingWorkerFailureError({
          message: `Local embedding worker process failed: ${err.message}`,
          code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.processError,
          reason: "process-error",
          cause: err,
        }),
      );
    });
    this.child = child;
    return child;
  }

  /** Serialize native work without letting a queued cancellation kill the active child. */
  private async enqueueRequest(
    request: LocalEmbeddingWorkerRequestPayload,
    options?: EmbeddingProviderCallOptions,
  ): Promise<number[] | number[][] | undefined> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const queuedDuringShutdown = this.shutdownPromise !== null;

    // The child also serializes native work, so queued requests must remain in
    // the parent until they own the worker and can safely terminate it on abort.
    const operation = this.requestTail.then(async () => {
      signal?.throwIfAborted();
      // Work submitted after active cancellation must join its shutdown before
      // observing close; work already queued when close begins gets worker exit.
      if (this.closed && !queuedDuringShutdown) {
        throw createWorkerShutdownError();
      }
      return await this.send(request, options);
    });
    this.requestTail = operation.then(
      () => undefined,
      () => undefined,
    );

    if (!signal) {
      return await operation;
    }

    return await new Promise((resolve, reject) => {
      const abort = () => {
        reject(
          toErrorObject(
            signal.reason ?? new Error("Local embedding request aborted"),
            "Non-Error rejection",
          ),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      void operation.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(toErrorObject(error, "Local embedding request failed"));
        },
      );
    });
  }

  /** Send one request over IPC and bind its abort signal to child shutdown. */
  private async send(
    request: LocalEmbeddingWorkerRequestPayload,
    options?: EmbeddingProviderCallOptions,
    allowClosed = false,
  ): Promise<number[] | number[][] | undefined> {
    while (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    if (this.child && !this.child.connected) {
      await this.shutdownChild();
    }
    if (this.closed && !allowClosed) {
      throw new Error("Local embedding worker client has been closed");
    }
    options?.signal?.throwIfAborted();
    const child = this.ensureChild();
    const id = this.nextRequestId++;
    const payload = { ...request, id } as LocalEmbeddingWorkerRequest;
    return await new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (options?.signal) {
        const abort = () => {
          this.pending.delete(id);
          void this.shutdownChild();
          reject(
            toErrorObject(
              options.signal?.reason ?? new Error("Local embedding request aborted"),
              "Non-Error rejection",
            ),
          );
        };
        options.signal.addEventListener("abort", abort, { once: true });
        pending.abort = () => options.signal?.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
      child.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          pending.abort?.();
          reject(
            createLocalEmbeddingWorkerFailureError({
              message: `Local embedding worker IPC failed: ${err.message}`,
              code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.ipcError,
              reason: "ipc",
              cause: err,
            }),
          );
        }
      });
    });
  }

  /** Route one worker response to the matching pending request. */
  private handleMessage(message: unknown): void {
    const response = message as Partial<LocalEmbeddingWorkerResponse>;
    if (typeof response.id !== "number") {
      return;
    }
    if (response.runtimeFacts) {
      this.lastRuntimeFacts = response.runtimeFacts;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    pending.abort?.();
    if (response.ok) {
      pending.resolve(response.value);
      return;
    }
    pending.reject(
      createWorkerResponseError(response as LocalEmbeddingWorkerResponse & { ok: false }),
    );
  }

  /** Disconnect and kill the current child process if it is still alive. */
  private shutdownChild(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    const shutdown = this.stopChild(child).then(
      () => {
        if (this.child === child) {
          this.child = null;
        }
      },
      (err: unknown) => {
        // A failed termination leaves ownership with this client. Prevent any
        // later request from starting a replacement until close succeeds.
        this.closed = true;
        throw err;
      },
    );
    this.shutdownPromise = shutdown;
    const clearShutdown = () => {
      if (this.shutdownPromise === shutdown) {
        this.shutdownPromise = null;
      }
    };
    void shutdown.then(clearShutdown, clearShutdown);
    return shutdown;
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    this.rejectPending(createWorkerShutdownError());
    if (child.connected) {
      child.disconnect();
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const gracefulWait = waitForWorkerTermination(child, WORKER_CLOSE_GRACE_MS);
    const gracefulSignalError = signalWorker(child, "SIGTERM");
    const gracefulResult = await gracefulWait;
    if (gracefulResult.terminated) {
      return;
    }
    const forcedWait = waitForWorkerTermination(child, WORKER_CLOSE_GRACE_MS);
    const forcedSignalError = signalWorker(child, "SIGKILL");
    const forcedResult = await forcedWait;
    if (forcedResult.terminated) {
      return;
    }
    throw createLocalEmbeddingWorkerFailureError({
      message: "Local embedding worker did not exit after SIGKILL",
      code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.processError,
      reason: "process-error",
      cause: forcedResult.error ?? forcedSignalError ?? gracefulResult.error ?? gracefulSignalError,
    });
  }

  /** Reject all pending requests after child process failure. */
  private rejectPending(err: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.abort?.();
      entry.reject(err);
    }
  }
}

const RETAINED_WORKER_CLIENTS = new Set<LocalEmbeddingWorkerClient>();
const RETAINED_WORKER_DRAIN_RETRY_MS = 1_000;
let workerProviderCreationTail: Promise<void> = Promise.resolve();
let retainedWorkerDrainPromise: Promise<void> | null = null;
let retainedWorkerDrainTimer: NodeJS.Timeout | null = null;

async function drainRetainedWorkerClientsNow(): Promise<void> {
  let firstError: unknown;
  let closeFailed = false;
  for (const client of RETAINED_WORKER_CLIENTS) {
    try {
      await client.close();
      RETAINED_WORKER_CLIENTS.delete(client);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw firstError;
  }
}

function scheduleRetainedWorkerDrain(): void {
  if (RETAINED_WORKER_CLIENTS.size === 0 || retainedWorkerDrainTimer) {
    return;
  }
  retainedWorkerDrainTimer = setTimeout(() => {
    retainedWorkerDrainTimer = null;
    void drainRetainedWorkerClients().catch(() => {});
  }, RETAINED_WORKER_DRAIN_RETRY_MS);
  retainedWorkerDrainTimer.unref?.();
}

async function drainRetainedWorkerClients(): Promise<void> {
  if (retainedWorkerDrainPromise) {
    return await retainedWorkerDrainPromise;
  }
  if (retainedWorkerDrainTimer) {
    clearTimeout(retainedWorkerDrainTimer);
    retainedWorkerDrainTimer = null;
  }
  const drain = drainRetainedWorkerClientsNow();
  retainedWorkerDrainPromise = drain;
  const settle = () => {
    if (retainedWorkerDrainPromise === drain) {
      retainedWorkerDrainPromise = null;
    }
    scheduleRetainedWorkerDrain();
  };
  void drain.then(settle, settle);
  return await drain;
}

/** Create the public local embedding provider backed by the child worker client. */
export async function createLocalEmbeddingWorkerProvider(
  options: EmbeddingProviderOptions,
  runtimeOptions?: LocalEmbeddingProviderRuntimeOptions,
): Promise<EmbeddingProvider> {
  const create = async () => {
    await drainRetainedWorkerClients();
    return await createLocalEmbeddingWorkerProviderOnce(options, runtimeOptions);
  };
  const creation = workerProviderCreationTail.then(create, create);
  workerProviderCreationTail = creation.then(
    () => undefined,
    () => undefined,
  );
  return await creation;
}

async function createLocalEmbeddingWorkerProviderOnce(
  options: EmbeddingProviderOptions,
  runtimeOptions?: LocalEmbeddingProviderRuntimeOptions,
): Promise<EmbeddingProvider> {
  const modelPath = normalizeOptionalString(options.local?.modelPath) || DEFAULT_LOCAL_MODEL;
  const workerOptions = serializeLocalEmbeddingOptions(options, runtimeOptions);
  // Resolve before constructing the client so worker restarts stay synchronous.
  // The stable Homebrew symlink can retarget without changing this stored path.
  const workerExecPath = await resolveWorkerExecPath(process.execPath);
  const client = new LocalEmbeddingWorkerClient(
    runtimeOptions?.workerScriptPath ?? resolveDefaultWorkerScriptPath(),
    workerExecPath,
  );
  try {
    await client.initialize(workerOptions);
  } catch (err) {
    try {
      await client.close();
    } catch {
      RETAINED_WORKER_CLIENTS.add(client);
      scheduleRetainedWorkerDrain();
    }
    throw err;
  }
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const throwIfClosed = () => {
    if (closed) {
      throw new Error("Local embedding provider has been closed");
    }
  };

  const provider: EmbeddingProvider = {
    id: "local",
    model: modelPath,
    embedQuery: async (text, callOptions) => {
      throwIfClosed();
      return await client.embedQuery(workerOptions, text, callOptions);
    },
    embedBatch: async (texts, callOptions) => {
      throwIfClosed();
      return await client.embedBatch(workerOptions, texts, callOptions);
    },
    close: async () => {
      if (!closePromise) {
        closed = true;
        closePromise = client.close();
      }
      const pendingClose = closePromise;
      try {
        await pendingClose;
        RETAINED_WORKER_CLIENTS.delete(client);
      } catch (err) {
        if (closePromise === pendingClose) {
          closePromise = null;
        }
        RETAINED_WORKER_CLIENTS.add(client);
        scheduleRetainedWorkerDrain();
        throw err;
      }
    },
  };
  attachLocalEmbeddingRuntimeFacts(provider, () => client.getRuntimeFacts());
  return provider;
}
