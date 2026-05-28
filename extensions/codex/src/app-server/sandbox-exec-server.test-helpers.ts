import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { vi } from "vitest";
import WebSocket from "ws";

type RpcResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
};

export function createSandboxContext(overrides: {
  buildExecSpec?: NonNullable<SandboxContext["backend"]>["buildExecSpec"];
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  mkdirp?: NonNullable<SandboxContext["fsBridge"]>["mkdirp"];
  readFile?: NonNullable<SandboxContext["fsBridge"]>["readFile"];
  remove?: NonNullable<SandboxContext["fsBridge"]>["remove"];
  runShellCommand?: NonNullable<SandboxContext["backend"]>["runShellCommand"];
  stat?: NonNullable<SandboxContext["fsBridge"]>["stat"];
  writeFile?: NonNullable<SandboxContext["fsBridge"]>["writeFile"];
}): SandboxContext {
  return {
    enabled: true,
    backendId: "docker",
    sessionKey: "agent:codex:test",
    workspaceDir: "/host/workspace",
    agentWorkspaceDir: "/host/workspace",
    workspaceAccess: "rw",
    runtimeId: "openclaw-test-runtime",
    runtimeLabel: "openclaw-test-runtime",
    containerName: "openclaw-test-runtime",
    containerWorkdir: "/workspace",
    docker: { binds: [], image: "test", workdir: "/workspace", env: {}, network: "none" },
    tools: {},
    browserAllowHostControl: false,
    backend: {
      id: "docker",
      runtimeId: "openclaw-test-runtime",
      runtimeLabel: "openclaw-test-runtime",
      workdir: "/workspace",
      buildExecSpec:
        overrides.buildExecSpec ??
        (async () => ({
          argv: [process.execPath, "-e", ""],
          env: { PATH: process.env.PATH },
          stdinMode: "pipe-closed",
        })),
      finalizeExec: overrides.finalizeExec,
      runShellCommand:
        overrides.runShellCommand ??
        (async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 })),
    },
    fsBridge: {
      resolvePath: ({
        filePath,
      }: Parameters<NonNullable<SandboxContext["fsBridge"]>["resolvePath"]>[0]) => ({
        relativePath: filePath,
        containerPath: filePath,
      }),
      readFile: overrides.readFile ?? (async () => Buffer.alloc(0)),
      writeFile: overrides.writeFile ?? (async () => undefined),
      mkdirp: overrides.mkdirp ?? (async () => undefined),
      remove: overrides.remove ?? (async () => undefined),
      rename: async () => undefined,
      stat:
        overrides.stat ??
        (async ({ filePath }) => ({
          type: /\.[^/]+$/u.test(filePath) ? "file" : "directory",
          size: 1,
          mtimeMs: 1,
        })),
    },
  } as unknown as SandboxContext;
}

export function createClient(options: { serverVersion?: string } = {}) {
  return {
    getServerVersion: vi.fn(() => options.serverVersion ?? "0.132.0"),
    request: vi.fn(async (_method: string, _params?: unknown) => ({})),
  };
}

export function execServerUrlFromClient(
  client: ReturnType<typeof createClient>,
  callIndex = 0,
): string {
  const params = client.request.mock.calls[callIndex]?.[1];
  if (!params || typeof params !== "object" || !("execServerUrl" in params)) {
    throw new Error(`missing execServerUrl for environment/add call ${callIndex}`);
  }
  const { execServerUrl } = params as { execServerUrl?: unknown };
  if (typeof execServerUrl !== "string" || !execServerUrl) {
    throw new Error(`invalid execServerUrl for environment/add call ${callIndex}`);
  }
  return execServerUrl;
}

export function codexFsSandboxContext(params: {
  entries: Array<{ path: unknown; access: "read" | "write" | "none" | "deny" }>;
  cwd?: string;
}): unknown {
  return {
    permissions: {
      type: "managed",
      file_system: {
        type: "restricted",
        entries: params.entries,
      },
      network: "restricted",
    },
    cwd: params.cwd ?? "/workspace",
    windowsSandboxLevel: "disabled",
    windowsSandboxPrivateDesktop: false,
    useLegacyLandlock: false,
  };
}

export function specialPath(kind: string, subpath?: string): unknown {
  return {
    type: "special",
    value: {
      kind,
      ...(subpath ? { subpath } : {}),
    },
  };
}

export function globPath(pattern: string): unknown {
  return {
    type: "glob_pattern",
    pattern,
  };
}

export function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function collectNotifications(
  socket: WebSocket,
): Array<{ method: string; params?: unknown }> {
  const notifications: Array<{ method: string; params?: unknown }> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as {
      id?: number;
      method?: string;
      params?: unknown;
    };
    if (message.id === undefined && message.method) {
      notifications.push({ method: message.method, params: message.params });
    }
  });
  return notifications;
}

export async function readUntilClosed(
  socket: WebSocket,
  processId: string,
): Promise<{
  chunks?: Array<{ stream: string; chunk: string }>;
  exited?: boolean;
  exitCode?: number;
  closed?: boolean;
  nextSeq?: number;
}> {
  let afterSeq = 0;
  const chunks: Array<{ stream: string; chunk: string }> = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = (await rpc(socket, "process/read", {
      processId,
      afterSeq,
      waitMs: 1000,
    })) as {
      chunks?: Array<{ seq?: number; stream: string; chunk: string }>;
      exited?: boolean;
      exitCode?: number;
      closed?: boolean;
      nextSeq?: number;
    };
    chunks.push(...(read.chunks ?? []));
    afterSeq = Math.max(afterSeq, (read.nextSeq ?? 1) - 1);
    if (read.closed) {
      return { ...read, chunks };
    }
  }
  throw new Error(`process ${processId} did not close`);
}

export function waitForSocketClose(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve({ code }));
  });
}

export async function waitForHttpBodyDeltas(
  notifications: Array<{ method: string; params?: unknown }>,
  count: number,
): Promise<unknown[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const deltas = notifications
      .filter((notification) => notification.method === "http/request/bodyDelta")
      .map((notification) => notification.params);
    if (deltas.length >= count) {
      return deltas;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} http body deltas`);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function rpc(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const response = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as RpcResponse;
      if (response.id !== id) {
        return;
      }
      socket.off("message", onMessage);
      if (response.error) {
        reject(new Error(response.error.message));
        return;
      }
      resolve(response.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
