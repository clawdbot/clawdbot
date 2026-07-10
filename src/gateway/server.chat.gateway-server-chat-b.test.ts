// Gateway chat integration tests cover dashboard chat requests, transcript
// history limits, model overrides, inbound dispatch, and streaming event fanout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import { invalidateSessionStoreCache } from "../config/sessions/store-cache.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferred } from "../test-utils/deferred.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/shared-types.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
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
const FAST_WAIT_OPTS = { timeout: 2_000, interval: 5 } as const;
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let harness: GatewayHarness;
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

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

function testSessionFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

async function writeMainSessionStore(sessionDir?: string, sessionId = "sess-main") {
  await writeSessionStore({
    entries: {
      main: {
        sessionId,
        updatedAt: futureFixtureUpdatedAt(),
        ...(sessionDir ? { sessionFile: testSessionFilePath(sessionDir, sessionId) } : {}),
      },
    },
  });
}

function futureFixtureUpdatedAt(): number {
  return Date.now() + 60_000;
}

function readOpenClawSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const seq = (metadata as Record<string, unknown>).seq;
  return typeof seq === "number" ? seq : undefined;
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

async function writeMainSessionTranscript(
  sessionDir: string,
  lines: string[],
  sessionId = "sess-main",
) {
  await fs.writeFile(testSessionFilePath(sessionDir, sessionId), `${lines.join("\n")}\n`, "utf-8");
}

async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function createDirectChatContext(): GatewayRequestContext {
  return {
    loadGatewayModelCatalog: vi.fn().mockResolvedValue([]),
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    agentRunSeq: new Map(),
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
}

test("chat.send replays a cached result after the session is archived", async () => {
  const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
  try {
    dispatchInboundMessageMock.mockClear();
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          archivedAt: Date.now(),
        },
      },
    });
    const context = createDirectChatContext();
    const runId = "idem-archived-cached-result";
    const cachedPayload = { runId, status: "ok", summary: "already completed" };
    context.dedupe.set(`chat:${runId}`, {
      ts: Date.now(),
      ok: true,
      payload: cachedPayload,
    });
    const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown; meta?: unknown }> =
      [];
    const { chatHandlers } = await import("./server-methods/chat.js");

    await chatHandlers["chat.send"]({
      req: { type: "req", id: "cached", method: "chat.send" },
      params: {
        sessionKey: "main",
        message: "retry completed send",
        idempotencyKey: runId,
      },
      client: null,
      isWebchatConnect: () => false,
      respond: ((ok, payload, error, meta) => {
        responses.push({ ok, payload, error, meta });
      }) as RespondFn,
      context,
    });

    expect(responses).toEqual([
      {
        ok: true,
        payload: cachedPayload,
        error: undefined,
        meta: { cached: true },
      },
    ]);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  } finally {
    dispatchInboundMessageMock.mockReset();
    testState.sessionStorePath = undefined;
    clearConfigCache();
    await removeTempDir(sessionDir);
  }
});

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
  sessionId?: string;
}) {
  if (params.historyMaxBytes !== undefined) {
    setMaxChatHistoryMessagesBytesForTest(params.historyMaxBytes);
  }
  await connectOk(params.ws);
  const sessionDir = await params.createSessionDir();
  await writeMainSessionStore(sessionDir, params.sessionId);
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
      await removeTempDir(sessionDir);
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
      await writeGatewayConfig({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-main",
            },
            models: {
              "openai/gpt-main": {},
            },
          },
          list: [{ id: "main", default: true }],
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [{ id: "gpt-main", name: "GPT Main" }],
            },
          },
        },
      });
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
        metadata?: {
          commands?: Array<{ name?: string; textAliases?: string[] }>;
          models?: Array<{ id?: string; provider?: string }>;
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
      expect(startup.payload?.metadata?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "gpt-main",
            provider: "openai",
          }),
        ]),
      );
      expect(startup.payload?.metadata?.commands).toBeUndefined();
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

  test("chat.startup does not wait for slow optional model catalog metadata", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "slow-catalog-model",
            updatedAt: Date.now(),
          },
        },
      });
      const catalog =
        createDeferred<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalog"]>()
          .mockReturnValue(catalog.promise),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        chatAbortControllers: new Map(),
        chatRunBuffers: new Map(),
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext;
      const { chatHandlers } = await import("./server-methods/chat.js");

      await chatHandlers["chat.startup"]({
        req: {
          type: "req",
          id: "startup-slow-catalog",
          method: "chat.startup",
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
            agentsList?: { agents?: Array<{ id?: string }> };
            metadata?: unknown;
            sessionInfo?: { sessionId?: string };
          }
        | undefined;
      expect(payload?.sessionInfo?.sessionId).toBe("sess-main");
      expect(payload?.agentsList?.agents?.map((agent) => agent.id)).toContain("main");
      expect(payload?.metadata).toBeUndefined();
    } finally {
      testState.sessionStorePath = undefined;
      await removeTempDir(sessionDir);
    }
  });

  test("chat.startup omits metadata when configured model visibility needs full discovery", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await writeGatewayConfig({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-main" },
            models: {
              "openai/*": {},
            },
          },
          list: [{ id: "main", default: true }],
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [{ id: "gpt-main", name: "GPT Main" }],
            },
          },
        },
      });
      await connectOk(ws);

      const startup = await rpcReq<{ metadata?: unknown }>(ws, "chat.startup", {
        sessionKey: "main",
      });

      expect(startup.ok).toBe(true);
      expect(startup.payload?.metadata).toBeUndefined();
    });
  });

  test("chat.startup scopes metadata to agent session keys without explicit agentId", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          "agent:work:main": {
            sessionId: "sess-work",
            updatedAt: Date.now(),
          },
        },
      });
      const config = {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-main",
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
              models: {
                "minimax/MiniMax-M2.7-highspeed": {},
              },
            },
          ],
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [{ id: "gpt-main", name: "GPT Main" }],
            },
            minimax: {
              baseUrl: "https://minimax.example.com/v1",
              models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
            },
          },
        },
      };
      await writeGatewayConfig(config);
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalog"]>()
          .mockImplementation(async () => {
            await Promise.resolve();
            await Promise.resolve();
            return [
              {
                id: "gpt-main",
                name: "GPT Main",
                provider: "openai",
                input: ["text"],
              },
              {
                id: "MiniMax-M2.7-highspeed",
                name: "MiniMax M2.7 Highspeed",
                provider: "minimax",
                input: ["text"],
              },
            ];
          }),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        chatAbortControllers: new Map(),
        chatRunBuffers: new Map(),
        getRuntimeConfig: () => config,
      } as unknown as GatewayRequestContext;
      const { chatHandlers } = await import("./server-methods/chat.js");

      await chatHandlers["chat.startup"]({
        req: {
          type: "req",
          id: "startup-agent-scoped-metadata",
          method: "chat.startup",
          params: { sessionKey: "agent:work:main" },
        },
        params: { sessionKey: "agent:work:main" },
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
            metadata?: {
              models?: Array<{ id?: string; provider?: string }>;
            };
            sessionInfo?: { key?: string; sessionId?: string };
          }
        | undefined;
      expect(payload?.sessionInfo).toMatchObject({
        key: "agent:work:main",
        sessionId: "sess-work",
      });
      expect(payload?.metadata?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "MiniMax-M2.7-highspeed",
            provider: "minimax",
          }),
        ]),
      );
    } finally {
      testState.sessionStorePath = undefined;
      await removeTempDir(sessionDir);
    }
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
    const dispatchRelease = createDeferred();
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
      await removeTempDir(sessionDir);
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
      await removeTempDir(sessionDir);
    }
  });

  test("chat.abort cancels chat.send while lifecycle admission waits", async () => {
    const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
    const releaseMutation = createDeferred();
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
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: testState.sessionStorePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const abortResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-lifecycle-wait-abort";
      const collidingFinalKey = `chat:pending:${runId}`;
      const collidingFinalEntry = {
        ts: Date.now(),
        ok: true,
        payload: { runId: `pending:${runId}`, status: "ok" },
      };
      context.dedupe.set(collidingFinalKey, collidingFinalEntry);
      const params = {
        sessionKey: "main",
        message: "do not dispatch",
        idempotencyKey: runId,
      };
      const client = {
        connId: "conn-owner",
        connect: {
          device: { id: "dev-owner" },
          scopes: ["operator.write"],
        },
      } as never;
      const { chatHandlers } = await import("./server-methods/chat.js");
      const send = Promise.resolve(
        chatHandlers["chat.send"]({
          req: { type: "req", id: "send", method: "chat.send", params },
          params,
          client,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            sendResponses.push({ ok, payload, error });
          }) as RespondFn,
          context,
        }),
      );
      await vi.waitFor(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);
      expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
      expect(context.chatAbortControllers.has(runId)).toBe(false);

      const retryResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      await chatHandlers["chat.send"]({
        req: { type: "req", id: "retry", method: "chat.send", params },
        params,
        client,
        isWebchatConnect: () => false,
        respond: ((ok, payload, error) => {
          retryResponses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: { runId, status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);

      await chatHandlers["chat.abort"]({
        req: {
          type: "req",
          id: "abort",
          method: "chat.abort",
          params: { sessionKey: "main", runId },
        },
        params: { sessionKey: "main", runId },
        client,
        isWebchatConnect: () => false,
        respond: ((ok, payload, error) => {
          abortResponses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(abortResponses).toEqual([
        {
          ok: true,
          payload: { ok: true, aborted: true, runIds: [runId] },
          error: undefined,
        },
      ]);
      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: {
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
    }
  });

  test("chat.send rejects stale lifecycle work after admission waits", async () => {
    const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
    const releaseMutation = createDeferred();
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
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: testState.sessionStorePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-stale-lifecycle";
      const params = {
        sessionKey: "main",
        message: "do not resume after restart",
        idempotencyKey: runId,
      };
      const { chatHandlers } = await import("./server-methods/chat.js");
      const send = Promise.resolve(
        chatHandlers["chat.send"]({
          req: { type: "req", id: "send", method: "chat.send", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            sendResponses.push({ ok, payload, error });
          }) as RespondFn,
          context,
        }),
      );
      await vi.waitFor(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      rotateAgentEventLifecycleGeneration();
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: {
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "restart",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
    }
  });

  test("chat.send does not recreate a session deleted while admission waits", async () => {
    const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
    const performDeletion = createDeferred();
    let mutation: Promise<void> | undefined;
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
      const [{ deleteSessionEntryLifecycle }, { loadSessionEntry }] = await Promise.all([
        import("../config/sessions/session-accessor.js"),
        import("./session-utils.js"),
      ]);
      const seededSession = loadSessionEntry("main");
      const seededSessionId = seededSession.entry?.sessionId;
      expect(seededSessionId).toBe("sess-main");
      const mutationStarted = createDeferred();
      mutation = runExclusiveSessionLifecycleMutation({
        scope: seededSession.storePath,
        identities: [seededSession.canonicalKey, seededSessionId],
        run: async () => {
          mutationStarted.resolve();
          await performDeletion.promise;
          // Use the resolved store target: writeSessionStore also rewrites the
          // suite config, adding an unrelated config-watcher race to this test.
          const deletion = await deleteSessionEntryLifecycle({
            agentId: "main",
            archiveTranscript: false,
            expectedEntry: seededSession.entry,
            expectedSessionId: seededSessionId,
            requireWriteSuccess: true,
            storePath: seededSession.storePath,
            target: {
              canonicalKey: seededSession.canonicalKey,
              storeKeys: seededSession.storeKeys,
            },
          });
          expect(deletion.deleted).toBe(true);
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{
        ok: boolean;
        payload?: unknown;
        error?: unknown;
        meta?: unknown;
      }> = [];
      const context = createDirectChatContext();
      const runId = "idem-deleted-during-admission";
      const params = {
        sessionKey: "main",
        message: "do not recreate the deleted session",
        idempotencyKey: runId,
      };
      const { chatHandlers } = await import("./server-methods/chat.js");
      const send = Promise.resolve(
        chatHandlers["chat.send"]({
          req: { type: "req", id: "send", method: "chat.send", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error, meta) => {
            sendResponses.push({ ok, payload, error, meta });
          }) as RespondFn,
          context,
        }),
      );
      await vi.waitFor(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      performDeletion.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: false,
          payload: undefined,
          error: expect.objectContaining({
            message: expect.stringMatching(/deleted while starting work/i),
          }),
          meta: undefined,
        },
      ]);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      performDeletion.resolve();
      await Promise.allSettled(mutation ? [mutation] : []);
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
    }
  });

  test("chat.send does not enter a replacement session after reset while admission waits", async () => {
    const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
    const releaseMutation = createDeferred();
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-before-reset",
            updatedAt: Date.now(),
          },
        },
      });
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: testState.sessionStorePath,
        identities: ["agent:main:main", "sess-before-reset"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-reset-during-admission";
      const params = {
        sessionKey: "main",
        message: "do not enter the replacement session",
        idempotencyKey: runId,
      };
      const { chatHandlers } = await import("./server-methods/chat.js");
      const send = Promise.resolve(
        chatHandlers["chat.send"]({
          req: { type: "req", id: "send", method: "chat.send", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            sendResponses.push({ ok, payload, error });
          }) as RespondFn,
          context,
        }),
      );
      await vi.waitFor(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-after-reset",
            updatedAt: Date.now(),
          },
        },
      });
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toHaveLength(1);
      expect(sendResponses[0]?.ok).toBe(false);
      expect(sendResponses[0]?.error).toMatchObject({
        message: expect.stringMatching(/changed while starting work/i),
      });
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
    }
  });

  test("chat.send does not consume a replacement pending reservation", async () => {
    const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
    const releaseMutation = createDeferred();
    const releaseTerminalMutation = createDeferred();
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
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: testState.sessionStorePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-replaced-reservation";
      const pendingKey = pendingChatSendDedupeKey(runId);
      const params = {
        sessionKey: "main",
        message: "only the replacement may run",
        idempotencyKey: runId,
      };
      const { chatHandlers } = await import("./server-methods/chat.js");
      const send = Promise.resolve(
        chatHandlers["chat.send"]({
          req: { type: "req", id: "send", method: "chat.send", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            sendResponses.push({ ok, payload, error });
          }) as RespondFn,
          context,
        }),
      );
      await vi.waitFor(() => {
        expect(context.dedupe.has(pendingKey)).toBe(true);
      }, FAST_WAIT_OPTS);
      const original = context.dedupe.get(pendingKey);
      const originalPayload = original?.payload as Record<string, unknown>;
      const replacement = {
        ts: Date.now(),
        ok: true,
        payload: {
          ...originalPayload,
          attemptId: "replacement-attempt",
          expiresAtMs: Date.now() + 120_000,
        },
      };
      context.dedupe.set(pendingKey, replacement);

      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: { runId, status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(context.dedupe.get(pendingKey)).toBe(replacement);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

      const terminalMutationStarted = createDeferred();
      const terminalMutation = runExclusiveSessionLifecycleMutation({
        scope: testState.sessionStorePath,
        identities: ["sess-main"],
        run: async () => {
          terminalMutationStarted.resolve();
          await releaseTerminalMutation.promise;
        },
      });
      await terminalMutationStarted.promise;
      const terminalRunId = "idem-terminal-replacement";
      const terminalPendingKey = pendingChatSendDedupeKey(terminalRunId);
      const terminalParams = {
        sessionKey: "main",
        message: "preserve the replacement result",
        idempotencyKey: terminalRunId,
      };
      const terminalResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const terminalSend = Promise.resolve(
        chatHandlers["chat.send"]({
          req: { type: "req", id: "terminal-send", method: "chat.send", params: terminalParams },
          params: terminalParams,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            terminalResponses.push({ ok, payload, error });
          }) as RespondFn,
          context,
        }),
      );
      await vi.waitFor(() => {
        expect(context.dedupe.has(terminalPendingKey)).toBe(true);
      }, FAST_WAIT_OPTS);
      const terminalResult = {
        ts: Date.now(),
        ok: true,
        payload: { runId: terminalRunId, status: "ok", summary: "replacement completed" },
      };
      context.dedupe.delete(terminalPendingKey);
      context.dedupe.set(`chat:${terminalRunId}`, terminalResult);

      releaseTerminalMutation.resolve();
      await terminalMutation;
      await terminalSend;

      expect(terminalResponses).toEqual([
        { ok: true, payload: terminalResult.payload, error: undefined },
      ]);
      expect(context.dedupe.get(`chat:${terminalRunId}`)).toBe(terminalResult);
      expect(context.chatAbortedRuns.has(terminalRunId)).toBe(false);
    } finally {
      releaseMutation.resolve();
      releaseTerminalMutation.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
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
          getRuntimeConfig,
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
        await removeTempDir(sessionDir);
      }
    },
  );

  test("chat.send keeps matching WebChat text sends distinct by idempotency key", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred();
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
        getRuntimeConfig,
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
      const callSend = (
        id: string,
        idempotencyKey: string,
        systemProvenanceReceipt?: string,
        thinking = "low",
      ) =>
        chatHandlers["chat.send"]({
          req: {
            type: "req",
            id,
            method: "chat.send",
            params: {
              sessionKey: "main",
              message: "?",
              idempotencyKey,
              thinking,
              ...(systemProvenanceReceipt ? { systemProvenanceReceipt } : {}),
            },
          },
          params: {
            sessionKey: "main",
            message: "?",
            idempotencyKey,
            thinking,
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

      const duplicate = Promise.resolve(callSend("duplicate", "idem-active-b"));

      await vi.waitFor(() => {
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
            payload: expect.objectContaining({
              runId: "idem-active-b",
              status: "started",
              serverTiming: {
                receivedToAckMs: expect.any(Number),
                loadSessionMs: expect.any(Number),
              },
            }),
            error: undefined,
          },
        ]);
      }, FAST_WAIT_OPTS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(context.addChatRun).toHaveBeenCalledTimes(2);

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
              payload: expect.objectContaining({
                runId: "idem-active-b",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
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
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);
      expect(context.addChatRun).toHaveBeenCalledTimes(3);

      const withDifferentThinking = Promise.resolve(
        callSend("different-thinking", "idem-active-d", undefined, "high"),
      );
      await vi.waitFor(
        () => {
          expect(responses.at(-1)).toEqual({
            id: "different-thinking",
            ok: true,
            payload: expect.objectContaining({
              runId: "idem-active-d",
              status: "started",
              serverTiming: {
                receivedToAckMs: expect.any(Number),
                loadSessionMs: expect.any(Number),
              },
            }),
            error: undefined,
          });
        },
        { timeout: 2_000, interval: 5 },
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);
      expect(context.addChatRun).toHaveBeenCalledTimes(4);

      dispatchRelease.resolve();
      await Promise.all([first, duplicate, withSystemContext, withDifferentThinking]);
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(4);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
    }
  });

  test("chat.send keeps distinct sends independent when a session ID appears during the first turn", async () => {
    const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
    const dispatchRelease = createDeferred();
    try {
      const storePath = path.join(sessionDir, "sessions.json");
      testState.sessionStorePath = storePath;
      await writeSessionStore({ entries: {} });
      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);
      const { chatHandlers } = await import("./server-methods/chat.js");
      const callSend = (id: string, idempotencyKey: string) => {
        const params = {
          sessionKey: "main",
          message: "create this session once",
          idempotencyKey,
        };
        return chatHandlers["chat.send"]({
          req: { type: "req", id, method: "chat.send", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });
      };

      const first = Promise.resolve(callSend("first", "idem-new-session-a"));
      await vi.waitFor(() => {
        expect(responses[0]).toEqual({
          id: "first",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-new-session-a",
            status: "started",
          }),
          error: undefined,
        });
      }, FAST_WAIT_OPTS);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          main: {
            sessionId: "sess-created-during-run",
            updatedAt: Date.now(),
          },
        }),
        "utf8",
      );
      invalidateSessionStoreCache(storePath);

      const duplicate = Promise.resolve(callSend("duplicate", "idem-new-session-b"));
      await vi.waitFor(() => {
        expect(responses.at(-1)).toEqual({
          id: "duplicate",
          ok: true,
          payload: expect.objectContaining({ runId: "idem-new-session-b", status: "started" }),
          error: undefined,
        });
      }, FAST_WAIT_OPTS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);

      dispatchRelease.resolve();
      await Promise.all([first, duplicate]);
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(2);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
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
        getRuntimeConfig,
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
      await removeTempDir(sessionDir);
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
        getRuntimeConfig,
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
      await removeTempDir(sessionDir);
    }
  });

  test("chat.send terminalizes the client run when a followup is queued", async () => {
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

      const broadcast = vi.fn((_event: string, _payload: unknown) => undefined);
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
        chatQueuedTurns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        clearChatRunState: vi.fn(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast,
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        getRuntimeConfig: () => ({}),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      let queuedLifecycle: GetReplyOptions["queuedFollowupLifecycle"];
      const dispatchRelease = createDeferred();
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        queuedLifecycle = (args as { replyOptions?: GetReplyOptions }).replyOptions
          ?.queuedFollowupLifecycle;
        queuedLifecycle?.onEnqueued?.();
        await dispatchRelease.promise;
        return {};
      });

      const { chatHandlers } = await import("./server-methods/chat.js");
      await chatHandlers["chat.send"]({
        req: {
          type: "req",
          id: "queued-followup",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "queued prompt",
            idempotencyKey: "idem-queued-followup",
          },
        },
        params: {
          sessionKey: "main",
          message: "queued prompt",
          idempotencyKey: "idem-queued-followup",
        },
        client: {
          connId: "conn-tui",
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.TUI,
              mode: GATEWAY_CLIENT_MODES.UI,
            },
            scopes: ["operator.write", "operator.admin"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: vi.fn() as RespondFn,
        context,
      });

      await vi.waitFor(() => expect(queuedLifecycle).toBeDefined(), FAST_WAIT_OPTS);
      expect(queuedLifecycle?.ownerKey).toBe("connection:conn-tui");
      expect(broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: "idem-queued-followup", state: "final" }),
      );
      dispatchRelease.resolve();
      await vi.waitFor(() => {
        expect(broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: "idem-queued-followup",
            sessionKey: "agent:main:main",
            state: "final",
          }),
        );
      }, FAST_WAIT_OPTS);
      const finalEvents = broadcast.mock.calls.filter(
        ([event, payload]) =>
          event === "chat" &&
          (payload as { runId?: string; state?: string }).runId === "idem-queued-followup" &&
          (payload as { state?: string }).state === "final",
      );
      expect(finalEvents).toHaveLength(1);
      expect(context.chatQueuedTurns.has("idem-queued-followup")).toBe(true);

      context.dedupe.delete("chat:idem-queued-followup");
      const replayRespond = vi.fn() as RespondFn;
      await chatHandlers["chat.send"]({
        req: {
          type: "req",
          id: "queued-followup-replay",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "queued prompt",
            idempotencyKey: "idem-queued-followup",
          },
        },
        params: {
          sessionKey: "main",
          message: "queued prompt",
          idempotencyKey: "idem-queued-followup",
        },
        client: {
          connId: "conn-tui",
          connect: {
            client: { id: GATEWAY_CLIENT_NAMES.TUI, mode: GATEWAY_CLIENT_MODES.UI },
            scopes: ["operator.write", "operator.admin"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: replayRespond,
        context,
      });
      expect(replayRespond).toHaveBeenCalledWith(
        true,
        { runId: "idem-queued-followup", status: "in_flight" },
        undefined,
        { cached: true, runId: "idem-queued-followup" },
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      const queuedEntry = context.chatQueuedTurns.get("idem-queued-followup");
      expect(queuedEntry).toBeDefined();
      queuedEntry?.controller.abort();
      expect(context.chatQueuedTurns.has("idem-queued-followup")).toBe(false);

      queuedLifecycle?.onComplete?.();
      expect(context.chatQueuedTurns.has("idem-queued-followup")).toBe(false);
      await vi.waitFor(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );

      let failedDispatchLifecycle: GetReplyOptions["queuedFollowupLifecycle"];
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        failedDispatchLifecycle = (args as { replyOptions?: GetReplyOptions }).replyOptions
          ?.queuedFollowupLifecycle;
        failedDispatchLifecycle?.onEnqueued?.();
        throw new Error("post-enqueue bookkeeping failed");
      });
      await chatHandlers["chat.send"]({
        req: {
          type: "req",
          id: "queued-followup-post-error",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "accepted before dispatch error",
            idempotencyKey: "idem-queued-followup-post-error",
          },
        },
        params: {
          sessionKey: "main",
          message: "accepted before dispatch error",
          idempotencyKey: "idem-queued-followup-post-error",
        },
        client: {
          connId: "conn-tui",
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.TUI,
              mode: GATEWAY_CLIENT_MODES.UI,
            },
            scopes: ["operator.write", "operator.admin"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: vi.fn() as RespondFn,
        context,
      });

      await vi.waitFor(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(2),
        FAST_WAIT_OPTS,
      );
      const acceptedErrorEvents = broadcast.mock.calls.filter(
        ([event, payload]) =>
          event === "chat" &&
          (payload as { runId?: string }).runId === "idem-queued-followup-post-error",
      );
      expect(acceptedErrorEvents).toHaveLength(1);
      expect(acceptedErrorEvents[0]?.[1]).toMatchObject({ state: "final" });
      expect(context.dedupe.get("chat:idem-queued-followup-post-error")).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(context.chatQueuedTurns.has("idem-queued-followup-post-error")).toBe(true);
      failedDispatchLifecycle?.onComplete?.();
      expect(context.chatQueuedTurns.has("idem-queued-followup-post-error")).toBe(false);
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
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
        getRuntimeConfig,
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
      await removeTempDir(sessionDir);
    }
  });

  test("chat.send emits first-assistant timing for direct final replies", async () => {
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
      const broadcast = vi.fn();
      const broadcastToConnIds = vi.fn();
      const context = {
        getRuntimeConfig,
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
        broadcast,
        broadcastToConnIds,
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const dispatcher = (
          args as {
            dispatcher?: {
              sendFinalReply: (payload: { text: string }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
            };
          }
        ).dispatcher;
        dispatcher?.sendFinalReply({ text: "direct reply" });
        dispatcher?.markComplete();
        await dispatcher?.waitForIdle();
        return {};
      });

      const { chatHandlers } = await import("./server-methods/chat.js");
      await chatHandlers["chat.send"]({
        req: {
          type: "req",
          id: "operator-direct-timing",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "measure direct",
            idempotencyKey: "idem-direct-server-timing",
          },
        },
        params: {
          sessionKey: "main",
          message: "measure direct",
          idempotencyKey: "idem-direct-server-timing",
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
            runId: "idem-direct-server-timing",
            status: "started",
          }),
          error: undefined,
        },
      ]);
      await vi.waitFor(
        () => {
          expect(broadcastToConnIds).toHaveBeenCalledWith(
            "chat.send_timing",
            expect.objectContaining({
              phase: "first-assistant-event",
              runId: "idem-direct-server-timing",
              sessionKey: "agent:main:main",
              ackToPhaseMs: expect.any(Number),
              dispatchStartedToPhaseMs: expect.any(Number),
              receivedToPhaseMs: expect.any(Number),
            }),
            new Set(["conn-control-ui"]),
            { dropIfSlow: true },
          );
          expect(broadcast).toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({
              runId: "idem-direct-server-timing",
              state: "final",
              message: expect.objectContaining({
                content: expect.arrayContaining([
                  expect.objectContaining({
                    text: "direct reply",
                  }),
                ]),
              }),
            }),
          );
        },
        { timeout: 2_000, interval: 5 },
      );

      const firstAssistantTimingCallIndex = broadcastToConnIds.mock.calls.findIndex(
        ([event, payload]) =>
          event === "chat.send_timing" &&
          (payload as { phase?: unknown }).phase === "first-assistant-event",
      );
      expect(firstAssistantTimingCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        broadcastToConnIds.mock.invocationCallOrder[firstAssistantTimingCallIndex],
      ).toBeLessThan(broadcast.mock.invocationCallOrder[0]);
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await removeTempDir(sessionDir);
    }
  });

  test("chat.history backfills claude-cli sessions from Claude project files", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionId = "sess-claude-cli-backfill";
      const homeEnvSnapshot = captureEnv(["HOME"]);
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
      setTestEnvValue("HOME", homeDir);
      try {
        await writeSessionStore({
          entries: {
            main: {
              sessionId,
              sessionFile: testSessionFilePath(sessionDir, sessionId),
              updatedAt: futureFixtureUpdatedAt(),
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
        homeEnvSnapshot.restore();
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

  test("chat.history offset pages overread context before filtering stale announce replies", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      const announce = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "subagent_announce",
      };
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
        JSON.stringify({
          timestamp: "2026-05-23T04:03:10.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "older visible turn" }],
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
            content: [{ type: "text", text: "stale announce reply" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-23T04:03:20.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "latest visible reply" }],
          },
        }),
      ]);

      const page = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        offset: 1,
        maxChars: 100,
      });
      expect(page.ok).toBe(true);
      expect(page.payload?.messages).toEqual([]);
      expect(JSON.stringify(page.payload)).not.toContain("stale announce reply");
      expect(page.payload?.nextOffset).toBe(2);
      expect(page.payload?.hasMore).toBe(true);
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

      await vi.waitFor(async () => {
        const completed = await rpcReq<{ status?: string }>(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-route",
        });
        expect(completed.ok).toBe(true);
        expect(completed.payload?.status).toBe("ok");
      }, FAST_WAIT_OPTS);
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
      await removeTempDir(timelineDir);
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

  test("chat.send rejects Control UI reconnect resume marker from public WebChat clients", async () => {
    await withGatewayChatHarness(
      async ({ ws }) => {
        await connectOk(ws, {
          client: {
            id: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
            version: "1.0.0",
            platform: "web",
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          },
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          sessionId: "sess-main",
          __controlUiReconnectResume: true,
          message: "hello after reconnect",
          idempotencyKey: "idem-public-webchat-resume",
        });
        expect(sendRes.ok).toBe(false);
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("chat.send forwards Control UI reconnect resume internally", async () => {
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
        let capturedOpts: InternalGetReplyOptions | undefined;
        mockGetReplyFromConfigOnce(async (_ctx, opts) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          sessionId: "sess-main",
          __controlUiReconnectResume: true,
          message: "hello after reconnect",
          idempotencyKey: "idem-requested-session-id",
        });
        expect(sendRes.ok).toBe(true);

        await vi.waitFor(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.requestedSessionId).toBe("sess-main");
        expect(capturedOpts?.resumeRequestedSession).toBe(true);
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
            usage: {
              input: 12,
              output: 5,
              totalTokens: 17,
              cost: { input: 0.002, output: 0.01, cacheRead: 0.0003, cacheWrite: 0, total: 0.0123 },
            },
            cost: { input: 0.002, output: 0.01, cacheRead: 0.0003, cacheWrite: 0, total: 0.0123 },
            details: { debug: true },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      const message = messages[0] as {
        role?: string;
        usage?: {
          input?: number;
          output?: number;
          totalTokens?: number;
          cost?: Record<string, number>;
        };
        cost?: Record<string, number>;
      };
      expect(message.role).toBe("assistant");
      expect(message.usage?.input).toBe(12);
      expect(message.usage?.output).toBe(5);
      expect(message.usage?.totalTokens).toBe(17);
      expect(message.usage?.cost).toEqual({
        input: 0.002,
        output: 0.01,
        cacheRead: 0.0003,
        cacheWrite: 0,
        total: 0.0123,
      });
      expect(message.cost).toEqual({
        input: 0.002,
        output: 0.01,
        cacheRead: 0.0003,
        cacheWrite: 0,
        total: 0.0123,
      });
      expect(message.cost?.total).toBe(0.0123);
      expect(messages[0]).not.toHaveProperty("details");
    });
  });

  test("chat.history preserves canonical parallel tool calls and bounded result diffs", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const fullDiff = `-12 old line\n+12 ${"new line ".repeat(20)}`;
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-edit",
                name: "edit",
                arguments: { path: "src/a.ts", oldText: "old line", newText: "new line" },
              },
              {
                type: "toolCall",
                id: "call-read",
                name: "read",
                arguments: { path: "src/b.ts" },
              },
            ],
            timestamp: 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-edit",
            toolName: "edit",
            content: [{ type: "text", text: "Updated src/a.ts" }],
            details: { diff: fullDiff, internal: "not for display" },
            timestamp: 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "contents of b" }],
            timestamp: 3,
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 48 });
      expect(messages).toHaveLength(3);
      const callMessage = messages[0] as {
        content?: Array<{ id?: string; name?: string }>;
      };
      expect(callMessage.content?.map((block) => [block.id, block.name])).toEqual([
        ["call-edit", "edit"],
        ["call-read", "read"],
      ]);
      const editResult = messages[1] as {
        toolCallId?: string;
        details?: Record<string, unknown>;
      };
      expect(editResult.toolCallId).toBe("call-edit");
      expect(editResult.details).toEqual({ diff: expect.any(String) });
      const projectedDiff = editResult.details?.diff;
      expect(typeof projectedDiff).toBe("string");
      expect(projectedDiff).toContain("-12 old line");
      expect(projectedDiff).toContain("...(truncated)...");
      expect((projectedDiff as string).length).toBeLessThanOrEqual(
        48 + "\n...(truncated)...".length,
      );
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

  test("chat.message.get returns archive-backed rows surfaced by history", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionId = "sess-archive-backed";
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir, sessionId });
      await fs.writeFile(
        `${testSessionFilePath(sessionDir, sessionId)}.reset.2026-02-16T22-26-34.000Z`,
        [
          JSON.stringify({ type: "session", version: 1, id: sessionId }),
          JSON.stringify({
            id: "msg-archive-full-assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "archive abcdefghij" }],
              timestamp: Date.now(),
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const historyMessages = await fetchHistoryMessages(ws, { maxChars: 12 });
      expect(JSON.stringify(historyMessages)).toContain("archive abcd\\n...(truncated)...");

      const full = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-archive-full-assistant",
      });
      expect(full.ok).toBe(true);
      expect(full.unavailableReason).toBeUndefined();
      expect(JSON.stringify(full.message)).toContain("archive abcdefghij");
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
        JSON.stringify({
          id: "msg-side-delivery",
          parentId: "msg-active",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "side delivery" }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          type: "leaf",
          id: "active-leaf",
          parentId: "msg-side-delivery",
          targetId: "msg-active",
        }),
      ]);

      const stale = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-stale",
      });
      expect(stale.ok).toBe(false);
      expect(stale.unavailableReason).toBe("not_found");

      const sideDelivery = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-side-delivery",
      });
      expect(sideDelivery.ok).toBe(false);
      expect(sideDelivery.unavailableReason).toBe("not_found");

      const active = await fetchChatMessage(ws, {
        sessionKey: "main",
        messageId: "msg-active",
      });
      expect(active.ok).toBe(true);
      expect(JSON.stringify(active.message)).toContain("active branch");
      expect(JSON.stringify(await fetchHistoryMessages(ws))).not.toContain("side delivery");
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

  test("chat.history offset pagination advances from the projected first-page boundary", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "oldest question" }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "oldest answer" }],
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "visible boundary" }],
            timestamp: Date.now() + 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "NO_REPLY" }],
            timestamp: Date.now() + 3,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "visible latest" }],
            timestamp: Date.now() + 4,
          },
        }),
      ]);

      const firstPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
        totalMessages?: number;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 2,
        offset: 0,
        maxChars: 100,
      });
      expect(firstPage.ok).toBe(true);
      expect(firstPage.payload?.messages?.map(readOpenClawSeq)).toEqual([3, 5]);
      expect(firstPage.payload?.nextOffset).toBe(3);
      expect(firstPage.payload?.hasMore).toBe(true);
      expect(firstPage.payload?.totalMessages).toBe(5);

      const secondPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        hasMore?: boolean;
        nextOffset?: number;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 2,
        offset: firstPage.payload?.nextOffset,
        maxChars: 100,
      });
      expect(secondPage.ok).toBe(true);
      expect(secondPage.payload?.messages?.map(readOpenClawSeq)).toEqual([1, 2]);
      expect(JSON.stringify(secondPage.payload?.messages)).not.toContain("visible boundary");
      expect(secondPage.payload?.hasMore).toBe(false);
      expect(secondPage.payload?.nextOffset).toBeUndefined();
    });
  });

  test("chat.history offset pagination advances from the final budgeted page", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes: 250,
      });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "older question" }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "older answer" }],
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "latest" }],
            timestamp: Date.now() + 2,
          },
        }),
      ]);

      const firstPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
        totalMessages?: number;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 3,
        offset: 0,
        maxChars: 1_000,
      });
      expect(firstPage.ok).toBe(true);
      expect(firstPage.payload?.messages?.map(readOpenClawSeq)).toEqual([2, 3]);
      expect(firstPage.payload?.nextOffset).toBe(2);
      expect(firstPage.payload?.hasMore).toBe(true);
      expect(firstPage.payload?.totalMessages).toBe(3);
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
