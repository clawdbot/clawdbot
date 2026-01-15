import fs from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect } from "vitest";
import { WebSocket } from "ws";

import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { rawDataToString } from "../infra/ws.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

import { PROTOCOL_VERSION } from "./protocol/index.js";
import type { GatewayServerOptions } from "./server.js";
import {
  agentCommand,
  cronIsolatedRun,
  embeddedRunMock,
  piSdkMock,
  sessionStoreSaveDelayMs,
  setTestConfigRoot,
  testIsNixMode,
  testState,
  testTailnetIPv4,
} from "./test-helpers.mocks.js";

let previousHome: string | undefined;
let tempHome: string | undefined;
let tempConfigRoot: string | undefined;

export function installGatewayTestHooks() {
  beforeEach(async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
    previousHome = process.env.HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gateway-home-"));
    process.env.HOME = tempHome;
    tempConfigRoot = path.join(tempHome, ".clawdbot-test");
    setTestConfigRoot(tempConfigRoot);
    sessionStoreSaveDelayMs.value = 0;
    testTailnetIPv4.value = undefined;
    testState.gatewayBind = undefined;
    testState.gatewayAuth = undefined;
    testState.hooksConfig = undefined;
    testState.canvasHostPort = undefined;
    testState.legacyIssues = [];
    testState.legacyParsed = {};
    testState.migrationConfig = null;
    testState.migrationChanges = [];
    testState.cronEnabled = false;
    testState.cronStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.sessionStorePath = undefined;
    testState.agentConfig = undefined;
    testState.agentsConfig = undefined;
    testState.bindingsConfig = undefined;
    testState.allowFrom = undefined;
    testIsNixMode.value = false;
    cronIsolatedRun.mockClear();
    agentCommand.mockClear();
    embeddedRunMock.activeIds.clear();
    embeddedRunMock.abortCalls = [];
    embeddedRunMock.waitCalls = [];
    embeddedRunMock.waitResults.clear();
    drainSystemEvents(resolveMainSessionKeyFromConfig());
    resetAgentRunContextForTest();
    const mod = await import("./server.js");
    mod.__resetModelCatalogCacheForTest();
    piSdkMock.enabled = false;
    piSdkMock.discoverCalls = 0;
    piSdkMock.models = [];
  }, 60_000);

  afterEach(async () => {
    resetLogger();
    process.env.HOME = previousHome;
    if (tempHome) {
      await fs.rm(tempHome, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
      tempHome = undefined;
    }
    tempConfigRoot = undefined;
  });
}

let nextTestPortOffset = 0;

export async function getFreePort(): Promise<number> {
  const workerIdRaw = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "";
  const workerId = Number.parseInt(workerIdRaw, 10);
  const shard = Number.isFinite(workerId) ? Math.max(0, workerId) : Math.abs(process.pid);

  // Avoid flaky "get a free port then bind later" races by allocating from a
  // deterministic per-worker port range. Still probe for EADDRINUSE to avoid
  // collisions with external processes.
  const rangeSize = 1000;
  const shardCount = 30;
  const base = 30_000 + (Math.abs(shard) % shardCount) * rangeSize; // <= 59_999

  for (let attempt = 0; attempt < rangeSize; attempt++) {
    const port = base + (nextTestPortOffset++ % rangeSize);
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    if (ok) return port;
  }

  // Fallback: let the OS pick a port.
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function occupyPort(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

export function onceMessage<T = unknown>(
  ws: WebSocket,
  filter: (obj: unknown) => boolean,
  // Full-suite runs can saturate the event loop (581+ files). Keep this high
  // enough to avoid flaky RPC timeouts, but still fail fast when a response
  // never arrives.
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data));
      if (filter(obj)) {
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(obj as T);
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

export async function startGatewayServer(port: number, opts?: GatewayServerOptions) {
  const mod = await import("./server.js");
  return await mod.startGatewayServer(port, opts);
}

export async function startServerWithClient(token?: string, opts?: GatewayServerOptions) {
  let port = await getFreePort();
  const prev = process.env.CLAWDBOT_GATEWAY_TOKEN;
  if (token === undefined) {
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
  } else {
    process.env.CLAWDBOT_GATEWAY_TOKEN = token;
  }

  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      server = await startGatewayServer(port, opts);
      break;
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code !== "EADDRINUSE") throw err;
      port = await getFreePort();
    }
  }
  if (!server) {
    throw new Error("failed to start gateway server after retries");
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return { server, ws, port, prevToken: prev };
}

type ConnectResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

export async function connectReq(
  ws: WebSocket,
  opts?: {
    token?: string;
    password?: string;
    minProtocol?: number;
    maxProtocol?: number;
    client?: {
      id: string;
      displayName?: string;
      version: string;
      platform: string;
      mode: string;
      deviceFamily?: string;
      modelIdentifier?: string;
      instanceId?: string;
    };
  },
): Promise<ConnectResponse> {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: opts?.minProtocol ?? PROTOCOL_VERSION,
        maxProtocol: opts?.maxProtocol ?? PROTOCOL_VERSION,
        client: opts?.client ?? {
          id: GATEWAY_CLIENT_NAMES.TEST,
          version: "1.0.0",
          platform: "test",
          mode: GATEWAY_CLIENT_MODES.TEST,
        },
        caps: [],
        auth:
          opts?.token || opts?.password
            ? {
                token: opts?.token,
                password: opts?.password,
              }
            : undefined,
      },
    }),
  );
  const isResponseForId = (o: unknown): boolean => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    const rec = o as Record<string, unknown>;
    return rec.type === "res" && rec.id === id;
  };
  return await onceMessage<ConnectResponse>(ws, isResponseForId);
}

export async function connectOk(ws: WebSocket, opts?: Parameters<typeof connectReq>[1]) {
  const res = await connectReq(ws, opts);
  expect(res.ok).toBe(true);
  expect((res.payload as { type?: unknown } | undefined)?.type).toBe("hello-ok");
  return res.payload as { type: "hello-ok" };
}

export async function rpcReq<T = unknown>(ws: WebSocket, method: string, params?: unknown) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await onceMessage<{
    type: "res";
    id: string;
    ok: boolean;
    payload?: T;
    error?: { message?: string; code?: string };
  }>(ws, (o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    const rec = o as Record<string, unknown>;
    return rec.type === "res" && rec.id === id;
  });
}

export async function waitForSystemEvent(timeoutMs = 2000) {
  const sessionKey = resolveMainSessionKeyFromConfig();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = peekSystemEvents(sessionKey);
    if (events.length > 0) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for system event");
}
