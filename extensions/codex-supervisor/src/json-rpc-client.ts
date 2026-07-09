/**
 * JSON-RPC transports for Codex app-server connections over stdio proxies or
 * websocket/unix-socket endpoints.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import WebSocket from "ws";
import type { CodexJsonRpcConnection, CodexSupervisorEndpoint } from "./types.js";

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: NodeJS.Timeout;
};

type CodexSupervisorSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  isExecutable: (filePath: string) => boolean;
};

const MACOS_DESKTOP_CODEX_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_SPAWN_RUNTIME: CodexSupervisorSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  isExecutable,
};

/** Resolves an installed Codex app/CLI into a cross-platform stdio invocation. */
export function resolveCodexSupervisorStdioSpawnInvocation(
  endpoint: Extract<CodexSupervisorEndpoint, { transport: "stdio-proxy" }>,
  runtime: CodexSupervisorSpawnRuntime = DEFAULT_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  // The bundled supervisor consumes an installed Codex app/CLI; owning the
  // managed package here would make every OpenClaw install download Codex.
  const command =
    endpoint.command ??
    (runtime.platform === "darwin" && runtime.isExecutable(MACOS_DESKTOP_CODEX_COMMAND)
      ? MACOS_DESKTOP_CODEX_COMMAND
      : "codex");
  const args = endpoint.args ?? ["app-server", "--listen", "stdio://"];
  const program = resolveWindowsSpawnProgram({
    command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "@openai/codex",
  });
  const invocation = materializeWindowsSpawnProgram(program, args);
  return {
    command: invocation.command,
    args: invocation.argv,
    shell: invocation.shell,
    windowsHide: invocation.windowsHide,
  };
}

function formatJsonRpcError(message: Record<string, unknown>): Error {
  const error = isRecord(message.error) ? message.error : {};
  const detail =
    typeof error.message === "string" ? error.message : "Codex app-server request failed";
  return new Error(detail);
}

function formatMalformedMessageError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Malformed Codex app-server message: ${detail}`);
}

/**
 * Produces denial responses for app-server approval requests the supervisor
 * deliberately cannot grant.
 */
export function resolveSafeApprovalResult(method: string): Record<string, unknown> | undefined {
  if (method === "item/tool/call") {
    return {
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw Codex supervisor did not register a handler for this app-server tool call.",
        },
      ],
      success: false,
    };
  }
  if (method === "item/commandExecution/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method.endsWith("/requestApproval")) {
    return {
      decision: "decline",
      reason: "OpenClaw Codex supervisor does not grant native approvals.",
    };
  }
  if (method === "item/tool/requestUserInput") {
    return { answers: {} };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline" };
  }
  return undefined;
}

abstract class BaseCodexJsonRpcConnection implements CodexJsonRpcConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private closedError: Error | undefined;

  abstract close(): Promise<void>;
  protected abstract sendRaw(line: string): void;

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "openclaw-codex-supervisor",
        title: "OpenClaw Codex Supervisor",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    const id = randomUUID();
    const payload: Record<string, unknown> = { id, method, params: params ?? {} };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.sendRaw(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { method, params: params ?? null };
    this.sendRaw(JSON.stringify(payload));
  }

  protected handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    const id =
      typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id !== undefined && method) {
      const result = resolveSafeApprovalResult(method);
      // The supervisor is read/steer tooling, not a native approval delegate;
      // unknown app-server requests fail closed with either a denial or -32601.
      this.sendRaw(
        JSON.stringify(
          result === undefined
            ? {
                id,
                error: {
                  code: -32601,
                  message: `OpenClaw Codex supervisor cannot handle app-server request: ${method}`,
                },
              }
            : { id, result },
        ),
      );
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(String(id));
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(String(id));
      if ("error" in message) {
        pending.reject(formatJsonRpcError(message));
        return;
      }
      pending.resolve(message.result);
    }
  }

  protected rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  protected fail(error: Error): void {
    this.closedError ??= error;
    this.rejectAll(this.closedError);
  }
}

class StdioCodexJsonRpcConnection extends BaseCodexJsonRpcConnection {
  private buffer = "";
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly stderrTail: string[] = [];

  constructor(endpoint: Extract<CodexSupervisorEndpoint, { transport: "stdio-proxy" }>) {
    super();
    const invocation = resolveCodexSupervisorStdioSpawnInvocation(endpoint);
    this.proc = spawn(invocation.command, invocation.args, {
      cwd: endpoint.cwd,
      shell: invocation.shell,
      stdio: "pipe",
      windowsHide: invocation.windowsHide,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean));
      this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - 40));
    });
    this.proc.stdin.once("error", (error) => this.fail(error));
    this.proc.once("error", (error) => this.fail(error));
    this.proc.once("close", () =>
      this.fail(
        new Error(
          `Codex app-server stdio transport closed. stderr_tail=${truncateUtf16Safe(this.stderrTail.join("\n"), 1200)}`,
        ),
      ),
    );
  }

  protected sendRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`, (error) => {
      if (error) {
        this.fail(error);
      }
    });
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    this.proc.kill("SIGTERM");
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) {
        return;
      }
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      try {
        this.handleMessage(JSON.parse(line) as unknown);
      } catch (error) {
        this.fail(formatMalformedMessageError(error));
        void this.close();
        return;
      }
    }
  }
}

function defaultCodexControlSocketPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "app-server-control", "app-server-control.sock");
}

function resolveUnixWebSocketPath(url: string): string {
  const suffix = url.slice("unix://".length);
  return suffix || defaultCodexControlSocketPath();
}

function connectCodexSupervisorUnixSocket(url: string): net.Socket {
  return net.createConnection(resolveUnixWebSocketPath(url));
}

function websocketMessageToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

class WebSocketCodexJsonRpcConnection extends BaseCodexJsonRpcConnection {
  private readonly ws: WebSocket;
  private readonly openPromise: Promise<void>;
  private closing = false;

  constructor(endpoint: Extract<CodexSupervisorEndpoint, { transport: "websocket" }>) {
    super();
    const headers: Record<string, string> = {};
    if (endpoint.authTokenEnv) {
      const token = process.env[endpoint.authTokenEnv];
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }
    }
    this.ws = endpoint.url.startsWith("unix://")
      ? new WebSocket("ws://localhost/", {
          headers,
          createConnection: () => connectCodexSupervisorUnixSocket(endpoint.url),
        })
      : new WebSocket(endpoint.url, { headers });
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const text = websocketMessageToString(data);
      try {
        this.handleMessage(JSON.parse(text) as unknown);
      } catch (error) {
        this.fail(formatMalformedMessageError(error));
        void this.close();
      }
    });
    this.ws.once("error", (error) => this.fail(error));
    this.ws.once("close", () => {
      if (!this.closing) {
        this.fail(new Error("Codex app-server websocket closed"));
      }
    });
  }

  async ready(): Promise<void> {
    await this.openPromise;
  }

  protected sendRaw(line: string): void {
    this.ws.send(line, (error) => {
      if (error) {
        this.fail(error);
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.fail(new Error("Codex app-server websocket closed"));
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1000);
      this.ws.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });
  }
}

/**
 * Opens, initializes, and returns a JSON-RPC connection for one supervisor
 * endpoint.
 */
export async function connectCodexAppServerEndpoint(
  endpoint: CodexSupervisorEndpoint,
): Promise<CodexJsonRpcConnection> {
  const connection =
    endpoint.transport === "websocket"
      ? new WebSocketCodexJsonRpcConnection(endpoint)
      : new StdioCodexJsonRpcConnection(endpoint);
  try {
    if ("ready" in connection && typeof connection.ready === "function") {
      await connection.ready();
    }
    await connection.initialize();
    return connection;
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}
