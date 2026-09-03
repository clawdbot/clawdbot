/**
 * OpenClaw stdio transport wrapper for MCP server subprocesses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import process from "node:process";
import { PassThrough } from "node:stream";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { signalProcessTree } from "../process/kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";

type OpenClawStdioServerParameters = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  prepareDataDir?: string;
  stderr?: "pipe" | "overlapped" | "inherit" | "ignore";
};

const CLOSE_TIMEOUT_MS = 2000;
const SIGKILL_REAP_TIMEOUT_MS = 500;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export class OpenClawStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null = null;
  private process?: ChildProcess;
  private closingProcess?: ChildProcess;
  private ownedProcessGroupId?: number;

  constructor(private readonly serverParams: OpenClawStdioServerParameters) {
    if (serverParams.stderr === "pipe" || serverParams.stderr === "overlapped") {
      this.stderrStream = new PassThrough();
    }
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error(
        "OpenClawStdioClientTransport already started; Client.connect() starts transports automatically.",
      );
    }

    const prepareDataDir = this.serverParams.prepareDataDir?.trim();
    if (prepareDataDir) {
      try {
        await fs.mkdir(prepareDataDir, { recursive: true });
      } catch (error) {
        throw new Error(
          `unable to prepare PLUGIN_DATA directory "${prepareDataDir}": ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
    }

    await new Promise<void>((resolve, reject) => {
      const baseEnv = mergeProcessEnv([getDefaultEnvironment(), this.serverParams.env]);
      const preparedSpawn = prepareOomScoreAdjustedSpawn(
        this.serverParams.command,
        this.serverParams.args ?? [],
        { env: baseEnv },
      );
      const child = spawn(preparedSpawn.command, preparedSpawn.args, {
        cwd: this.serverParams.cwd,
        detached: process.platform !== "win32",
        env: preparedSpawn.env,
        shell: false,
        stdio: ["pipe", "pipe", this.serverParams.stderr ?? "inherit"],
        windowsHide: process.platform === "win32",
      });
      this.process = child;
      if (process.platform !== "win32" && child.pid) {
        // Detached spawn makes the leader PID the durable PGID. Keep it after
        // the leader handle exits so descendants remain owned until disposal.
        this.ownedProcessGroupId = child.pid;
      }

      child.on("error", (error: Error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on("spawn", () => resolve());
      child.on("close", () => {
        if (this.process === child) {
          this.process = undefined;
        }
        if (child.pid && this.ownedProcessGroupId === child.pid) {
          // The leader still owns this PGID at close notification time. Kill any
          // descendants now so a retained numeric PGID can never outlive ownership.
          signalProcessTree(child.pid, "SIGKILL", { detached: true });
          this.ownedProcessGroupId = undefined;
        }
        this.onclose?.();
      });
      child.stdin?.on("error", (error: Error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          void this.close();
        }
      });
      child.stdout?.on("error", (error: Error) => this.onerror?.(error));
      if (this.stderrStream && child.stderr) {
        child.stderr.on("error", (error: Error) => this.onerror?.(error));
        child.stderr.pipe(this.stderrStream);
      }
    });
  }

  get stderr() {
    return this.stderrStream ?? this.process?.stderr ?? null;
  }

  get pid() {
    return this.process?.pid ?? this.closingProcess?.pid ?? null;
  }

  private processReadBuffer() {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async close(): Promise<void> {
    const processToClose = this.process ?? this.closingProcess;
    const ownedProcessGroupId = this.ownedProcessGroupId;
    this.process = undefined;
    this.closingProcess = processToClose;
    if (processToClose) {
      const closePromise = new Promise<void>((resolve) => {
        processToClose.once("close", () => resolve());
      });
      try {
        processToClose.stdin?.end();
      } catch {
        // best-effort
      }
      await Promise.race([closePromise, delay(CLOSE_TIMEOUT_MS)]);
      if (processToClose.exitCode === null && processToClose.pid) {
        signalProcessTree(processToClose.pid, "SIGTERM", { detached: true });
        await Promise.race([closePromise, delay(CLOSE_TIMEOUT_MS)]);
        if (processToClose.exitCode === null && processToClose.pid) {
          signalProcessTree(processToClose.pid, "SIGKILL", { detached: true });
          await Promise.race([closePromise, delay(SIGKILL_REAP_TIMEOUT_MS)]);
        }
      }
    }
    if (this.closingProcess === processToClose) {
      this.closingProcess = undefined;
    }
    if (this.ownedProcessGroupId === ownedProcessGroupId) {
      this.ownedProcessGroupId = undefined;
    }
    this.readBuffer.clear();
  }

  async forceClose(): Promise<void> {
    const processToClose = this.process ?? this.closingProcess;
    const ownedProcessGroupId = this.ownedProcessGroupId;
    this.process = undefined;
    if (processToClose?.pid && processToClose.exitCode === null) {
      const closePromise = new Promise<void>((resolve) => {
        processToClose.once("close", () => resolve());
      });
      signalProcessTree(processToClose.pid, "SIGKILL", { detached: true });
      await Promise.race([closePromise, delay(SIGKILL_REAP_TIMEOUT_MS)]);
    } else if (ownedProcessGroupId) {
      signalProcessTree(ownedProcessGroupId, "SIGKILL", { detached: true });
    }
    if (this.closingProcess === processToClose) {
      this.closingProcess = undefined;
    }
    if (this.ownedProcessGroupId === ownedProcessGroupId) {
      this.ownedProcessGroupId = undefined;
    }
    this.readBuffer.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.process?.stdin;
      if (!stdin) {
        throw new Error("Not connected");
      }
      const json = serializeMessage(message);
      // Settle from the write callback so async EPIPE rejects instead of
      // escaping to uncaughtException. (#75438)
      try {
        const flushed = stdin.write(json, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        if (!flushed) {
          // Back-pressure: drain fires when the buffer empties, but the
          // write callback above still owns promise settlement.
          stdin.once("drain", () => {});
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
