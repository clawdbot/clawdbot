/**
 * Hosts the local OpenClaw sandbox exec-server that Codex app-server native
 * execution can register as an external environment.
 */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { parseRequest } from "./sandbox-exec-server/json-rpc.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type { OpenClawExecServer } from "./sandbox-exec-server/types.js";

/** Codex environment metadata registered for one sandbox exec-server lease. */
export type CodexSandboxExecEnvironment = {
  environmentId: string;
  cwd: string;
};

const CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES = 100 * 1024 * 1024;

/** Starts or reuses a sandbox exec-server and registers it with Codex app-server. */
export async function ensureCodexSandboxExecServerEnvironment(params: {
  client: CodexAppServerClient;
  sandbox: SandboxContext | null;
  appServerStartOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexSandboxExecEnvironment | undefined> {
  if (!params.sandbox?.enabled || !params.sandbox.backend) {
    return undefined;
  }
  if (!canExposeLocalExecServerToAppServer(params.appServerStartOptions)) {
    throw new Error(
      "OpenClaw Codex exec-server uses a local loopback URL and cannot be registered with a remote Codex app-server.",
    );
  }
  const execServer = await acquireOpenClawExecServer(params.sandbox);
  try {
    await params.client.request(
      "environment/add",
      {
        environmentId: execServer.environmentId,
        execServerUrl: execServer.url,
      },
      { timeoutMs: params.timeoutMs, signal: params.signal },
    );
  } catch (error) {
    await releaseOpenClawExecServer(execServer);
    throw error;
  }
  return {
    environmentId: execServer.environmentId,
    cwd: params.sandbox.containerWorkdir,
  };
}

/** Releases the sandbox exec-server lease associated with a sandbox runtime. */
export async function releaseCodexSandboxExecServerEnvironment(
  sandbox: SandboxContext | null | undefined,
): Promise<void> {
  if (!sandbox?.enabled) {
    return;
  }
  const server = await sandboxExecServerRegistry.servers
    .get(sandbox.runtimeId)
    ?.catch(() => undefined);
  if (server) {
    await releaseOpenClawExecServer(server);
  }
}

function canExposeLocalExecServerToAppServer(
  startOptions: CodexAppServerStartOptions | undefined,
): boolean {
  if (!startOptions || startOptions.transport !== "websocket") {
    return true;
  }
  if (typeof startOptions.url !== "string") {
    return false;
  }
  try {
    const host = new URL(startOptions.url).hostname.toLowerCase();
    const ipHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (host === "localhost" || ipHost === "::1") {
      return true;
    }
    return isIP(ipHost) === 4 && ipHost.split(".")[0] === "127";
  } catch {
    return false;
  }
}

async function acquireOpenClawExecServer(sandbox: SandboxContext): Promise<OpenClawExecServer> {
  const key = sandbox.runtimeId;
  while (true) {
    const existing = sandboxExecServerRegistry.servers.get(key);
    const promise = existing ?? startAndRememberOpenClawExecServer(sandbox);
    const server = await promise;
    if (!server.closed && sandboxExecServerRegistry.servers.get(key) === promise) {
      server.refCount += 1;
      return server;
    }
  }
}

function startAndRememberOpenClawExecServer(sandbox: SandboxContext): Promise<OpenClawExecServer> {
  const created = startOpenClawExecServer(sandbox);
  const key = sandbox.runtimeId;
  sandboxExecServerRegistry.servers.set(key, created);
  void created.catch(() => {
    if (sandboxExecServerRegistry.servers.get(key) === created) {
      sandboxExecServerRegistry.servers.delete(key);
    }
  });
  return created;
}

async function startOpenClawExecServer(sandbox: SandboxContext): Promise<OpenClawExecServer> {
  const backend = sandbox.backend;
  const fsBridge = sandbox.fsBridge;
  if (!backend) {
    throw new Error("OpenClaw sandbox backend is unavailable.");
  }
  if (!fsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    // Match ws' historical default: Codex fs/writeFile sends one base64 JSON-RPC
    // frame, while the socket error handler below makes oversize frames nonfatal.
    maxPayload: CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OpenClaw Codex exec-server did not bind to a TCP port.");
  }
  const environmentId = buildEnvironmentId(sandbox);
  const authPath = `/openclaw-${randomUUID()}`;
  const url = `ws://127.0.0.1:${(address as AddressInfo).port}${authPath}`;
  const execServer: OpenClawExecServer = {
    authPath,
    closed: false,
    environmentId,
    refCount: 0,
    url,
    sandbox,
    backend,
    fsBridge,
    server,
    children: new Set(),
    cleanupTasks: new Set(),
  };
  server.on("connection", (socket, request) => {
    // ws emits error for maxPayload rejections before auth or JSON-RPC sees the frame.
    socket.on("error", handleExecServerSocketError);
    if (!isAuthorizedExecServerRequest(execServer, request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    handleConnection(execServer, socket);
  });
  embeddedAgentLog.info("codex sandbox exec-server started", {
    environmentId,
    runtimeId: sandbox.runtimeId,
    backendId: sandbox.backendId,
  });
  return execServer;
}

async function releaseOpenClawExecServer(execServer: OpenClawExecServer): Promise<void> {
  if (execServer.closed) {
    return;
  }
  execServer.refCount = Math.max(0, execServer.refCount - 1);
  if (execServer.refCount > 0) {
    return;
  }
  const current = await sandboxExecServerRegistry.servers
    .get(execServer.sandbox.runtimeId)
    ?.catch(() => undefined);
  if (execServer.refCount > 0 || execServer.closed) {
    return;
  }
  if (current === execServer) {
    sandboxExecServerRegistry.servers.delete(execServer.sandbox.runtimeId);
  }
  await sandboxExecServerRegistry.close(execServer);
}

function buildEnvironmentId(sandbox: SandboxContext): string {
  const hash = createHash("sha256").update(sandbox.runtimeId).digest("hex").slice(0, 16);
  return `openclaw-sandbox-${hash}`;
}

function isAuthorizedExecServerRequest(
  execServer: OpenClawExecServer,
  request: IncomingMessage,
): boolean {
  const url = new URL(request.url ?? "", "ws://127.0.0.1");
  return url.pathname === execServer.authPath;
}

function handleConnection(execServer: OpenClawExecServer, socket: WebSocket): void {
  const session = new CodexSandboxExecSession(execServer, {
    isOpen: () => socket.readyState === socket.OPEN,
    send: (message) => socket.send(JSON.stringify(message)),
  });
  socket.on("message", (data) => {
    void handleMessage(session, data).catch((error: unknown) => {
      embeddedAgentLog.warn("codex sandbox exec-server message failed", { error });
    });
  });
  socket.on("close", () => {
    const cleanup = session.close();
    execServer.cleanupTasks.add(cleanup);
    void cleanup.then(
      () => execServer.cleanupTasks.delete(cleanup),
      (error: unknown) => {
        execServer.cleanupTasks.delete(cleanup);
        embeddedAgentLog.warn("codex sandbox exec-server socket cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
}

function handleExecServerSocketError(error: unknown): void {
  embeddedAgentLog.debug("codex sandbox exec-server websocket failed", { error });
}

async function handleMessage(session: CodexSandboxExecSession, data: RawData): Promise<void> {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  await session.handleRequest(parseRequest(buffer.toString("utf8")));
}
