// Imessage plugin module implements client behavior.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { recoverIMessageBridge } from "./bridge-recovery.js";
import { expandIMessageUserPath } from "./cli-path.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";
import { invalidateCachedIMessagePrivateApiStatus } from "./private-api-status.js";

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
  remoteHost?: string;
  runtime?: RuntimeEnv;
  onNotification?: (msg: IMessageRpcNotification) => void;
};

export class IMessageRpcRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "IMessageRpcRequestError";
  }
}

// A stalled bridge, as opposed to a rejected or merely slow request.
//
// Matches only imsg's own structured wait error, e.g.
//   "Internal error: code=-32603 Timed out waiting for response to 'send-message'"
// which imsg raises after publishing a request to the injected helper and
// getting nothing back. That is first-hand evidence about the bridge.
//
// Deliberately excludes our own client-side timer ("imsg rpc timeout (...)"):
// it fires when the local wrapper is slow or blocked while imsg itself is
// healthy, so treating it as a dead bridge would evict a good capability cache
// and point operators at `imsg launch`, the wrong repair. An ordinary rejection
// (bad target, unknown chat) says nothing about bridge health either.
// Module-private: request() is the only production caller, and the behavior is
// covered through that boundary rather than by calling this directly.
function isIMessageBridgeStall(error: unknown): boolean {
  // Only an Error can carry a stall. Stringifying an arbitrary value here would
  // render most objects as "[object Object]" and match nothing anyway.
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Timed out waiting for response");
}

const BRIDGE_STALL_GUIDANCE =
  "The imsg private API bridge stopped responding. Run `imsg launch` to re-inject the dylib, " +
  "then `openclaw channels status --probe` to refresh capability detection.";

// Append the actionable cause without rewriting the error.
//
// Normal outbound sends never consult the private-API status cache (send.ts
// builds a client and dispatches directly), so evicting that cache alone leaves
// them repeating an opaque timeout. Decorating here reaches every caller.
//
// Preserve the class, code, data, and original message text: send.ts keys
// delayed-send reconciliation off `data.disposition`/`data.retry_safe` and
// matches `imsg rpc timeout (send)` by regex, so the original wording has to
// survive as a prefix.
function describeIMessageBridgeStall(error: unknown): unknown {
  if (error instanceof IMessageRpcRequestError) {
    return new IMessageRpcRequestError(
      `${error.message} ${BRIDGE_STALL_GUIDANCE}`,
      error.code,
      error.data,
    );
  }
  if (error instanceof Error) {
    return new Error(`${error.message} ${BRIDGE_STALL_GUIDANCE}`, { cause: error });
  }
  return error;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";
const IMESSAGE_RPC_CLOSE_GRACE_MS = 500;

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

function createLfLineFramer(onLine: (line: string) => void): {
  write(chunk: Buffer | string): void;
  flush(): void;
} {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    write(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      buffer += decoder.end();
      if (!buffer) {
        return;
      }
      const line = buffer;
      buffer = "";
      onLine(line);
    },
  };
}

export class IMessageRpcClient {
  private readonly cliPath: string;
  // The private-API cache is keyed by the *configured* cliPath (see
  // actions.ts, which passes `account.config.cliPath` to both the probe and
  // this client), so invalidation has to use the same unexpanded string. Using
  // the expanded one silently misses for any `~`-relative cliPath.
  private readonly configuredCliPath: string;
  private readonly dbPath?: string;
  private readonly runtime?: RuntimeEnv;
  private readonly onNotification?: (msg: IMessageRpcNotification) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly terminal: Promise<Error>;
  private terminalResolve: ((error: Error) => void) | null = null;
  private readonly reaped: Promise<void>;
  private reapedResolve: (() => void) | null = null;
  private isReaped = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly stdoutFramer = createLfLineFramer((line) => this.handleStdoutLine(line));
  private readonly stderrFramer = createLfLineFramer((line) => this.handleStderrLine(line));
  private nextId = 1;
  private publicProcessError: string | null = null;

  constructor(opts: IMessageRpcClientOptions = {}) {
    this.configuredCliPath = opts.cliPath?.trim() || "imsg";
    this.cliPath = expandIMessageUserPath(this.configuredCliPath);
    const dbPath = opts.dbPath?.trim();
    // An explicitly remote database belongs to the Messages Mac. Only local
    // database paths are relative to the Gateway user's home directory.
    this.dbPath = dbPath ? (opts.remoteHost?.trim() ? dbPath : resolveUserPath(dbPath)) : undefined;
    this.runtime = opts.runtime;
    this.onNotification = opts.onNotification;
    this.terminal = new Promise((resolve) => {
      this.terminalResolve = resolve;
    });
    this.reaped = new Promise((resolve) => {
      this.reapedResolve = resolve;
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
      this.stdoutFramer.write(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      if (this.child !== child) {
        return;
      }
      this.stderrFramer.write(chunk);
    });

    // Every process/stdio error is terminal for this RPC transport. Settle the
    // client once and terminate a helper whose pipe failed; otherwise the
    // monitor can wait forever on an unusable child. #75438 covered stdin only.
    const failFromProcessError = (err: unknown) => this.failTransport(err, child);
    child.on("error", failFromProcessError);
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", failFromProcessError);
      stream.once("close", () => {
        // Bun can close an errored stdio stream without emitting its error event.
        const error = stream.errored;
        if (error) {
          failFromProcessError(error);
        }
      });
    }

    child.on("close", (code, signal) => {
      if (this.child === child) {
        // Complete both byte streams before selecting the terminal error so a
        // final split diagnostic can still provide its public recovery guidance.
        this.stdoutFramer.flush();
        this.stderrFramer.flush();
        this.child = null;
      }
      this.finish(this.buildCloseError(code, signal));
      this.markReaped();
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    const child = this.child;
    if (!child) {
      return;
    }
    this.stopPromise = this.stopChild(child);
    return await this.stopPromise;
  }

  async waitForClose(): Promise<void> {
    const error = await this.terminal;
    throw error;
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
    try {
      this.child.stdin.write(line, (err) => {
        if (err) {
          this.failTransport(err, this.child);
        }
      });
    } catch (err) {
      this.failTransport(err, this.child);
    }
    try {
      return await response;
    } catch (err) {
      // Every private-API action funnels through here, so this is the one place
      // that learns the bridge went away. Without it the cached "available"
      // verdict never expires and each later send is dispatched into a dead
      // bridge, surfacing an opaque -32603 instead of the actionable
      // "run imsg launch" guidance. Clearing the entry makes the next action
      // re-probe and report the real state.
      if (isIMessageBridgeStall(err)) {
        invalidateCachedIMessagePrivateApiStatus(this.configuredCliPath);
        try {
          await recoverIMessageBridge(this.configuredCliPath);
        } catch (recoveryError) {
          this.runtime?.error?.(
            `imessage: automatic bridge recovery failed: ${formatErrorMessage(recoveryError)}`,
          );
        }
        throw describeIMessageBridgeStall(err);
      }
      throw err;
    }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    try {
      child.stdin.end();
    } catch (err) {
      this.failTransport(err, child);
    }
    if (await this.waitForReap(IMESSAGE_RPC_CLOSE_GRACE_MS)) {
      return;
    }
    this.signalChild(child, "SIGTERM");
    if (await this.waitForReap(IMESSAGE_RPC_CLOSE_GRACE_MS)) {
      return;
    }
    this.signalChild(child, "SIGKILL");
    if (!(await this.waitForReap(IMESSAGE_RPC_CLOSE_GRACE_MS))) {
      throw new Error("imsg rpc did not exit after SIGKILL");
    }
  }

  private async waitForReap(timeoutMs: number): Promise<boolean> {
    if (this.isReaped) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.reaped.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // The helper may have exited between the grace timer and the signal.
    }
  }

  private failTransport(err: unknown, child: ChildProcessWithoutNullStreams | null): void {
    if (!this.finish(err instanceof Error ? err : new Error(String(err)))) {
      return;
    }
    if (child) {
      this.signalChild(child, "SIGTERM");
    }
  }

  private handleStdoutLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    this.handleLine(trimmed);
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
        pending.reject(
          new IMessageRpcRequestError(msg, typeof code === "number" ? code : undefined, details),
        );
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
    const resolve = this.terminalResolve;
    if (!resolve) {
      return false;
    }
    this.terminalResolve = null;
    this.failAll(err);
    resolve(err);
    return true;
  }

  private markReaped(): void {
    if (this.isReaped) {
      return;
    }
    this.isReaped = true;
    const resolve = this.reapedResolve;
    this.reapedResolve = null;
    resolve?.();
  }
}

export async function createIMessageRpcClient(
  opts: IMessageRpcClientOptions = {},
): Promise<IMessageRpcClient> {
  const client = new IMessageRpcClient(opts);
  await client.start();
  return client;
}
