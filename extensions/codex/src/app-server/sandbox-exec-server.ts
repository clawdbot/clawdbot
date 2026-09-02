/**
 * Hosts the local OpenClaw sandbox exec-server that Codex app-server native
 * execution can register as an external environment.
 */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  createCodexNodeExecServerDisconnectError,
  startCodexNodeExecServerRelay,
} from "./sandbox-exec-server-node-relay.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { parseRequest } from "./sandbox-exec-server/json-rpc.js";
import type { SandboxChildOwner } from "./sandbox-exec-server/sandbox-child.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type {
  CodexNodeExecServerLease,
  OpenClawExecServer,
  OpenClawLeasedExecServer,
  OpenClawNodeExecServer,
} from "./sandbox-exec-server/types.js";

/** Codex environment metadata registered for one sandbox exec-server lease. */
export type CodexSandboxExecEnvironment = {
  environmentId: string;
  cwd: string;
};

const CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES = 100 * 1024 * 1024;
const CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const codexNodeExecServerLeases = new WeakMap<
  CodexSandboxExecEnvironment,
  CodexNodeExecServerLease
>();

/** Starts or reuses a sandbox exec-server and registers it with Codex app-server. */
export async function ensureCodexSandboxExecServerEnvironment(params: {
  client: CodexAppServerClient;
  sandbox: SandboxContext | null;
  runtime?: PluginRuntime;
  appServerStartOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
  onExecutionDisconnect?: (error: Error) => void;
}): Promise<CodexSandboxExecEnvironment | undefined> {
  if (!params.sandbox?.enabled) {
    return undefined;
  }
  const placementNodeId = readCodexPlacementNodeId(params.sandbox);
  if (!params.sandbox.backend && !placementNodeId) {
    return undefined;
  }
  if (placementNodeId && !params.runtime) {
    throw new Error("Codex node execution requires its active plugin runtime.");
  }
  if (!canExposeLocalExecServerToAppServer(params.appServerStartOptions)) {
    throw new Error(
      "OpenClaw Codex exec-server uses a local loopback URL and cannot be registered with a remote Codex app-server.",
    );
  }
  const { server: execServer, nodeLease } = await acquireOpenClawExecServer({
    sandbox: params.sandbox,
    runtime: params.runtime,
    signal: params.signal,
    onExecutionDisconnect: params.onExecutionDisconnect,
  });
  // Codex retains a thread's environment instance when its id and cwd stay equal.
  // A single-use paired-node channel therefore needs a fresh selected identity.
  const environmentId = nodeLease ? `openclaw-node-${nodeLease.id}` : execServer.environmentId;
  try {
    const execServerUrl = nodeLease ? `${execServer.url}?lease=${nodeLease.id}` : execServer.url;
    await params.client.request(
      "environment/add",
      {
        environmentId,
        execServerUrl,
      },
      { timeoutMs: params.timeoutMs, signal: params.signal },
    );
  } catch (error) {
    if (nodeLease && "node" in execServer) {
      closeCodexNodeExecServerLease(execServer, nodeLease);
    }
    await releaseOpenClawExecServer(execServer);
    throw error;
  }
  const environment = {
    environmentId,
    cwd: params.sandbox.containerWorkdir,
  };
  if (nodeLease) {
    codexNodeExecServerLeases.set(environment, nodeLease);
  }
  return environment;
}

/** Releases the sandbox exec-server lease associated with a sandbox runtime. */
export async function releaseCodexSandboxExecServerEnvironment(
  sandbox: SandboxContext | null | undefined,
  environment?: CodexSandboxExecEnvironment,
): Promise<void> {
  if (!sandbox?.enabled) {
    return;
  }
  const server = await sandboxExecServerRegistry.servers
    .get(sandbox.runtimeId)
    ?.catch(() => undefined);
  if (server) {
    const nodeLease = environment && codexNodeExecServerLeases.get(environment);
    if (nodeLease && "node" in server) {
      codexNodeExecServerLeases.delete(environment);
      closeCodexNodeExecServerLease(server, nodeLease);
    }
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

async function acquireOpenClawExecServer(params: {
  sandbox: SandboxContext;
  runtime?: PluginRuntime;
  signal?: AbortSignal;
  onExecutionDisconnect?: (error: Error) => void;
}): Promise<{ server: OpenClawLeasedExecServer; nodeLease?: CodexNodeExecServerLease }> {
  const { sandbox, runtime, signal, onExecutionDisconnect } = params;
  const key = sandbox.runtimeId;
  while (true) {
    const existing = sandboxExecServerRegistry.servers.get(key);
    const promise = existing ?? startAndRememberOpenClawExecServer(sandbox);
    const server = await promise;
    if (!server.closed && sandboxExecServerRegistry.servers.get(key) === promise) {
      server.refCount += 1;
      if (!("node" in server)) {
        return { server };
      }
      if (!runtime || !signal) {
        await releaseOpenClawExecServer(server);
        throw new Error("Codex node execution requires an active runtime and attempt.");
      }
      try {
        const placementIdentity = readCodexPlacementWorkspaceIdentity(sandbox);
        // Capture the admitted caller's exact async scope before a detached WebSocket event.
        const channel = await runtime.nodes.openDuplex({
          nodeId: server.node.id,
          command: "codex.exec-server.stdio.v2",
          params: { cwd: sandbox.containerWorkdir, ...placementIdentity },
          sessionKey: sandbox.sessionKey,
          timeoutMs: 0,
          maxMessageBytes: CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES,
          maxOutstandingDeliveryBytes: CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES + 2 * 1024 * 1024,
          signal,
        });
        if (
          signal.aborted ||
          server.closed ||
          sandboxExecServerRegistry.servers.get(key) !== promise
        ) {
          channel.close();
          throw new Error("Codex node execution retired before its channel was ready.");
        }
        const nodeLease = {
          id: randomUUID(),
          channel,
          claimed: false,
          closed: false,
          onDisconnected: onExecutionDisconnect,
        };
        server.node.leases.set(nodeLease.id, nodeLease);
        // The approved child can exit before app-server claims its loopback socket.
        // Observe that lifetime immediately instead of losing its terminal fact.
        void channel.closed
          .then(
            () => handleClosedCodexNodeExecServerLease(server, nodeLease, { failed: false }),
            (error: unknown) =>
              handleClosedCodexNodeExecServerLease(server, nodeLease, { failed: true, error }),
          )
          .catch((error: unknown) => {
            embeddedAgentLog.warn("codex paired-device exec-server lease cleanup failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return { server, nodeLease };
      } catch (error) {
        await releaseOpenClawExecServer(server);
        throw error;
      }
    }
  }
}

function startAndRememberOpenClawExecServer(
  sandbox: SandboxContext,
): Promise<OpenClawLeasedExecServer> {
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

async function startOpenClawExecServer(sandbox: SandboxContext): Promise<OpenClawLeasedExecServer> {
  const backend = sandbox.backend;
  const fsBridge = sandbox.fsBridge;
  const placementNodeId = readCodexPlacementNodeId(sandbox);
  let connection:
    | { kind: "node"; id: string }
    | {
        kind: "sandbox";
        backend: NonNullable<SandboxContext["backend"]>;
        fsBridge: NonNullable<SandboxContext["fsBridge"]>;
      };
  if (placementNodeId) {
    connection = { kind: "node", id: placementNodeId };
  } else {
    if (!backend) {
      throw new Error("OpenClaw sandbox backend is unavailable.");
    }
    if (!fsBridge) {
      throw new Error("Sandbox filesystem bridge is unavailable.");
    }
    connection = { kind: "sandbox", backend, fsBridge };
  }
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    // Match ws' historical default: Codex fs/writeFile sends one base64 JSON-RPC
    // frame, while the socket error handler below makes oversize frames nonfatal.
    maxPayload:
      connection.kind === "node"
        ? CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES
        : CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OpenClaw Codex exec-server did not bind to a TCP port.");
  }
  const environmentId = buildEnvironmentId(sandbox);
  const authPath = `/openclaw-${randomUUID()}`;
  const url = `ws://127.0.0.1:${(address as AddressInfo).port}${authPath}`;
  const common = {
    authPath,
    closed: false,
    environmentId,
    refCount: 0,
    url,
    sandbox,
    server,
    children: new Set<SandboxChildOwner>(),
    cleanupTasks: new Set<Promise<void>>(),
  };
  const execServer: OpenClawLeasedExecServer =
    connection.kind === "node"
      ? { ...common, node: { id: connection.id, leases: new Map() } }
      : {
          ...common,
          backend: connection.backend,
          fsBridge: connection.fsBridge,
          // Bind isolation to this provisioned runtime, not mutable config or request claims.
          networkIsolated:
            (connection.backend.id === "docker" || connection.backend.id === "podman") &&
            sandbox.docker.network.trim().toLowerCase() === "none",
        };
  server.on("connection", (socket, request) => {
    // ws emits error for maxPayload rejections before auth or JSON-RPC sees the frame.
    socket.on("error", handleExecServerSocketError);
    if (!isAuthorizedExecServerRequest(execServer, request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    if ("node" in execServer) {
      handleNodeConnection(execServer, socket, request);
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

async function releaseOpenClawExecServer(execServer: OpenClawLeasedExecServer): Promise<void> {
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
  execServer: OpenClawLeasedExecServer,
  request: IncomingMessage,
): boolean {
  const url = new URL(request.url ?? "", "ws://127.0.0.1");
  return url.pathname === execServer.authPath;
}

function readCodexPlacementNodeId(sandbox: SandboxContext): string | undefined {
  if (
    !("placementExecutionMode" in sandbox) ||
    sandbox.placementExecutionMode !== "remote-exec" ||
    !("placementNodeId" in sandbox) ||
    typeof sandbox.placementNodeId !== "string" ||
    !sandbox.placementNodeId
  ) {
    return undefined;
  }
  return sandbox.placementNodeId;
}

function readCodexPlacementWorkspaceIdentity(sandbox: SandboxContext): {
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  sessionKey: string;
} {
  if (
    !("placementEnvironmentId" in sandbox) ||
    typeof sandbox.placementEnvironmentId !== "string" ||
    !sandbox.placementEnvironmentId ||
    sandbox.placementEnvironmentId.trim() !== sandbox.placementEnvironmentId ||
    !("placementSessionId" in sandbox) ||
    typeof sandbox.placementSessionId !== "string" ||
    !sandbox.placementSessionId ||
    sandbox.placementSessionId.trim() !== sandbox.placementSessionId ||
    !("placementOwnerEpoch" in sandbox) ||
    typeof sandbox.placementOwnerEpoch !== "number" ||
    !Number.isSafeInteger(sandbox.placementOwnerEpoch) ||
    sandbox.placementOwnerEpoch < 1 ||
    !sandbox.sessionKey ||
    sandbox.sessionKey.trim() !== sandbox.sessionKey
  ) {
    throw new Error("Codex node execution requires its exact placement workspace identity.");
  }
  return {
    environmentId: sandbox.placementEnvironmentId,
    sessionId: sandbox.placementSessionId,
    ownerEpoch: sandbox.placementOwnerEpoch,
    sessionKey: sandbox.sessionKey,
  };
}

function handleNodeConnection(
  execServer: OpenClawNodeExecServer,
  socket: WebSocket,
  request: IncomingMessage,
): void {
  const leaseId = new URL(request.url ?? "", "ws://127.0.0.1").searchParams.get("lease");
  const lease = leaseId ? execServer.node.leases.get(leaseId) : undefined;
  if (!lease || lease.claimed || lease.closed) {
    socket.close(1008, "execution channel unavailable");
    return;
  }
  // stdio has exactly one connection; a fresh attempt always owns a fresh channel.
  lease.claimed = true;
  const cleanup = startCodexNodeExecServerRelay({ lease, socket });
  execServer.cleanupTasks.add(cleanup);
  void cleanup.then(
    () => execServer.cleanupTasks.delete(cleanup),
    (error: unknown) => {
      execServer.cleanupTasks.delete(cleanup);
      embeddedAgentLog.warn("codex paired-device exec-server relay failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

function closeCodexNodeExecServerLease(
  execServer: OpenClawNodeExecServer,
  lease: CodexNodeExecServerLease,
): void {
  execServer.node.leases.delete(lease.id);
  if (!lease.closed) {
    lease.closed = true;
    lease.closeRelay?.();
    lease.channel.close();
  }
}

function handleClosedCodexNodeExecServerLease(
  execServer: OpenClawNodeExecServer,
  lease: CodexNodeExecServerLease,
  result: { failed: boolean; error?: unknown },
): void {
  if (lease.closed) {
    return;
  }
  if (lease.onChannelClosed) {
    lease.onChannelClosed(result);
    return;
  }
  try {
    lease.onDisconnected?.(
      createCodexNodeExecServerDisconnectError(
        result.failed ? "execution node failed" : "execution node disconnected",
        result.error,
      ),
    );
  } finally {
    closeCodexNodeExecServerLease(execServer, lease);
  }
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
