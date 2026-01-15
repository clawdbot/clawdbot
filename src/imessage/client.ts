import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

export type IMessageRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type IMessageRpcResponse<T> = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: IMessageRpcError;
  method?: string;
  params?: unknown;
};

export type IMessageRpcNotification = {
  method: string;
  params?: unknown;
};

export type IMessageRpcClientOptions = {
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

export class IMessageRpcClient {
  private readonly cliPath: string;
  private readonly dbPath?: string;
  private readonly runtime?: RuntimeEnv;
  private readonly onNotification?: (msg: IMessageRpcNotification) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closed: Promise<void>;
  private closedResolve: (() => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;

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
    if (this.child) return;
    const args = ["rpc"];
    if (this.dbPath) {
      args.push("--db", this.dbPath);
    }
    const child = spawn(this.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout });

    this.reader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleLine(trimmed);
    });

    child.stderr?.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.runtime?.error?.(`imsg rpc: ${line.trim()}`);
      }
    });

    child.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      this.closedResolve?.();
    });

    child.on("close", (code, signal) => {
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        this.failAll(new Error(`imsg rpc exited (${reason})`));
      } else {
        this.failAll(new Error("imsg rpc closed"));
      }
      this.closedResolve?.();
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.reader?.close();
    this.reader = null;
    this.child.stdin?.end();
    const child = this.child;
    this.child = null;

    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!child.killed) child.kill("SIGTERM");
          resolve();
        }, 500);
      }),
    ]);
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
    const timeoutMs = opts?.timeoutMs ?? 10_000;

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

    this.child.stdin.write(line);
    return await response;
  }

  private handleLine(line: string) {
    let parsed: IMessageRpcResponse<unknown>;
    try {
      parsed = JSON.parse(line) as IMessageRpcResponse<unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.runtime?.error?.(`imsg rpc: failed to parse ${line}: ${detail}`);
      return;
    }

    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);

      if (parsed.error) {
        const baseMessage = parsed.error.message ?? "imsg rpc error";
        const details = parsed.error.data;
        const code = parsed.error.code;
        const suffixes = [] as string[];
        if (typeof code === "number") suffixes.push(`code=${code}`);
        if (details !== undefined) {
          const detailText =
            typeof details === "string" ? details : JSON.stringify(details, null, 2);
          if (detailText) suffixes.push(detailText);
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

  private failAll(err: Error) {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}

export async function createIMessageRpcClient(
  opts: IMessageRpcClientOptions = {},
): Promise<IMessageRpcClient> {
  const client = new IMessageRpcClient(opts);
  await client.start();
  return client;
}
