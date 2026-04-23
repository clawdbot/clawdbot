import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { PassThrough } from "node:stream";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { killProcessTree } from "../process/kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";

export type OpenClawStdioServerParameters = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: "pipe" | "overlapped" | "inherit" | "ignore";
};

const CLOSE_TIMEOUT_MS = 2000;

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

    await new Promise<void>((resolve, reject) => {
      const baseEnv = {
        ...getDefaultEnvironment(),
        ...this.serverParams.env,
      };
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

      child.on("error", (error: Error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on("spawn", () => resolve());
      child.on("close", () => {
        this.process = undefined;
        this.onclose?.();
      });
      child.stdin?.on("error", (error: Error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      });
      child.stdout?.on("error", (error: Error) => this.onerror?.(error));
      if (this.stderrStream && child.stderr) {
        child.stderr.pipe(this.stderrStream);
      }
    });
  }

  get stderr() {
    return this.stderrStream ?? this.process?.stderr ?? null;
  }

  get pid() {
    return this.process?.pid ?? null;
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
    const processToClose = this.process;
    this.process = undefined;
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
        killProcessTree(processToClose.pid);
        await Promise.race([closePromise, delay(CLOSE_TIMEOUT_MS)]);
      }
    }
    this.readBuffer.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      const stdin = this.process?.stdin;
      if (!stdin) {
        throw new Error("Not connected");
      }
      const json = serializeMessage(message);
      if (stdin.write(json)) {
        resolve();
      } else {
        stdin.once("drain", resolve);
      }
    });
  }
}
