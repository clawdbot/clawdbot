// Gateway chat integration tests cover dashboard chat requests, transcript
// history limits, model overrides, inbound dispatch, and streaming event fanout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { clearConfigCache } from "../config/config.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/shared-types.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  getReplyFromConfig,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 250, interval: 2 } as const;
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let harness: GatewayHarness;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
});

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
};

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

async function withGatewayChatHarness(
  run: (ctx: { ws: GatewaySocket; createSessionDir: () => Promise<string> }) => Promise<void>,
  options?: { headers?: Record<string, string> },
) {
  const tempDirs: string[] = [];
  const ws = await harness.openWs(options?.headers);
  const createSessionDir = async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    tempDirs.push(sessionDir);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    return sessionDir;
  };

  try {
    await run({ ws, createSessionDir });
  } finally {
    setMaxChatHistoryMessagesBytesForTest();
    if (process.env.OPENCLAW_CONFIG_PATH) {
      await fs.rm(process.env.OPENCLAW_CONFIG_PATH, { force: true });
    }
    clearConfigCache();
    testState.sessionStorePath = undefined;
    ws.close();
    await Promise.all(
      tempDirs.map((dir) =>
        fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
    );
  }
}

async function writeMainSessionStore() {
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  clearConfigCache();
}

async function writeMainSessionTranscript(sessionDir: string, lines: string[]) {
  await fs.writeFile(path.join(sessionDir, "sess-main.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

async function readTimelineEvents(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function fetchHistoryMessages(
  ws: GatewaySocket,
  params?: {
    limit?: number;
    maxChars?: number;
  },
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
    sessionKey: "main",
    limit: params?.limit ?? 1000,
    ...(typeof params?.maxChars === "number" ? { maxChars: params.maxChars } : {}),
  });
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

async function fetchChatMessage(
  ws: GatewaySocket,
  params: {
    sessionKey: string;
    agentId?: string;
    messageId: string;
    maxChars?: number;
  },
): Promise<{
  ok?: boolean;
  message?: unknown;
  unavailableReason?: "not_found" | "oversized" | "not_visible";
}> {
  const res = await rpcReq<{
    ok?: boolean;
    message?: unknown;
    unavailableReason?: "not_found" | "oversized" | "not_visible";
  }>(ws, "chat.message.get", {
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    messageId: params.messageId,
    ...(typeof params.maxChars === "number" ? { maxChars: params.maxChars } : {}),
  });
  if (!res.ok) {
    throw new Error(`chat.message.get rpc failed: ${JSON.stringify(res.error ?? null)}`);
  }
  return res.payload ?? {};
}

type ConfiguredImageModelCase = {
  id: string;
  imageModel: AgentModelConfig;
};

const configuredImageModelCases: ConfiguredImageModelCase[] = [
  {
    id: "with-image-fallback",
    imageModel: { primary: "openai/gpt-4o", fallbacks: ["openai/gpt-4o-mini"] },
  },
  {
    id: "without-image-fallback",
    imageModel: { primary: "openai/gpt-4o" },
  },
];

async function prepareMainHistoryHarness(params: {
  ws: GatewaySocket;
  createSessionDir: () => Promise<string>;
  historyMaxBytes?: number;
}) {
  if (params.historyMaxBytes !== undefined) {
    setMaxChatHistoryMessagesBytesForTest(params.historyMaxBytes);
  }
  await connectOk(params.ws);
  const sessionDir = await params.createSessionDir();
  await writeMainSessionStore();
  return sessionDir;
}

describe("gateway server chat", () => {
  test("chat.history returns catalog-backed session metadata with history", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      testState.agentConfig = {
        model: { primary: "test-provider/catalog-model" },
      };
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "catalog-model",
            updatedAt: Date.now(),
          },
        },
      });
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalog"]>()
          .mockResolvedValue([
            {
              provider: "test-provider",
              id: "catalog-model",
              name: "Catalog Model",
              reasoning: true,
              compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
            },
          ]),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      } as unknown as GatewayRequestContext;
      const { chatHandlers } = await import("./server-methods/chat.js");

      await chatHandlers["chat.history"]({
        req: {
          type: "req",
          id: "history-no-catalog",
          method: "chat.history",
          params: { sessionKey: "main" },
        },
        params: { sessionKey: "main" },
        client: null,
        isWebchatConnect: () => false,
        respond: ((ok, payload, error) => {
          responses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(context.loadGatewayModelCatalog).toHaveBeenCalledTimes(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.ok).toBe(true);
      const payload = responses[0]?.payload as
        | {
            sessionKey?: string;
            sessionId?: string;
            messages?: unknown;
            defaults?: {
              modelProvider?: string | null;
              thinkingLevels?: Array<{ id?: string }>;
            };
            sessionInfo?: {
              key?: string;
              sessionId?: string;
              modelProvider?: string;
              model?: string;
              thinkingLevels?: Array<{ id?: string }>;
            };
          }
        | undefined;
      expect(payload?.sessionKey).toBe("main");
      expect(payload?.sessionId).toBe("sess-main");
      expect(payload?.defaults?.modelProvider).toBe("test-provider");
      expect(payload?.defaults?.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
      expect(payload?.sessionInfo).toMatchObject({
        key: "agent:main:main",
        sessionId: "sess-main",
        modelProvider: "test-provider",
        model: "catalog-model",
      });
      expect(payload?.sessionInfo?.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
      expect(Array.isArray(payload?.messages)).toBe(true);
    } finally {
      clearConfigCache();
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.history exposes persisted and synthetic session metadata for startup hydration", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const updatedAt = Date.now();
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt,
            modelProvider: "openai",
            model: "gpt-5",
            contextTokens: 128_000,
          },
        },
      });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "persisted metadata" }],
            timestamp: updatedAt,
          },
        }),
      ]);

      const persisted = await rpcReq<{
        defaults?: { modelProvider?: string | null; model?: string | null };
        sessionInfo?: {
          key?: string;
          sessionId?: string;
          updatedAt?: number | null;
          modelProvider?: string | null;
          model?: string | null;
          contextTokens?: number | null;
        };
      }>(ws, "chat.history", { sessionKey: "main" });

      expect(persisted.ok).toBe(true);
      expect(persisted.payload?.defaults?.modelProvider).toBeTruthy();
      expect(persisted.payload?.defaults?.model).toBeTruthy();
      expect(persisted.payload?.sessionInfo).toMatchObject({
        key: "agent:main:main",
        sessionId: "sess-main",
        updatedAt,
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: 128_000,
      });

      await writeSessionStore({ entries: {} });
      const synthetic = await rpcReq<{
        defaults?: { modelProvider?: string | null; model?: string | null };
        sessionInfo?: {
          key?: string;
          sessionId?: string;
          updatedAt?: number | null;
          modelProvider?: string | null;
          model?: string | null;
          contextTokens?: number | null;
        };
      }>(ws, "chat.history", { sessionKey: "main" });

      expect(synthetic.ok).toBe(true);
      expect(synthetic.payload?.defaults?.modelProvider).toBeTruthy();
      expect(synthetic.payload?.defaults?.model).toBeTruthy();
      expect(synthetic.payload?.sessionInfo?.key).toBe("agent:main:main");
      expect(synthetic.payload?.sessionInfo?.sessionId).toBeUndefined();
      expect(synthetic.payload?.sessionInfo?.updatedAt).toBeNull();
      expect(synthetic.payload?.sessionInfo?.modelProvider).toBeTruthy();
      expect(synthetic.payload?.sessionInfo?.model).toBeTruthy();
      expect(synthetic.payload?.sessionInfo?.contextTokens).toEqual(expect.any(Number));
    });
  });

  test("chat.startup returns chat history with the initial agents list", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const updatedAt = Date.now();
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt,
            modelProvider: "openai",
            model: "gpt-5",
          },
        },
      });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "startup hydrate" }],
            timestamp: updatedAt,
          },
        }),
      ]);

      const startup = await rpcReq<{
        agentsList?: {
          agents?: Array<{ id?: string }>;
          defaultId?: string | null;
          mainKey?: string | null;
        };
        messages?: unknown[];
        sessionInfo?: { key?: string; sessionId?: string };
      }>(ws, "chat.startup", { sessionKey: "main" });

      expect(startup.ok).toBe(true);
      expect(startup.payload?.agentsList?.defaultId).toBe("main");
      expect(startup.payload?.agentsList?.mainKey).toBe("main");
      expect(startup.payload?.agentsList?.agents?.map((agent) => agent.id)).toContain("main");
      expect(startup.payload?.sessionInfo).toMatchObject({
        key: "agent:main:main",
        sessionId: "sess-main",
      });
      expect(startup.payload?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "startup hydrate" }],
          }),
        ]),
      );
    });
  });

  test("chat.metadata coalesces configured models and text commands", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await writeGatewayConfig({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-main",
              fallbacks: ["openai/gpt-fallback"],
            },
            models: {
              "openai/gpt-main": {},
            },
          },
          list: [
            { id: "main", default: true },
            {
              id: "work",
              model: {
                primary: "minimax/MiniMax-M2.7-highspeed",
              },
            },
          ],
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [
                { id: "gpt-main", name: "GPT Main" },
                { id: "gpt-fallback", name: "GPT Fallback" },
              ],
            },
            minimax: {
              baseUrl: "https://minimax.example.com/v1",
              models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
            },
          },
        },
      });
      await connectOk(ws);

      const metadata = await rpcReq<{
        commands?: Array<{ name?: string; textAliases?: string[] }>;
        models?: Array<{ id?: string; provider?: string }>;
      }>(ws, "chat.metadata", { agentId: "work" });

      expect(metadata.ok).toBe(true);
      expect(metadata.payload?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "MiniMax-M2.7-highspeed",
            provider: "minimax",
          }),
        ]),
      );
      expect(metadata.payload?.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "model",
            textAliases: expect.arrayContaining(["/model"]),
          }),
        ]),
      );
    });
  });

  test("chat.send returns in_flight when duplicate attachment send wins parsing race", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "vision-model",
            updatedAt: Date.now(),
          },
        },
      });

      const firstCatalog =
        createDeferred<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalog"]>()
          .mockImplementationOnce(() => firstCatalog.promise)
          .mockResolvedValue([
            {
              id: "vision-model",
              name: "Vision Model",
              provider: "test-provider",
              input: ["text", "image"],
            },
          ]),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        clearChatRunState: vi.fn(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        getRuntimeConfig: () => ({}),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      const params = {
        sessionKey: "main",
        message: "see image",
        idempotencyKey: "idem-attachment-race",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: pngB64,
          },
        ],
      };
      const { chatHandlers } = await import("./server-methods/chat.js");
      const callSend = (id: string) =>
        chatHandlers["chat.send"]({
          req: { type: "req", id, method: "chat.send", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      const first = Promise.resolve(callSend("first"));
      await vi.waitFor(() => {
        expect(context.loadGatewayModelCatalog).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      await callSend("duplicate");
      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "in_flight" },
          error: undefined,
        },
      ]);

      firstCatalog.resolve([
        {
          id: "vision-model",
          name: "Vision Model",
          provider: "test-provider",
          input: ["text", "image"],
        },
      ]);
      await first;

      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "in_flight" },
          error: undefined,
        },
        {
          id: "first",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "started" },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(context.addChatRun).toHaveBeenCalledTimes(1);
      dispatchRelease.resolve();
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.abort cancels chat.send during attachment preparation before ACK", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const firstCatalog =
      createDeferred<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "vision-model",
            updatedAt: Date.now(),
          },
        },
      });

      const sendResponses: Array<{
        id: string;
        ok: boolean;
        payload?: unknown;
        error?: unknown;
      }> = [];
      const abortResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalog"]>()
          .mockImplementationOnce(() => firstCatalog.promise),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        clearChatRunState: vi.fn(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        getRuntimeConfig: () => ({}),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      const params = {
        sessionKey: "main",
        message: "abort this image",
        idempotencyKey: "idem-attachment-abort",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: pngB64,
          },
        ],
      };
      const client = {
        connId: "conn-owner",
        connect: {
          device: { id: "dev-owner" },
          scopes: ["operator.write"],
        },
      } as never;
      const { chatHandlers } = await import("./server-methods/chat.js");
      const first = Promise.resolve(
        chatHandlers["chat.send"]({
          req: { type: "req", id: "first", method: "chat.send", params },
          params,
          client,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            sendResponses.push({ id: "first", ok, payload, error });
          }) as RespondFn,
          context,
        }),
      );
      await vi.waitFor(() => {
        expect(context.loadGatewayModelCatalog).toHaveBeenCalledTimes(1);
        expect(context.chatAbortControllers.has("idem-attachment-abort")).toBe(true);
      }, FAST_WAIT_OPTS);

      await chatHandlers["chat.abort"]({
        req: {
          type: "req",
          id: "abort",
          method: "chat.abort",
          params: { sessionKey: "main", runId: "idem-attachment-abort" },
        },
        params: { sessionKey: "main", runId: "idem-attachment-abort" },
        client,
        isWebchatConnect: () => false,
        respond: ((ok, payload, error) => {
          abortResponses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(abortResponses).toEqual([
        {
          ok: true,
          payload: { ok: true, aborted: true, runIds: ["idem-attachment-abort"] },
          error: undefined,
        },
      ]);
      expect(context.chatAbortControllers.has("idem-attachment-abort")).toBe(false);

      await chatHandlers["chat.send"]({
        req: { type: "req", id: "retry", method: "chat.send", params },
        params,
        client,
        isWebchatConnect: () => false,
        respond: ((ok, payload, error) => {
          sendResponses.push({ id: "retry", ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(sendResponses).toEqual([
        {
          id: "retry",
          ok: true,
          payload: {
            runId: "idem-attachment-abort",
            status: "timeout",
            summary: "aborted",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);

      firstCatalog.resolve([
        {
          id: "vision-model",
          name: "Vision Model",
          provider: "test-provider",
          input: ["text", "image"],
        },
      ]);
      await first;

      expect(sendResponses).toEqual([
        {
          id: "retry",
          ok: true,
          payload: {
            runId: "idem-attachment-abort",
            status: "timeout",
            summary: "aborted",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
        {
          id: "first",
          ok: true,
          payload: {
            runId: "idem-attachment-abort",
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(context.addChatRun).not.toHaveBeenCalled();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
    } finally {
      firstCatalog.resolve([]);
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test.each(configuredImageModelCases)(
    "chat.send preserves text-only image uploads as MediaPaths even with configured imageModel: $id",
    async ({ id, imageModel }) => {
      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      try {
        testState.sessionStorePath = path.join(sessionDir, "sessions.json");
        testState.agentConfig = {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-haiku-4-6"],
          },
          imageModel,
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        };
        await writeSessionStore({
          entries: {
            main: {
              sessionId: "sess-main",
              modelProvider: "anthropic",
              model: "claude-opus-4-6",
              updatedAt: Date.now(),
            },
          },
        });

        const context = {
          loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
            async () => [
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                input: ["text"],
              },
              {
                id: "gpt-4o",
                name: "GPT-4o",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "gpt-4o-mini",
                name: "GPT-4o mini",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "claude-haiku-4-6",
                name: "Claude Haiku 4.6",
                provider: "anthropic",
                input: ["text"],
              },
            ],
          ),
          logGateway: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
          agentRunSeq: new Map<string, number>(),
          chatAbortControllers: new Map(),
          chatAbortedRuns: new Map(),
          chatRunBuffers: new Map(),
          chatDeltaSentAt: new Map(),
          chatDeltaLastBroadcastLen: new Map(),
          chatDeltaLastBroadcastText: new Map(),
          addChatRun: vi.fn(),
          removeChatRun: vi.fn(),
          broadcast: vi.fn(),
          nodeSendToSession: vi.fn(),
          registerToolEventRecipient: vi.fn(),
          dedupe: new Map(),
        } as unknown as GatewayRequestContext;
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
        let captured: { ctx?: Record<string, unknown>; replyOptions?: GetReplyOptions } | undefined;
        dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
          const [params] = args as [
            {
              ctx: Record<string, unknown>;
              replyOptions?: GetReplyOptions;
            },
          ];
          captured = {
            ctx: params.ctx,
            replyOptions: params.replyOptions,
          };
        });

        const { chatHandlers } = await import("./server-methods/chat.js");
        const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
        await chatHandlers["chat.send"]({
          req: {
            type: "req",
            id: `configured-image-model-${id}`,
            method: "chat.send",
            params: {
              sessionKey: "main",
              message: "see image",
              idempotencyKey: `idem-configured-image-model-${id}`,
              attachments: [
                {
                  type: "image",
                  mimeType: "image/png",
                  fileName: "dot.png",
                  content: pngB64,
                },
              ],
            },
          },
          params: {
            sessionKey: "main",
            message: "see image",
            idempotencyKey: `idem-configured-image-model-${id}`,
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "dot.png",
                content: pngB64,
              },
            ],
          },
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            responses.push({ ok, payload, error });
          }) as RespondFn,
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        await vi.waitFor(() => expect(captured).toBeDefined(), FAST_WAIT_OPTS);
        expect(captured?.replyOptions?.images).toBeUndefined();
        expect(captured?.ctx?.MediaPath).toEqual(expect.any(String));
        expect(captured?.ctx?.MediaPaths).toEqual([expect.any(String)]);
        expect(captured?.ctx?.MediaType).toBe("image/png");
        expect(captured?.ctx?.MediaTypes).toEqual(["image/png"]);
        expect(captured?.ctx?.MediaStaged).toBe(true);
        await vi.waitFor(() => expect(context.removeChatRun).toHaveBeenCalledTimes(1));
      } finally {
        dispatchInboundMessageMock.mockReset();
        testState.agentConfig = undefined;
        testState.sessionStorePath = undefined;
        clearConfigCache();
        await fs.rm(sessionDir, { recursive: true, force: true });
      }
    },
  );

  test("chat.send reuses only active WebChat text sends with the same system context", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        clearChatRunState: vi.fn(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);

      const { chatHandlers } = await import("./server-methods/chat.js");
      const callSend = (id: string, idempotencyKey: string, systemProvenanceReceipt?: string) =>
        chatHandlers["chat.send"]({
          req: {
            type: "req",
            id,
            method: "chat.send",
            params: {
              sessionKey: "main",
              message: "?",
              idempotencyKey,
              ...(systemProvenanceReceipt ? { systemProvenanceReceipt } : {}),
            },
          },
          params: {
            sessionKey: "main",
            message: "?",
            idempotencyKey,
            ...(systemProvenanceReceipt ? { systemProvenanceReceipt } : {}),
          },
          client: {
            connect: {
              client: {
                id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
                mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              },
              scopes: ["operator.write", "operator.admin"],
            },
          } as never,
          isWebchatConnect: () => true,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      const first = Promise.resolve(callSend("first", "idem-active-a"));
      await vi.waitFor(
        () => {
          expect(responses).toEqual([
            {
              id: "first",
              ok: true,
              payload: expect.objectContaining({
                runId: "idem-active-a",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
              error: undefined,
            },
          ]);
        },
        { timeout: 2_000, interval: 5 },
      );

      await callSend("duplicate", "idem-active-b");

      expect(responses).toEqual([
        {
          id: "first",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-active-a",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-active-a", status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(context.addChatRun).toHaveBeenCalledTimes(1);

      const withSystemContext = Promise.resolve(
        callSend("system-context", "idem-active-c", "proposal=support-file-sampler-b"),
      );

      await vi.waitFor(
        () => {
          expect(responses).toEqual([
            {
              id: "first",
              ok: true,
              payload: expect.objectContaining({
                runId: "idem-active-a",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
              error: undefined,
            },
            {
              id: "duplicate",
              ok: true,
              payload: { runId: "idem-active-a", status: "in_flight" },
              error: undefined,
            },
            {
              id: "system-context",
              ok: true,
              payload: expect.objectContaining({
                runId: "idem-active-c",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
              error: undefined,
            },
          ]);
        },
        { timeout: 2_000, interval: 5 },
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(context.addChatRun).toHaveBeenCalledTimes(2);

      dispatchRelease.resolve();
      await Promise.all([first, withSystemContext]);
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(2);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send can suppress command interpretation for slash-prefixed system turns", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        clearChatRunState: vi.fn(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockResolvedValue({});

      const { chatHandlers } = await import("./server-methods/chat.js");
      await chatHandlers["chat.send"]({
        req: {
          type: "req",
          id: "suppressed-command",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "/reset examples",
            suppressCommandInterpretation: true,
            idempotencyKey: "idem-suppressed-command",
          },
        },
        params: {
          sessionKey: "main",
          message: "/reset examples",
          suppressCommandInterpretation: true,
          idempotencyKey: "idem-suppressed-command",
        },
        client: {
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            },
            scopes: ["operator.write", "operator.admin"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: ((ok, payload, error) => {
          responses.push({ id: "suppressed-command", ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(responses).toEqual([
        {
          id: "suppressed-command",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-suppressed-command",
            status: "started",
          }),
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      const dispatchContext = (
        dispatchInboundMessageMock.mock.calls[0]?.[0] as { ctx?: Record<string, unknown> }
      )?.ctx;
      expect(dispatchContext).toMatchObject({
        Body: "/reset examples",
        BodyForCommands: "/reset examples",
        CommandAuthorized: false,
        CommandTurn: {
          kind: "normal",
          source: "message",
          authorized: false,
          body: "/reset examples",
        },
        RawBody: "/reset examples",
      });
      expect(dispatchContext).not.toHaveProperty("CommandSource");
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send starts the next WebChat turn after the prior internal run finishes", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        clearChatRunState: vi.fn(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockResolvedValue(undefined);

      const { chatHandlers } = await import("./server-methods/chat.js");
      const callSend = (id: string, message: string, idempotencyKey: string) =>
        chatHandlers["chat.send"]({
          req: {
            type: "req",
            id,
            method: "chat.send",
            params: {
              sessionKey: "main",
              message,
              idempotencyKey,
            },
          },
          params: {
            sessionKey: "main",
            message,
            idempotencyKey,
          },
          client: {
            connect: {
              client: {
                id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
                mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              },
              scopes: ["operator.write"],
            },
          } as never,
          isWebchatConnect: () => true,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      await callSend("first", "first message", "idem-sequential-a");
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      await callSend("second", "second message", "idem-sequential-b");
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(2);
      }, FAST_WAIT_OPTS);

      expect(responses).toEqual([
        {
          id: "first",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-sequential-a",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
        {
          id: "second",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-sequential-b",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      const dispatchOptions = dispatchInboundMessageMock.mock.calls.map(([params]) => {
        return (params as { replyOptions?: GetReplyOptions }).replyOptions;
      });
      expect(dispatchOptions[0]?.runId).toBe("idem-sequential-a");
      expect(dispatchOptions[1]?.runId).toBe("idem-sequential-b");
      expect(dispatchOptions[0]?.promptCacheKey).toEqual(
        expect.stringMatching(/^openclaw-webchat-[a-f0-9]{32}$/u),
      );
      expect(dispatchOptions[1]?.promptCacheKey).toBe(dispatchOptions[0]?.promptCacheKey);
      expect(dispatchOptions[0]?.promptCacheKey).not.toContain("main");
      expect(dispatchOptions[0]?.promptCacheKey).not.toContain("sess-main");
      expect(context.addChatRun).toHaveBeenCalledTimes(2);
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send emits operator-only post-ACK server timing milestones", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const broadcastToConnIds = vi.fn();
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        clearChatRunState: vi.fn(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        broadcastToConnIds,
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: GetReplyOptions }).replyOptions;
        replyOptions?.onModelSelected?.({
          provider: "openai",
          model: "gpt-5.5",
          thinkLevel: undefined,
        });
        replyOptions?.onAgentRunStart?.("agent-run-1");
        return {};
      });

      const { chatHandlers } = await import("./server-methods/chat.js");
      await chatHandlers["chat.send"]({
        req: {
          type: "req",
          id: "operator-timing",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "measure",
            idempotencyKey: "idem-server-timing",
          },
        },
        params: {
          sessionKey: "main",
          message: "measure",
          idempotencyKey: "idem-server-timing",
        },
        client: {
          connId: "conn-control-ui",
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            },
            scopes: ["operator.write"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: ((ok, payload, error) => {
          responses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-server-timing",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
      ]);
      await vi.waitFor(
        () => {
          const phases = broadcastToConnIds.mock.calls
            .filter(([event]) => event === "chat.send_timing")
            .map(([, payload]) => (payload as { phase?: unknown }).phase);
          expect(phases).toEqual(
            expect.arrayContaining([
              "dispatch-started",
              "model-selected",
              "agent-run-started",
              "dispatch-completed",
              "post-dispatch-completed",
            ]),
          );
        },
        { timeout: 2_000, interval: 5 },
      );
      for (const [event, payload, connIds, opts] of broadcastToConnIds.mock.calls) {
        expect(event).toBe("chat.send_timing");
        expect(connIds).toEqual(new Set(["conn-control-ui"]));
        expect(opts).toEqual({ dropIfSlow: true });
        expect(payload).toMatchObject({
          runId: "idem-server-timing",
          sessionKey: "agent:main:main",
          ackToPhaseMs: expect.any(Number),
          receivedToPhaseMs: expect.any(Number),
        });
      }
      const timingPayloads = broadcastToConnIds.mock.calls.map(([, payload]) => payload);
      expect(timingPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "model-selected",
            provider: "openai",
            model: "gpt-5.5",
          }),
          expect.objectContaining({
            phase: "agent-run-started",
            agentRunId: "agent-run-1",
            dispatchStartedToPhaseMs: expect.any(Number),
          }),
        ]),
      );
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.history backfills claude-cli sessions from Claude project files", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const originalHome = process.env.HOME;
      const homeDir = path.join(sessionDir, "home");
      const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      await fs.mkdir(claudeProjectsDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "queue-operation",
            operation: "enqueue",
            timestamp: "2026-03-26T16:29:54.722Z",
            sessionId: cliSessionId,
            content: "[Thu 2026-03-26 16:29 GMT] hi",
          }),
          JSON.stringify({
            type: "user",
            uuid: "user-1",
            timestamp: "2026-03-26T16:29:54.800Z",
            message: {
              role: "user",
              content:
                'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
            },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            timestamp: "2026-03-26T16:29:55.500Z",
            message: {
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "hello from Claude" }],
            },
          }),
        ].join("\n"),
        "utf-8",
      );
      process.env.HOME = homeDir;
      try {
        await writeSessionStore({
          entries: {
            main: {
              sessionId: "sess-main",
              updatedAt: Date.now(),
              modelProvider: "claude-cli",
              model: "claude-sonnet-4-6",
              cliSessionBindings: {
                "claude-cli": {
                  sessionId: cliSessionId,
                },
              },
            },
          },
        });

        const messages = await fetchHistoryMessages(ws);
        expect(messages).toHaveLength(2);
        const userMessage = messages[0] as { role?: string; content?: string };
        expect(userMessage.role).toBe("user");
        expect(userMessage.content).toBe("hi");
        const assistantMessage = messages[1] as { role?: string; provider?: string };
        expect(assistantMessage.role).toBe("assistant");
        expect(assistantMessage.provider).toBe("claude-cli");
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
      }
    });
  });

  test("chat.history overreads one local message to drop stale announce pairs at the limit boundary", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            sessionStartedAt,
          },
        },
      });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content: [
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
              "stale announce payload",
            ].join("\n"),
            provenance: {
              kind: "inter_session",
              sourceSessionKey: "agent:main:subagent:child",
              sourceTool: "subagent_announce",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:33.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "stale announce reply" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-23T04:03:10.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "fresh turn" }],
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 2 });
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain("stale announce reply");
      expect(JSON.stringify(messages)).toContain("fresh turn");
    });
  });

  test("chat.history does not surface an older stale assistant when overreading for pair context", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            sessionStartedAt,
          },
        },
      });
      const announce = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "subagent_announce",
      };
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:29.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:30.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "older stale announce reply" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:33.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "newer stale announce reply" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-23T04:03:10.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "fresh turn" }],
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 3 });
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain("older stale announce reply");
      expect(serialized).not.toContain("newer stale announce reply");
      expect(serialized).toContain("fresh turn");
    });
  });

  test("smoke: caps history payload and preserves routing metadata", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const bigText = "x".repeat(2_000);
      const historyLines: string[] = [];
      for (let i = 0; i < 45; i += 1) {
        historyLines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `${i}:${bigText}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, historyLines);
      const messages = await fetchHistoryMessages(ws);
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(45);

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-route",
      });
      expect(sendRes.ok).toBe(true);

      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("expected session store path");
      }
      const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    });
  });

  test("chat.send does not force-disable block streaming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();
      testState.agentConfig = { blockStreamingDefault: "on" };
      try {
        let capturedOpts: GetReplyOptions | undefined;
        mockGetReplyFromConfigOnce(async (_ctx, opts) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-block-streaming",
        });
        expect(sendRes.ok).toBe(true);

        await vi.waitFor(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.disableBlockStreaming).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
      }
    });
  });

  test("chat.send diagnostics timeline carries run correlation attributes", async () => {
    const timelineDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-timeline-"));
    const timelinePath = path.join(timelineDir, "timeline.jsonl");
    const previousDiagnostics = process.env.OPENCLAW_DIAGNOSTICS;
    const previousTimelinePath = process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
    process.env.OPENCLAW_DIAGNOSTICS = "timeline";
    process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
    try {
      await withGatewayChatHarness(
        async ({ ws, createSessionDir }) => {
          const spy = getReplyFromConfig;
          await connectOk(ws, {
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              version: "1.0.0",
              platform: "web",
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            },
          });

          await createSessionDir();
          await writeMainSessionStore();
          mockGetReplyFromConfigOnce(async () => undefined);

          const sendRes = await rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "hello",
            idempotencyKey: "idem-timeline",
          });
          expect(sendRes.ok).toBe(true);
          expect(sendRes.payload).toMatchObject({
            runId: "idem-timeline",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          });

          await vi.waitFor(() => {
            expect(spy.mock.calls.length).toBeGreaterThan(0);
          }, FAST_WAIT_OPTS);
          await vi.waitFor(async () => {
            const events = await readTimelineEvents(timelinePath);
            const ackReady = events.find(
              (event) =>
                event.type === "mark" &&
                event.name === "gateway.chat_send.ack_ready" &&
                (event.attributes as Record<string, unknown> | undefined)?.runId ===
                  "idem-timeline",
            );
            expect(ackReady?.attributes).toMatchObject({
              runId: "idem-timeline",
              ackStatus: "started",
              serverReceivedToAckMs: expect.any(Number),
              serverLoadSessionMs: expect.any(Number),
            });
            expect(
              events.some(
                (event) =>
                  event.type === "span.end" &&
                  event.name === "gateway.chat_send.dispatch_inbound" &&
                  (event.attributes as Record<string, unknown> | undefined)?.runId ===
                    "idem-timeline",
              ),
            ).toBe(true);
          }, FAST_WAIT_OPTS);
        },
        {
          headers: { origin: `http://127.0.0.1:${harness.port}` },
        },
      );
    } finally {
      if (previousDiagnostics === undefined) {
        delete process.env.OPENCLAW_DIAGNOSTICS;
      } else {
        process.env.OPENCLAW_DIAGNOSTICS = previousDiagnostics;
      }
      if (previousTimelinePath === undefined) {
        delete process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
      } else {
        process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = previousTimelinePath;
      }
      await fs.rm(timelineDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("chat.send omits ACK server timing for public WebChat clients", async () => {
    await withGatewayChatHarness(
      async ({ ws, createSessionDir }) => {
        await connectOk(ws, {
          client: {
            id: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
            version: "1.0.0",
            platform: "web",
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          },
        });

        await createSessionDir();
        await writeMainSessionStore();
        mockGetReplyFromConfigOnce(async () => undefined);

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-public-webchat",
        });

        expect(sendRes.ok).toBe(true);
        expect(sendRes.payload).toMatchObject({
          runId: "idem-public-webchat",
          status: "started",
        });
        expect(
          (sendRes.payload as { serverTiming?: unknown } | undefined)?.serverTiming,
        ).toBeUndefined();
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("chat.history hard-caps single oversized nested payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const hugeNestedText = "n".repeat(120_000);
      const oversizedLine = JSON.stringify({
        id: "msg-huge",
        message: {
          role: "assistant",
          timestamp: Date.now(),
          content: [
            {
              type: "tool_result",
              toolUseId: "tool-1",
              output: {
                nested: {
                  payload: hugeNestedText,
                },
              },
            },
          ],
        },
      });
      await writeMainSessionTranscript(sessionDir, [oversizedLine]);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(1);

      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(messages[0]).toMatchObject({
        __openclaw: { id: "msg-huge", truncated: true, reason: "oversized" },
      });
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history keeps recent small messages when latest message is oversized", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const baseText = "s".repeat(1_200);
      const lines: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              timestamp: Date.now() + i,
              content: [{ type: "text", text: `small-${i}:${baseText}` }],
            },
          }),
        );
      }

      const hugeNestedText = "z".repeat(120_000);
      lines.push(
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now() + 1_000,
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: {
                  nested: {
                    payload: hugeNestedText,
                  },
                },
              },
            ],
          },
        }),
      );

      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");

      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeGreaterThan(1);
      expect(serialized).toContain("small-29:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history preserves usage and cost metadata for assistant messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "hello" }],
            usage: { input: 12, output: 5, totalTokens: 17 },
            cost: { total: 0.0123 },
            details: { debug: true },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      const message = messages[0] as {
        role?: string;
        usage?: { input?: number; output?: number; totalTokens?: number };
        cost?: { total?: number };
      };
      expect(message.role).toBe("assistant");
      expect(message.usage?.input).toBe(12);
      expect(message.usage?.output).toBe(5);
      expect(message.usage?.totalTokens).toBe(17);
      expect(message.cost?.total).toBe(0.0123);
      expect(messages[0]).not.toHaveProperty("details");
    });
  });

  test("chat.history strips inline directives from displayed message text", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const lines = [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello [[reply_to_current]] world [[audio_as_voice]]" },
            ],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "A [[reply_to:abc-123]] B",
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            text: "[[ reply_to : 456 ]] C",
            timestamp: Date.now() + 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "  keep padded  " }],
            timestamp: Date.now() + 3,
          },
        }),
      ];
      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(4);

      const serialized = JSON.stringify(messages);
      expect(serialized.includes("[[reply_to")).toBe(false);
      expect(serialized.includes("[[audio_as_voice]]")).toBe(false);

      const first = messages[0] as { content?: Array<{ text?: string }> };
      const second = messages[1] as { content?: string };
      const third = messages[2] as { text?: string };
      const fourth = messages[3] as { content?: Array<{ text?: string }> };

      expect(first.content?.[0]?.text?.replace(/\s+/g, " ").trim()).toBe("Hello world");
      expect(second.content?.replace(/\s+/g, " ").trim()).toBe("A B");
      expect(third.text?.replace(/\s+/g, " ").trim()).toBe("C");
      expect(fourth.content?.[0]?.text).toBe("  keep padded  ");
    });
  });

  test("chat.history keeps visible assistant progress text from mixed tool-use transcript messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "fix it" }],
            timestamp: 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private reasoning" },
              {
                type: "text",
                text: "I will clean that up now.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg-progress",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call-read",
                name: "read",
                arguments: { path: "AGENTS.md" },
              },
            ],
            timestamp: 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
            timestamp: 3,
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      const assistantMessage = messages[1] as {
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        timestamp?: number;
      };
      expect(assistantMessage.role).toBe("assistant");
      expect(assistantMessage.content).toEqual([
        { type: "text", text: "I will clean that up now." },
      ]);
      expect(assistantMessage.timestamp).toBe(2);
    });
  });

  test("chat.history applies RPC maxChars", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "abcdefghij" }],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 7 });
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("abcdefg\\n...(truncated)...");
    });
  });

  test("chat.history rejects invalid RPC maxChars values", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });

      const zeroRes = await rpcReq(ws, "chat.history", {
        sessionKey: "main",
        maxChars: 0,
      });
      expect(zeroRes.ok).toBe(false);
      expect((zeroRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );

      const tooLargeRes = await rpcReq(ws, "chat.history", {
        sessionKey: "main",
        maxChars: 500_001,
      });
      expect(tooLargeRes.ok).toBe(false);
      expect((tooLargeRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );
    });
  });

  test("chat.message.get returns the full projected message for a truncated history row", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          id: "msg-full-assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "abcdefghij" }],
            timestamp: Date.now(),
          },
        }),
      ]);

      const historyMessages = await fetchHistoryMessages(ws, { maxChars: 5 });
      expect(JSON.stringify(historyMessages)).toContain("abcde\\n...(truncated)...");

      const full = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-full-assistant",
      });
      expect(full.ok).toBe(true);
      expect(full.unavailableReason).toBeUndefined();
      expect(JSON.stringify(full.message)).toContain("abcdefghij");
      expect(JSON.stringify(full.message)).not.toContain("...(truncated)...");
    });
  });

  test("chat.message.get accepts the selected agent for global sessions", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        session: { scope: "global" },
        agents: {
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      });
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await writeSessionStore({
        entries: {
          global: { sessionId: "sess-global", updatedAt: Date.now() },
        },
      });
      await fs.writeFile(
        path.join(sessionDir, "sess-global.jsonl"),
        `${JSON.stringify({
          id: "msg-global-agent",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "global agent content" }],
            timestamp: Date.now(),
          },
        })}\n`,
        "utf-8",
      );

      const full = await fetchChatMessage(ws, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-global-agent",
      });
      expect(full.ok).toBe(true);
      expect(JSON.stringify(full.message)).toContain("global agent content");
    });
  });

  test("chat.message.get reports oversized transcript entries as unavailable", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const oversizedLine = JSON.stringify({
        id: "msg-oversized",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(300 * 1024) }],
          timestamp: Date.now(),
        },
      });
      await writeMainSessionTranscript(sessionDir, [oversizedLine]);

      const full = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-oversized",
      });
      expect(full.ok).toBe(false);
      expect(full.unavailableReason).toBe("oversized");
      expect(full.message).toBeUndefined();
    });
  });

  test("chat.message.get does not return inactive branch entries", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          id: "msg-root",
          parentId: null,
          message: {
            role: "user",
            content: [{ type: "text", text: "question" }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          id: "msg-stale",
          parentId: "msg-root",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "stale branch" }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          id: "msg-active",
          parentId: "msg-root",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "active branch" }],
            timestamp: Date.now(),
          },
        }),
      ]);

      const stale = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-stale",
      });
      expect(stale.ok).toBe(false);
      expect(stale.unavailableReason).toBe("not_found");

      const active = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-active",
      });
      expect(active.ok).toBe(true);
      expect(JSON.stringify(active.message)).toContain("active branch");
    });
  });

  test("chat.message.get does not return pre-session announce pairs hidden by history", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionStartedAt = Date.now();
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now(), sessionStartedAt },
        },
      });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          id: "msg-announce",
          message: {
            role: "user",
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
            content: [{ type: "text", text: "announce" }],
            timestamp: sessionStartedAt - 2_000,
          },
        }),
        JSON.stringify({
          id: "msg-hidden-assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hidden pre-session reply" }],
            timestamp: sessionStartedAt - 1_000,
          },
        }),
        JSON.stringify({
          id: "msg-visible-assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "visible reply" }],
            timestamp: sessionStartedAt + 1_000,
          },
        }),
      ]);

      const hidden = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-hidden-assistant",
      });
      expect(hidden.ok).toBe(false);
      expect(hidden.unavailableReason).toBe("not_found");

      const visible = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-visible-assistant",
      });
      expect(visible.ok).toBe(true);
      expect(JSON.stringify(visible.message)).toContain("visible reply");
    });
  });

  test("chat.history still drops assistant NO_REPLY entries before truncation", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "NO_REPLY" }],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 3 });
      expect(messages).toStrictEqual([]);
    });
  });

  test("chat.history backfills visible messages when raw tail is mostly silent", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const silentTail = Array.from({ length: 24 }, (_, index) =>
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "NO_REPLY" }],
            timestamp: Date.now() + index + 2,
          },
        }),
      );
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "visible question" }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "visible answer" }],
            timestamp: Date.now() + 1,
          },
        }),
        ...silentTail,
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 2, maxChars: 100 });
      expect(JSON.stringify(messages)).toContain("visible question");
      expect(JSON.stringify(messages)).toContain("visible answer");
      expect(JSON.stringify(messages)).not.toContain("NO_REPLY");
    });
  });

  test("smoke: supports abort and idempotent completion", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      let aborted = false;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return undefined;
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 2_000);
      sendReq(ws, "send-abort-1", "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await vi.waitFor(() => {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);

      const inFlight = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
      });
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{ aborted?: boolean }>(ws, "chat.abort", {
        sessionKey: "main",
        runId: "idem-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      await vi.waitFor(() => {
        expect(aborted).toBe(true);
      }, FAST_WAIT_OPTS);

      spy.mockClear();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-complete-1",
      });
      expect(completeRes.ok).toBe(true);

      await vi.waitFor(async () => {
        const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
        });
        expect(again.ok).toBe(true);
        expect(again.payload?.status).toBe("ok");
      }, FAST_WAIT_OPTS);
    });
  });
});
