import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { normalizeOptionalString } from "./string-utils.js";

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

type LocalEmbeddingWorkerResponse =
  | {
      id: number;
      ok: true;
      value?: number[] | number[][];
    }
  | {
      id: number;
      ok: false;
      error:
        | string
        | {
            message?: string;
            code?: string;
          };
    };

type PendingRequest = {
  resolve: (value: number[] | number[][] | undefined) => void;
  reject: (err: unknown) => void;
  abort?: () => void;
};

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

function serializeLocalEmbeddingOptions(
  options: EmbeddingProviderOptions,
): EmbeddingProviderOptions {
  return {
    config: {},
    provider: "local",
    model: options.model,
    fallback: "none",
    local: options.local,
  };
}

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

class LocalEmbeddingWorkerClient {
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly scriptPath: string) {}

  async initialize(options: EmbeddingProviderOptions): Promise<void> {
    await this.send({ type: "initialize", options });
  }

  async embedQuery(
    options: EmbeddingProviderOptions,
    text: string,
    callOptions?: EmbeddingProviderCallOptions,
  ): Promise<number[]> {
    const result = await this.send({ type: "embedQuery", options, text }, callOptions);
    return Array.isArray(result) ? (result as number[]) : [];
  }

  async embedBatch(
    options: EmbeddingProviderOptions,
    texts: string[],
    callOptions?: EmbeddingProviderCallOptions,
  ): Promise<number[][]> {
    const result = await this.send({ type: "embedBatch", options, texts }, callOptions);
    return Array.isArray(result) ? (result as number[][]) : [];
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    const closeRequest = this.send({ type: "close" }).then(() => "closed" as const);
    const closeTimeout = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), WORKER_CLOSE_GRACE_MS);
      timeout.unref?.();
    });
    try {
      const result = await Promise.race([closeRequest, closeTimeout]);
      if (result === "timeout") {
        closeRequest.catch(() => {});
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.shutdownChild();
    }
  }

  private ensureChild(): ChildProcess {
    if (this.child?.connected) {
      return this.child;
    }

    const child = fork(this.scriptPath, [], {
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
    child.on("error", (err) => {
      if (this.child === child) {
        this.child = null;
      }
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

  private async send(
    request: LocalEmbeddingWorkerRequestPayload,
    options?: EmbeddingProviderCallOptions,
  ): Promise<number[] | number[][] | undefined> {
    options?.signal?.throwIfAborted();
    const child = this.ensureChild();
    const id = this.nextRequestId++;
    const payload = { ...request, id } as LocalEmbeddingWorkerRequest;
    return await new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (options?.signal) {
        const abort = () => {
          this.pending.delete(id);
          this.shutdownChild();
          reject(options.signal?.reason ?? new Error("Local embedding request aborted"));
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

  private handleMessage(message: unknown): void {
    const response = message as Partial<LocalEmbeddingWorkerResponse>;
    if (typeof response.id !== "number") {
      return;
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

  private shutdownChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }
    if (child.connected) {
      child.disconnect();
    }
    if (!child.killed) {
      child.kill();
    }
  }

  private rejectPending(err: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.abort?.();
      entry.reject(err);
    }
  }
}

export async function createLocalEmbeddingWorkerProvider(
  options: EmbeddingProviderOptions,
  runtimeOptions?: LocalEmbeddingProviderRuntimeOptions,
): Promise<EmbeddingProvider> {
  const modelPath = normalizeOptionalString(options.local?.modelPath) || DEFAULT_LOCAL_MODEL;
  const workerOptions = serializeLocalEmbeddingOptions(options);
  const client = new LocalEmbeddingWorkerClient(
    runtimeOptions?.workerScriptPath ?? resolveDefaultWorkerScriptPath(),
  );
  try {
    await client.initialize(workerOptions);
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  let closed = false;

  const throwIfClosed = () => {
    if (closed) {
      throw new Error("Local embedding provider has been closed");
    }
  };

  return {
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
      if (closed) {
        return;
      }
      closed = true;
      await client.close();
    },
  };
}
