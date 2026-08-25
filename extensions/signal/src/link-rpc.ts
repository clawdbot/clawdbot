// Setup-only signal-cli JSON-RPC transport bound to one child process.
import { generateSecureUuid } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalRpcOptions } from "./client.js";
import {
  formatSignalDaemonExit,
  spawnSignalJsonRpcProcess,
  type SignalJsonRpcProcess,
} from "./daemon.js";

type PendingRequest = {
  id: string;
  maxResponseBytes: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type SignalLinkRpcClient = {
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: Pick<SignalRpcOptions, "timeoutMs" | "maxResponseBytes">,
  ) => Promise<unknown>;
  stop: () => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;

class SignalLinkRpcProcessClient implements SignalLinkRpcClient {
  private responseBuffer = Buffer.alloc(0);
  private pending: PendingRequest | undefined;
  private terminalError: Error | undefined;

  constructor(
    private readonly process: SignalJsonRpcProcess,
    private readonly abortSignal?: AbortSignal,
  ) {
    process.stdout.on("data", this.handleChunk);
    process.stdin.on("error", this.fail);
    process.stdout.on("error", this.fail);
    void process.exited.then((exit) => this.fail(new Error(formatSignalDaemonExit(exit))));
    abortSignal?.addEventListener("abort", this.onAbort, { once: true });
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: Pick<SignalRpcOptions, "timeoutMs" | "maxResponseBytes">,
  ): Promise<unknown> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.pending) {
      throw new Error("signal-cli link RPC request already in flight");
    }
    this.abortSignal?.throwIfAborted();
    const id = generateSecureUuid();
    const timeoutMs = this.positiveInteger(options?.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxResponseBytes = this.positiveInteger(
      options?.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    const response = new Promise<unknown>((resolve, reject) => {
      this.responseBuffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.responseBuffer = Buffer.alloc(0);
        reject(new Error(`signal-cli jsonRpc timeout (${method})`));
      }, timeoutMs);
      timer.unref?.();
      this.pending = {
        id,
        maxResponseBytes,
        resolve,
        reject,
        timer,
      };
    });
    try {
      this.process.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`,
        (error?: Error | null) => {
          if (error) {
            this.fail(error);
          }
        },
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return await response;
  }

  async stop(): Promise<void> {
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.process.stdout.off("data", this.handleChunk);
    this.process.stdin.off("error", this.fail);
    this.process.stdout.off("error", this.fail);
    await this.process.stop();
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private readonly onAbort = () => void this.process.stop();

  private readonly handleChunk = (chunk: Buffer | string) => {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length && this.pending === pending) {
      const newline = data.indexOf(0x0a, offset);
      const end = newline === -1 ? data.length : newline;
      const segment = data.subarray(offset, end);
      if (this.responseBuffer.length + segment.length > pending.maxResponseBytes) {
        this.fail(new Error("signal-cli jsonRpc response exceeded size limit"));
        return;
      }
      if (segment.length > 0) {
        this.responseBuffer = Buffer.concat([this.responseBuffer, segment]);
      }
      if (newline === -1) {
        return;
      }
      const line = this.responseBuffer.toString("utf8").replace(/\r$/u, "");
      this.responseBuffer = Buffer.alloc(0);
      this.handleLine(line);
      offset = newline + 1;
    }
  };

  private readonly handleLine = (line: string) => {
    const pending = this.pending;
    if (!pending || !line.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail(new Error("signal-cli jsonRpc returned malformed JSON"));
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== "string" || parsed.id !== pending.id) {
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (isRecord(parsed.error)) {
      const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
      const message =
        typeof parsed.error.message === "string"
          ? parsed.error.message.slice(0, 512)
          : "request failed";
      pending.reject(new Error(`signal-cli jsonRpc${code}: ${message}`));
    } else if (Object.hasOwn(parsed, "result")) {
      pending.resolve(parsed.result);
    } else {
      pending.reject(new Error("signal-cli jsonRpc returned an invalid response"));
    }
  };

  private readonly fail = (error: Error) => {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.responseBuffer = Buffer.alloc(0);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    void this.process.stop();
  };
}

export function createSignalLinkRpcClient(options: {
  cliPath: string;
  configPath?: string;
  abortSignal?: AbortSignal;
}): SignalLinkRpcClient {
  const { abortSignal, ...processOptions } = options;
  return new SignalLinkRpcProcessClient(spawnSignalJsonRpcProcess(processOptions), abortSignal);
}
