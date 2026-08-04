// Real grammY ingress and Bot API sockets: stalled forum metadata must not block delivery.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Bot } from "grammy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerTelegramMessageHandlers } from "./bot-handlers.message-events.runtime.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resetTelegramForumFlagCacheForTest } from "./bot/helpers.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import * as telegramRequestTimeouts from "./request-timeouts.js";

describe("Telegram supergroup ingress with a stalled Bot API response body", () => {
  const liveSockets = new Set<Socket>();
  let server: Server;
  let apiRoot: string;
  let getChatRequests = 0;
  let closedSocketCount = 0;
  let resolveGetChatHeaders: (() => void) | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (!request.url?.endsWith("/getChat")) {
        response.writeHead(404);
        response.end();
        return;
      }
      getChatRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true,"result":{"id":-100364');
      resolveGetChatHeaders?.();
    });
    server.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.once("close", () => {
        liveSockets.delete(socket);
        closedSocketCount += 1;
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    resetTelegramForumFlagCacheForTest();
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("dispatches DMs immediately and the supergroup after cancelling its stalled socket", async () => {
    const canonicalRequestTimeout = telegramRequestTimeouts.resolveTelegramRequestTimeoutMs;
    vi.spyOn(telegramRequestTimeouts, "resolveTelegramRequestTimeoutMs").mockImplementation(
      (method, configuredTimeoutSeconds) =>
        method === "getchat" ? 100 : canonicalRequestTimeout(method, configuredTimeoutSeconds),
    );
    resetTelegramForumFlagCacheForTest();

    const clientFetch = createTelegramClientFetch({
      fetchImpl: asTelegramClientFetch(globalThis.fetch),
    });
    if (!clientFetch) {
      throw new Error("expected production Telegram client fetch wrapper");
    }
    const botInfo = telegramBotInfoForTest;
    const bot = new Bot("123456:integration-token", {
      botInfo,
      client: { apiRoot, fetch: asTelegramClientFetch(clientFetch) },
    });
    const dispatched = vi.fn<
      Parameters<typeof registerTelegramMessageHandlers>[3]["processInboundMessage"]
    >(async () => undefined);
    const emptyAllow = {
      entries: [],
      hasWildcard: false,
      hasEntries: false,
      invalidEntries: [],
    };
    const authorization = {
      authorizeInboundMessage: vi.fn(async () => ({
        allowed: true as const,
        effectiveDmAllow: emptyAllow,
        context: {
          cfg: {},
          telegramCfg: {},
          allowFrom: [],
          dmPolicy: "open" as const,
          storeAllowFrom: [],
          effectiveGroupAllow: emptyAllow,
          hasGroupAllowOverride: false,
        },
      })),
    } satisfies Parameters<typeof registerTelegramMessageHandlers>[2];
    const messageRuntime = {
      normalizePromptContextMinTimestampMs: () => undefined,
      promptContextBoundaryOptions: () => ({}),
      releaseDispatchDedupeClaims: () => undefined,
      claimMessageDispatchDedupe: async () => ({ process: true, claims: [] }),
      buildSyntheticContext: (context, message) => ({
        message,
        me: context.me,
        getFile: context.getFile.bind(context),
      }),
      resolveTelegramSessionState: () => ({
        agentId: "integration",
        sessionEntry: undefined,
        sessionKey: "integration",
        storePath: "integration",
        model: undefined,
      }),
      resolvePromptContextAmbientWatermark: () => undefined,
      recordMessageForReplyChain: async () => undefined,
    } satisfies Parameters<typeof registerTelegramMessageHandlers>[1];

    registerTelegramMessageHandlers(
      {
        bot,
        opts: { botInfo },
        runtime: { error: vi.fn() },
        shouldSkipUpdate: () => false,
      } satisfies Parameters<typeof registerTelegramMessageHandlers>[0],
      messageRuntime,
      authorization,
      { processInboundMessage: dispatched },
    );

    const headersReceived = new Promise<void>((resolve) => {
      resolveGetChatHeaders = resolve;
    });
    const groupDelivery = bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: -100364, type: "supergroup", title: "Integration group" },
        from: { id: 111, is_bot: false, first_name: "Group sender" },
        text: "group message",
      },
    });
    void groupDelivery.catch(() => undefined);
    await headersReceived;

    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 22,
        date: 1_700_000_001,
        chat: { id: 222, type: "private", first_name: "DM sender" },
        from: { id: 222, is_bot: false, first_name: "DM sender" },
        text: "direct message",
      },
    });
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(dispatched.mock.calls[0]?.[0]).toMatchObject({ chatId: 222, isGroup: false });

    const groupResult = await Promise.race([
      groupDelivery.then(() => "dispatched" as const),
      new Promise<"stalled">((resolve) => {
        setTimeout(() => resolve("stalled"), 1_000);
      }),
    ]);

    expect(groupResult).toBe("dispatched");
    expect(dispatched).toHaveBeenCalledTimes(2);
    expect(dispatched.mock.calls[1]?.[0]).toMatchObject({
      chatId: -100364,
      isGroup: true,
      isForum: false,
    });
    expect(getChatRequests).toBe(1);
    await vi.waitFor(() => expect(closedSocketCount).toBeGreaterThan(0));
  });
});
