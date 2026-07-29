// Imessage plugin module implements client behavior.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";

type IMessageRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type IMessageRpcResponse<T> = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: IMessageRpcError;
  method?: string;
  params?: unknown;
};

type IMessageRpcNotification = {
  method: string;
  params?: unknown;
};

type IMessageRpcClientOptions = {
  cliPath?: string;
  dbPath?: string;
  runtime?: RuntimeEnv;
  onNotification?: (msg: IMessageRpcNotification) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";

function isTestEnv(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  const vitest = normalizeLowercaseStringOrEmpty(process.env.VITEST);
  return Boolean(vitest);
}

function normalizeIMessageFullDiskAccessError(message: string): string | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(message);
  if (!normalized.includes("full disk access") || !normalized.includes("chat.db")) {
    return undefined;
  }
  return PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR;
}

export class IMessageRpcClient {
  private readonly cliPath: string;
  private readonly dbPath?: string;
  private readonly runtime?: RuntimeEnv;
  private readonly onNotification?: (msg: IMessageRpcNotification) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closed: Promise<void>;
  private closedResolve: (() => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stderrBuffer = "";
  private readonly stderrDecoder = new StringDecoder("utf8");
  private nextId = 1;
  private publicProcessError: string | null = null;

  constructor(opts: IMessageRpcClientOptions = {}) {
    this.cliPath = opts.cliPath?.trim() || "imsg";
    this.dbPath = opts.dbPath?.trim() ? resolveUserPath(opts.dbPath) : undefined;
    this.runtime = opts.runtime;
    this.onNotification = opts.onNotification;
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    if (isTestEnv()) {
      throw new Error("Refusing to start imsg rpc in test environment; mock iMessage RPC client");
    }
    const args = ["rpc", "--json"];
    if (this.dbPath) {
      args.push("--db", this.dbPath);
    }
    const child = spawn(this.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (chunk) => {
      if (this.child !== child) {
        return;
      }
      this.handleStdoutChunk(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      if (this.child !== child) {
        return;
      }
      this.handleStderrChunk(chunk);
    });

    // Every process/stdio error is terminal for this RPC transport. Settle the
    // client once and terminate a helper whose pipe failed; otherwise the
    // monitor can wait forever on an unusable child. #75438 covered stdin only.
    const failFromProcessError = (err: unknown) => {
      if (!this.finish(err instanceof Error ? err : new Error(String(err)))) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // The helper may already be gone.
      }
    };
    child.on("error", failFromProcessError);
    child.stdin.on("error", failFromProcessError);
    child.stdout.on("error", failFromProcessError);
    child.stderr.on("error", failFromProcessError);

    child.on("close", (code, signal) => {
      if (this.child === child) {
        // Complete both byte streams before selecting the terminal error so a
        // final split diagnostic can still provide its public recovery guidance.
        this.flushStdoutBuffer();
        this.flushStderrBuffer();
      }
      this.finish(this.buildCloseError(code, signal));
    });
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }
    this.stdoutBuffer = "";
    this.stdoutDecoder.end();
    this.stderrBuffer = "";
    this.stderrDecoder.end();
    this.child.stdin?.end();
    const child = this.child;
    this.child = null;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGTERM");
            }
            resolve();
          }, 500);
        }),
      ]);
    } finally {
      // A losing fallback still holds Node's event loop open; clear it when
      // the child closes first so short-lived RPC clients can exit promptly.
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async waitForClose(): Promise<void> {
    await this.closed;
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.child || !this.child.stdin) {
      throw new Error("imsg rpc not running");
    }
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };
    const line = `${JSON.stringify(payload)}\n`;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;

    const response = new Promise<T>((resolve, reject) => {
      const key = String(id);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`imsg rpc timeout (${method})`));
            }, timeoutMs)
          : undefined;
      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    // Reject the specific pending request on write error (e.g. EPIPE)
    // instead of letting it hang until timeout. (#75438)
    this.child.stdin.write(line, (err) => {
      if (err) {
        const key = String(id);
        const pending = this.pending.get(key);
        if (pending) {
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          this.pending.delete(key);
          pending.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    return await response;
  }

  private handleStdoutChunk(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.stdoutBuffer += text;

    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushStdoutBuffer() {
    const tail = this.stdoutDecoder.end();
    if (tail) {
      this.stdoutBuffer += tail;
    }
    if (!this.stdoutBuffer) {
      return;
    }
    const line = this.stdoutBuffer;
    this.stdoutBuffer = "";
    this.handleStdoutLine(line);
  }

  private handleStdoutLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    this.handleLine(trimmed);
  }

  private handleStderrChunk(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : this.stderrDecoder.write(chunk);
    this.stderrBuffer += text;

    let newlineIndex = this.stderrBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      this.handleStderrLine(line);
      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  private flushStderrBuffer() {
    this.stderrBuffer += this.stderrDecoder.end();
    if (!this.stderrBuffer) {
      return;
    }
    const line = this.stderrBuffer;
    this.stderrBuffer = "";
    this.handleStderrLine(line);
  }

  private handleStderrLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    this.recordProcessDiagnostic(trimmed);
    this.runtime?.error?.(`imsg rpc: ${trimmed}`);
  }

  private handleLine(line: string) {
    let parsed: IMessageRpcResponse<unknown>;
    try {
      parsed = JSON.parse(line) as IMessageRpcResponse<unknown>;
    } catch (err) {
      this.recordProcessDiagnostic(line);
      const detail = formatErrorMessage(err);
      this.runtime?.error?.(`imsg rpc: failed to parse ${line}: ${detail}`);
      return;
    }

    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pending.delete(key);

      if (parsed.error) {
        const baseMessage = parsed.error.message ?? "imsg rpc error";
        const details = parsed.error.data;
        const code = parsed.error.code;
        const suffixes = [] as string[];
        if (typeof code === "number") {
          suffixes.push(`code=${code}`);
        }
        if (details !== undefined) {
          const detailText =
            typeof details === "string" ? details : JSON.stringify(details, null, 2);
          if (detailText) {
            suffixes.push(detailText);
          }
        }
        const msg = suffixes.length > 0 ? `${baseMessage}: ${suffixes.join(" ")}` : baseMessage;
        pending.reject(new Error(msg));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (parsed.method) {
      this.onNotification?.({
        method: parsed.method,
        params: parsed.params,
      });
    }
  }

  private recordProcessDiagnostic(line: string): void {
    this.publicProcessError ??= normalizeIMessageFullDiskAccessError(line) ?? null;
  }

  private buildCloseError(code: number | null, signal: NodeJS.Signals | null): Error {
    if (this.publicProcessError) {
      return new Error(this.publicProcessError);
    }
    if (code !== 0 && code !== null) {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      return new Error(`imsg rpc exited (${reason})`);
    }
    return new Error("imsg rpc closed");
  }

  private failAll(err: Error) {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(err);
      this.pending.delete(key);
    }
  }

  private finish(err: Error): boolean {
    const resolve = this.closedResolve;
    if (!resolve) {
      return false;
    }
    this.closedResolve = null;
    this.failAll(err);
    resolve();
    return true;
  }
}

export async function createIMessageRpcClient(
  opts: IMessageRpcClientOptions = {},
): Promise<IMessageRpcClient> {
  const client = new IMessageRpcClient(opts);
  await client.start();
  return client;
}
