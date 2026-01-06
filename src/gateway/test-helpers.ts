import fs from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { rawDataToString } from "../infra/ws.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import type { GatewayServerOptions } from "./server.js";

export type BridgeClientInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
};

export type BridgeStartOpts = {
  onAuthenticated?: (node: BridgeClientInfo) => Promise<void> | void;
  onDisconnected?: (node: BridgeClientInfo) => Promise<void> | void;
  onPairRequested?: (request: unknown) => Promise<void> | void;
  onEvent?: (
    nodeId: string,
    evt: { event: string; payloadJSON?: string | null },
  ) => Promise<void> | void;
  onRequest?: (
    nodeId: string,
    req: { id: string; method: string; paramsJSON?: string | null },
  ) => Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  >;
};

const hoisted = vi.hoisted(() => ({
  bridgeStartCalls: [] as BridgeStartOpts[],
  bridgeInvoke: vi.fn(async () => ({
    type: "invoke-res",
    id: "1",
    ok: true,
    payloadJSON: JSON.stringify({ ok: true }),
    error: null,
  })),
  bridgeListConnected: vi.fn(() => [] as BridgeClientInfo[]),
  bridgeSendEvent: vi.fn(),
  testTailnetIPv4: { value: undefined as string | undefined },
  piSdkMock: {
    enabled: false,
    discoverCalls: 0,
    models: [] as Array<{
      id: string;
      name?: string;
      provider: string;
      contextWindow?: number;
      reasoning?: boolean;
    }>,
  },
  cronIsolatedRun: vi.fn(async () => ({ status: "ok", summary: "ok" })),
  agentCommand: vi.fn().mockResolvedValue(undefined),
  testIsNixMode: { value: false },
  sessionStoreSaveDelayMs: { value: 0 },
  embeddedRunMock: {
    activeIds: new Set<string>(),
    abortCalls: [] as string[],
    waitCalls: [] as string[],
    waitResults: new Map<string, boolean>(),
  },
}));

export const bridgeStartCalls = hoisted.bridgeStartCalls;
export const bridgeInvoke = hoisted.bridgeInvoke;
export const bridgeListConnected = hoisted.bridgeListConnected;
export const bridgeSendEvent = hoisted.bridgeSendEvent;
export const testTailnetIPv4 = hoisted.testTailnetIPv4;
export const piSdkMock = hoisted.piSdkMock;
export const cronIsolatedRun = hoisted.cronIsolatedRun;
export const agentCommand = hoisted.agentCommand;

export const testState = {
  agentConfig: undefined as Record<string, unknown> | undefined,
  sessionStorePath: undefined as string | undefined,
  sessionConfig: undefined as Record<string, unknown> | undefined,
  allowFrom: undefined as string[] | undefined,
  cronStorePath: undefined as string | undefined,
  cronEnabled: false as boolean | undefined,
  gatewayBind: undefined as "auto" | "lan" | "tailnet" | "loopback" | undefined,
  gatewayAuth: undefined as Record<string, unknown> | undefined,
  hooksConfig: undefined as Record<string, unknown> | undefined,
  canvasHostPort: undefined as number | undefined,
  legacyIssues: [] as Array<{ path: string; message: string }>,
  legacyParsed: {} as Record<string, unknown>,
  migrationConfig: null as Record<string, unknown> | null,
  migrationChanges: [] as string[],
};

export const testIsNixMode = hoisted.testIsNixMode;
export const sessionStoreSaveDelayMs = hoisted.sessionStoreSaveDelayMs;
export const embeddedRunMock = hoisted.embeddedRunMock;

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@mariozechner/pi-coding-agent")
  >("@mariozechner/pi-coding-agent");

  return {
    ...actual,
    discoverModels: () => {
      if (!piSdkMock.enabled) return actual.discoverModels();
      piSdkMock.discoverCalls += 1;
      return piSdkMock.models;
    },
  };
});

vi.mock("../infra/bridge/server.js", () => ({
  startNodeBridgeServer: vi.fn(async (opts: BridgeStartOpts) => {
    bridgeStartCalls.push(opts);
    return {
      port: 18790,
      close: async () => {},
      listConnected: bridgeListConnected,
      invoke: bridgeInvoke,
      sendEvent: bridgeSendEvent,
    };
  }),
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) => cronIsolatedRun(...args),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => undefined,
}));

vi.mock("../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions.js")>(
    "../config/sessions.js",
  );
  return {
    ...actual,
    saveSessionStore: vi.fn(async (storePath: string, store: unknown) => {
      const delay = sessionStoreSaveDelayMs.value;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return actual.saveSessionStore(storePath, store as never);
    }),
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>(
    "../config/config.js",
  );
  const resolveConfigPath = () =>
    path.join(os.homedir(), ".clawdbot", "clawdbot.json");

  const readConfigFileSnapshot = async () => {
    if (testState.legacyIssues.length > 0) {
      return {
        path: resolveConfigPath(),
        exists: true,
        raw: JSON.stringify(testState.legacyParsed ?? {}),
        parsed: testState.legacyParsed ?? {},
        valid: false,
        config: {},
        issues: testState.legacyIssues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
        legacyIssues: testState.legacyIssues,
      };
    }
    const configPath = resolveConfigPath();
    try {
      await fs.access(configPath);
    } catch {
      return {
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        valid: true,
        config: {},
        issues: [],
        legacyIssues: [],
      };
    }
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        path: configPath,
        exists: true,
        raw,
        parsed,
        valid: true,
        config: parsed,
        issues: [],
        legacyIssues: [],
      };
    } catch (err) {
      return {
        path: configPath,
        exists: true,
        raw: null,
        parsed: {},
        valid: false,
        config: {},
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
        legacyIssues: [],
      };
    }
  };

  const writeConfigFile = vi.fn(async (cfg: Record<string, unknown>) => {
    const configPath = resolveConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const raw = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
    await fs.writeFile(configPath, raw, "utf-8");
  });

  return {
    ...actual,
    CONFIG_PATH_CLAWDBOT: resolveConfigPath(),
    STATE_DIR_CLAWDBOT: path.dirname(resolveConfigPath()),
    get isNixMode() {
      return testIsNixMode.value;
    },
    migrateLegacyConfig: (raw: unknown) => ({
      config: testState.migrationConfig ?? (raw as Record<string, unknown>),
      changes: testState.migrationChanges,
    }),
    loadConfig: () => ({
      agent: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(os.tmpdir(), "clawd-gateway-test"),
        ...testState.agentConfig,
      },
      whatsapp: {
        allowFrom: testState.allowFrom,
      },
      session: {
        mainKey: "main",
        store: testState.sessionStorePath,
        ...testState.sessionConfig,
      },
      gateway: (() => {
        const gateway: Record<string, unknown> = {};
        if (testState.gatewayBind) gateway.bind = testState.gatewayBind;
        if (testState.gatewayAuth) gateway.auth = testState.gatewayAuth;
        return Object.keys(gateway).length > 0 ? gateway : undefined;
      })(),
      canvasHost: (() => {
        const canvasHost: Record<string, unknown> = {};
        if (typeof testState.canvasHostPort === "number")
          canvasHost.port = testState.canvasHostPort;
        return Object.keys(canvasHost).length > 0 ? canvasHost : undefined;
      })(),
      hooks: testState.hooksConfig,
      cron: (() => {
        const cron: Record<string, unknown> = {};
        if (typeof testState.cronEnabled === "boolean")
          cron.enabled = testState.cronEnabled;
        if (typeof testState.cronStorePath === "string")
          cron.store = testState.cronStorePath;
        return Object.keys(cron).length > 0 ? cron : undefined;
      })(),
    }),
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) as unknown };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    validateConfigObject: (parsed: unknown) => ({
      ok: true,
      config: parsed as Record<string, unknown>,
      issues: [],
    }),
    readConfigFileSnapshot,
    writeConfigFile,
  };
});

vi.mock("../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agents/pi-embedded.js")
  >("../agents/pi-embedded.js");
  return {
    ...actual,
    isEmbeddedPiRunActive: (sessionId: string) =>
      embeddedRunMock.activeIds.has(sessionId),
    abortEmbeddedPiRun: (sessionId: string) => {
      embeddedRunMock.abortCalls.push(sessionId);
      return embeddedRunMock.activeIds.has(sessionId);
    },
    waitForEmbeddedPiRunEnd: async (sessionId: string) => {
      embeddedRunMock.waitCalls.push(sessionId);
      return embeddedRunMock.waitResults.get(sessionId) ?? true;
    },
  };
});

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../web/outbound.js", () => ({
  sendMessageWhatsApp: vi
    .fn()
    .mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand,
}));

process.env.CLAWDBOT_SKIP_PROVIDERS = "1";

let previousHome: string | undefined;
let tempHome: string | undefined;

export function installGatewayTestHooks() {
  beforeEach(async () => {
    previousHome = process.env.HOME;
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-gateway-home-"),
    );
    process.env.HOME = tempHome;
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
    testState.allowFrom = undefined;
    testIsNixMode.value = false;
    cronIsolatedRun.mockClear();
    agentCommand.mockClear();
    embeddedRunMock.activeIds.clear();
    embeddedRunMock.abortCalls = [];
    embeddedRunMock.waitCalls = [];
    embeddedRunMock.waitResults.clear();
    drainSystemEvents();
    resetAgentRunContextForTest();
    const mod = await import("./server.js");
    mod.__resetModelCatalogCacheForTest();
    piSdkMock.enabled = false;
    piSdkMock.discoverCalls = 0;
    piSdkMock.models = [];
  }, 60_000);

  afterEach(async () => {
    process.env.HOME = previousHome;
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
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
  timeoutMs = 3000,
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

export async function startGatewayServer(
  port: number,
  opts?: GatewayServerOptions,
) {
  const mod = await import("./server.js");
  return await mod.startGatewayServer(port, opts);
}

export async function startServerWithClient(
  token?: string,
  opts?: GatewayServerOptions,
) {
  const port = await getFreePort();
  const prev = process.env.CLAWDBOT_GATEWAY_TOKEN;
  if (token === undefined) {
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
  } else {
    process.env.CLAWDBOT_GATEWAY_TOKEN = token;
  }
  const server = await startGatewayServer(port, opts);
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
      name: string;
      version: string;
      platform: string;
      mode: string;
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
          name: "test",
          version: "1.0.0",
          platform: "test",
          mode: "test",
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
  return await onceMessage<ConnectResponse>(
    ws,
    (o) => o.type === "res" && o.id === id,
  );
}

export async function connectOk(
  ws: WebSocket,
  opts?: Parameters<typeof connectReq>[1],
) {
  const res = await connectReq(ws, opts);
  expect(res.ok).toBe(true);
  expect((res.payload as { type?: unknown } | undefined)?.type).toBe(
    "hello-ok",
  );
  return res.payload as { type: "hello-ok" };
}

export async function rpcReq<T = unknown>(
  ws: WebSocket,
  method: string,
  params?: unknown,
) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await onceMessage<{
    type: "res";
    id: string;
    ok: boolean;
    payload?: T;
    error?: { message?: string; code?: string };
  }>(ws, (o) => o.type === "res" && o.id === id);
}

export async function waitForSystemEvent(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = peekSystemEvents();
    if (events.length > 0) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for system event");
}
