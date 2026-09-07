/**
 * OpenClaw stdio transport wrapper for MCP server subprocesses.
 */
import fs from "node:fs/promises";
import process from "node:process";
import { PassThrough } from "node:stream";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import {
  closeOwnedStdioProcess,
  createOwnedStdioProcess,
  OwnedStdioCleanupError,
  type OwnedStdioProcess,
} from "../process/owned-stdio.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

type McpStdioDecoder = Pick<ReadBuffer, "append" | "readMessage" | "clear">;

type McpStdioExit = { code: number | null; signal: NodeJS.Signals | null };

type OpenClawStdioServerParameters = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Use only the supplied environment, including explicit omissions. */
  exactEnv?: true;
  /** The decoder owns byte bounds and frame validation; the default is the MCP SDK decoder. */
  decoder?: McpStdioDecoder;
  cwd?: string;
  prepareDataDir?: string;
  stderr?: "pipe" | "overlapped" | "inherit" | "ignore";
};

export class OpenClawStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onexit?: (exit: McpStdioExit) => void;

  private readonly readBuffer: McpStdioDecoder;
  private readonly stderrStream: PassThrough | null = null;
  private process?: OwnedStdioProcess;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private forceRequested = false;
  private closeNotified = false;
  private readonly startupAbort = new AbortController();
  private startupCleanupError?: OwnedStdioCleanupError;

  constructor(private readonly serverParams: OpenClawStdioServerParameters) {
    this.readBuffer = serverParams.decoder ?? new ReadBuffer();
    if (serverParams.stderr === "pipe" || serverParams.stderr === "overlapped") {
      this.stderrStream = new PassThrough();
    }
  }

  async start(): Promise<void> {
    if (this.starting || this.closing) {
      throw new Error(
        "OpenClawStdioClientTransport already started or closed; Client.connect() starts transports automatically.",
      );
    }
    this.starting = this.startProcess();
    return this.starting;
  }

  private async startProcess(): Promise<void> {
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

    // Directory preparation may finish after shutdown has retired this launch.
    if (this.startupAbort.signal.aborted) {
      throw new Error("MCP stdio transport is closed");
    }

    try {
      const child = await createOwnedStdioProcess({
        argv: [this.serverParams.command, ...(this.serverParams.args ?? [])],
        cwd: this.serverParams.cwd,
        env: this.serverParams.exactEnv
          ? mergeProcessEnv([this.serverParams.env])
          : mergeProcessEnv([getDefaultEnvironment(), this.serverParams.env]),
        ...(this.serverParams.exactEnv ? { exactEnv: true as const } : {}),
        abortSignal: this.startupAbort.signal,
        stderrDestination:
          this.stderrStream ?? (this.serverParams.stderr === "ignore" ? undefined : process.stderr),
      });
      this.process = child;
      child.onError((error) => this.onerror?.(error));
      const receive = (chunk: Buffer) => {
        if (this.closing) {
          return;
        }
        try {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          void this.close().catch(() => {});
        }
      };
      child.onStdout((text) => {
        if (!child.supportsRawOutput) {
          receive(Buffer.from(text));
        }
      }, receive);
      if (this.serverParams.stderr === "ignore") {
        child.onStderr(() => {});
      }
      // Root closure retires the connection immediately; the retained owner still
      // joins descendants before disposal can certify completed cleanup.
      void child.wait().then(
        (exit) => {
          try {
            this.onexit?.(exit);
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          } finally {
            void this.close().catch(() => {});
            this.notifyClosed();
          }
        },
        (error: unknown) => {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          void this.close().catch(() => {});
          this.notifyClosed();
        },
      );
    } catch (error) {
      if (error instanceof OwnedStdioCleanupError) {
        this.startupCleanupError = error;
        recordAgentCleanupFailure();
      }
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  get stderr() {
    return this.stderrStream;
  }

  get pid() {
    return this.process?.pid ?? null;
  }

  private notifyClosed(): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.onclose?.();
  }

  private processReadBuffer() {
    while (!this.closing) {
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

  close(): Promise<void> {
    if (this.starting && !this.process) {
      this.startupAbort.abort();
    }
    this.closing ??= (async () => {
      // A connect timeout can request disposal while the spawn owner is admitting.
      await this.starting?.catch(() => undefined);
      try {
        if (this.startupCleanupError) {
          throw this.startupCleanupError;
        }
        if (this.process) {
          await closeOwnedStdioProcess(this.process, { force: this.forceRequested });
        }
      } catch (error) {
        recordAgentCleanupFailure();
        throw error;
      } finally {
        this.process = undefined;
        this.readBuffer.clear();
        this.stderrStream?.end();
        this.notifyClosed();
      }
    })();
    // Attach observation in this caller's scope, including already failed startup.
    void this.closing.catch(() => recordAgentCleanupFailure());
    return this.closing;
  }

  /** Retire RPC admission now; the returned promise still joins owned-process cleanup. */
  retire(): Promise<void> {
    const closing = this.close();
    this.readBuffer.clear();
    this.notifyClosed();
    return closing;
  }

  terminate(): Promise<void> {
    this.process?.kill("SIGTERM");
    return this.retire();
  }

  forceClose(): Promise<void> {
    this.forceRequested = true;
    this.process?.kill("SIGKILL");
    return this.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.closing ? undefined : this.process?.stdin;
      if (!stdin) {
        throw new Error("Not connected");
      }
      const json = serializeMessage(message);
      // Settle from the write callback so async EPIPE rejects instead of
      // escaping to uncaughtException. (#75438)
      try {
        stdin.write(json, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
