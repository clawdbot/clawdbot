import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramBot } from "./bot.js";
import { deliverReplies } from "./bot/delivery.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
  resetTelegramMessageCacheForTest,
  resetTelegramSentMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { sendMessageTelegram } from "./send.js";

describe("Telegram physical send acceptance over HTTP", () => {
  let server: Server;
  let bot: Bot;
  let mediaDir: string;
  let photoPath: string;
  const localBotFiles = new Map<string, string>();
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; fields: Record<string, unknown> }> = [];
  const events: string[] = [];
  const rejections: string[] = [];
  const cfg = { channels: { telegram: { botToken: "123456:telegram-send-http-fixture" } } };
  const buttons = [[{ text: "Continue", callback_data: "continue" }]];

  async function expectUploadedDocument(
    fields: Record<string, unknown> | undefined,
    expected: Buffer,
  ) {
    const reference = fields?.document;
    assert(typeof reference === "string" && reference.startsWith("attach://"));
    // Telegram refers to the separate multipart file part by its attachment identifier.
    const uploaded = fields?.[reference.slice("attach://".length)];
    assert(uploaded instanceof File);
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(expected);
  }

  beforeAll(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-physical-send-"));
    photoPath = path.join(mediaDir, "pixel.png");
    await fs.writeFile(
      photoPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const respond = async () => {
        const body = Buffer.concat(chunks);
        const contentType = request.headers["content-type"] ?? "application/json";
        const fields = contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Response(body, { headers: { "content-type": contentType } }).formData(),
            )
          : (JSON.parse(body.toString("utf8")) as Record<string, unknown>);
        const method = request.url?.split("/").at(-1) ?? "";
        requests.push({ method, fields });
        events.push("http");
        response.setHeader("content-type", "application/json");
        const rejection = rejections.shift();
        if (rejection) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, error_code: 400, description: rejection }));
          return;
        }
        if (method === "getFile") {
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                file_id: fields.file_id,
                file_path: localBotFiles.get(String(fields.file_id)),
              },
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: requests.length,
              date: 1_700_000_000,
              chat: { id: 123, type: "private" },
              text: fields.text,
              caption: fields.caption,
              ...(fields.message_thread_id
                ? { message_thread_id: Number(fields.message_thread_id) }
                : {}),
            },
          }),
        );
      };
      request.on("end", () => {
        void respond().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    bot = new Bot(cfg.channels.telegram.botToken, {
      client: { apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    });
  });

  beforeEach(() => {
    requests.length = 0;
    events.length = 0;
    rejections.length = 0;
    localBotFiles.clear();
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await fs.rm(mediaDir, { recursive: true, force: true });
  });

  async function sendThrough(
    entry: "direct" | "public",
    text: string,
    dispatch: () => Promise<void>,
    mediaUrl?: string,
    rich = false,
    assertPlatformSendAuthorized?: () => void,
  ) {
    if (entry === "public") {
      return sendMessageTelegram("123", text, {
        cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: rich } } },
        api: bot.api,
        textMode: rich ? undefined : "html",
        replyToMessageId: 7,
        quoteText: "quote",
        onPlatformSendDispatch: dispatch,
        assertPlatformSendAuthorized,
        ...(mediaUrl ? { mediaUrl, mediaLocalRoots: [mediaDir], buttons } : {}),
        ...(rich ? { buttons } : {}),
      });
    }
    return deliverReplies({
      cfg,
      bot,
      chatId: "123",
      token: cfg.channels.telegram.botToken,
      runtime: {
        log() {},
        error() {},
        exit: () => {
          throw new Error("unexpected exit");
        },
      },
      replies: [
        {
          text,
          replyToId: "7",
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrl || rich ? { channelData: { telegram: { buttons } } } : {}),
        },
      ],
      mediaLocalRoots: [mediaDir],
      replyToMode: "all",
      textLimit: 4000,
      replyQuoteMessageId: 7,
      replyQuoteText: "quote",
      textMode: rich ? undefined : "html",
      richMessages: rich,
      onPlatformSendDispatch: dispatch,
      assertPlatformSendAuthorized,
    });
  }

  it("projects unspaced labeled links through the public Telegram plain-text contract", async () => {
    const source = "<https://example.com/a.pdf|Manual>";
    const text = sanitizeForPlainText(source, { style: "markdown" });

    await sendThrough("public", text, async () => {});

    expect(requests.at(-1)?.fields.text).toBe("Manual");
  });

  it("fences provider-owned delivery after async dispatch refresh and before HTTP", async () => {
    const authorityRevoked = new Error("delivery authority revoked after dispatch refresh");
    let authorityActive = true;
    const dispatch = async () => {
      await Promise.resolve();
      authorityActive = false;
    };
    const assertPlatformSendAuthorized = () => {
      if (!authorityActive) {
        throw authorityRevoked;
      }
    };

    await expect(
      sendThrough("direct", "answer", dispatch, undefined, false, assertPlatformSendAuthorized),
    ).rejects.toBe(authorityRevoked);
    expect(requests).toHaveLength(0);
  });

  it.each(["direct", "public"] as const)(
    "preserves %s operation callbacks through quote and format fallback",
    async (entry) => {
      rejections.push("Bad Request: quote not found", "Bad Request: can't parse entities");
      await sendThrough(entry, "answer", async () => {
        events.push("dispatch");
      });
      expect(events).toEqual(
        entry === "direct"
          ? ["dispatch", "http", "http", "http"]
          : ["dispatch", "http", "dispatch", "http", "dispatch", "http"],
      );
      expect(requests).toHaveLength(3);
      expect(requests[0]?.fields.reply_parameters).toMatchObject({ message_id: 7, quote: "quote" });
      expect(requests[1]?.fields.reply_to_message_id).toBe(7);
      expect(requests[2]?.fields.parse_mode).toBeUndefined();
    },
  );

  it.each(["direct", "public"] as const)(
    "retains accepted IDs when the next existing %s callback rejects closure",
    async (entry) => {
      const closure = new PlatformMessageNotDispatchedError("delivery owner closed", {
        cause: new Error("fixture authority closed after the first accepted HTTP request"),
      });
      const observed = await sendThrough(entry, "A".repeat(8000), async () => {
        events.push("dispatch");
        if (requests.length > 0) {
          throw closure;
        }
      }).catch((error: unknown) => error);
      expect(events).toEqual(["dispatch", "http", "dispatch"]);
      expect(requests).toHaveLength(1);
      expect(isChannelPartialDeliveryError(observed)).toBe(true);
      if (!isChannelPartialDeliveryError(observed)) {
        throw observed;
      }
      expect(observed.deliveryResult.messageIds).toEqual(["1"]);
      const causes: Error[] = [];
      for (
        let cause: unknown = observed;
        cause instanceof Error && !causes.includes(cause);
        cause = cause.cause
      ) {
        causes.push(cause);
      }
      expect(causes).toContain(closure);
    },
  );

  it.each(["direct", "public"] as const)(
    "preserves %s media follow-up ordering and keyboard placement",
    async (entry) => {
      await sendThrough(entry, "A".repeat(9000), async () => {}, photoPath);
      expect(requests.map(({ method }) => method)).toEqual([
        "sendPhoto",
        "sendMessage",
        "sendMessage",
        "sendMessage",
      ]);
      expect(requests[0]?.fields.caption).toBeUndefined();
      expect(requests.slice(1).map(({ fields }) => String(fields.text).length)).toEqual([
        4000, 4000, 1000,
      ]);
      expect(requests.flatMap(({ fields }, index) => (fields.reply_markup ? [index] : []))).toEqual(
        [entry === "direct" ? 1 : 3],
      );
    },
  );

  it.each([
    ["direct", true],
    ["direct", false],
    ["public", true],
    ["public", false],
  ] as const)(
    "keeps %s delivery when a rendered-empty chunk comes first=%s",
    async (entry, first) => {
      const empty = "Bad Request: text must be non-empty";
      rejections.push(...(first ? [empty, empty, ""] : ["", empty, empty]));

      await sendThrough(entry, `${"A".repeat(4000)}${"B".repeat(4000)}`, async () => {});

      expect(requests.map(({ fields }) => fields.text)).toEqual(
        (first ? ["A", "A", "B"] : ["A", "B", "B"]).map((text) => text.repeat(4000)),
      );
      expect(requests.map(({ fields }) => fields.parse_mode)).toEqual(
        first ? ["HTML", undefined, "HTML"] : ["HTML", "HTML", undefined],
      );
    },
  );

  it.each(["direct", "public"] as const)(
    "preserves %s accepted media after photo rejection falls back to a document",
    async (entry) => {
      rejections.push("Bad Request: PHOTO_INVALID_DIMENSIONS");
      await sendThrough(
        entry,
        "caption",
        async () => {
          events.push("dispatch");
        },
        photoPath,
      );
      expect(requests.map(({ method }) => method)).toEqual(["sendPhoto", "sendDocument"]);
      expect(requests.map(({ fields }) => fields.caption)).toEqual(["caption", "caption"]);
      expect(events).toEqual(["dispatch", "http", "dispatch", "http"]);
    },
  );

  it.each(["direct", "public"] as const)(
    "retains %s buttons when a rich native quote is rejected",
    async (entry) => {
      rejections.push("Bad Request: quote not found");
      await sendThrough(entry, "answer", async () => {}, undefined, true);
      expect(requests.map(({ method }) => method)).toEqual(["sendRichMessage", "sendRichMessage"]);
      expect(requests[0]?.fields.reply_parameters).toMatchObject({ message_id: 7, quote: "quote" });
      expect(requests[1]?.fields.reply_parameters).toMatchObject({ message_id: 7 });
      expect(requests[1]?.fields.reply_parameters).not.toHaveProperty("quote");
      expect(requests.map(({ fields }) => fields.reply_markup)).toEqual([
        { inline_keyboard: buttons },
        { inline_keyboard: buttons },
      ]);
    },
  );

  it("retains the observed media receipt when accepted-send bookkeeping fails", async () => {
    const error = new Error("delivery observer failed");
    const observed = await sendMessageTelegram("123", "caption", {
      cfg,
      api: bot.api,
      mediaUrl: photoPath,
      mediaLocalRoots: [mediaDir],
      messageThreadId: 42,
      onDeliveryResult: () => {
        throw error;
      },
    }).catch((failure: unknown) => failure);
    expect(requests.map(({ method }) => method)).toEqual(["sendPhoto"]);
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["1"]);
    expect(observed.deliveryResult.receipt).toMatchObject({
      threadId: "42",
      platformMessageIds: ["1"],
    });
  });

  it.each([
    new Error("delivery observer failed"),
    new Error("can't parse entities"),
    new Error("message text is empty"),
    Object.assign(new Error("Bad Request: observer failed"), { error_code: 400 }),
  ])("never resends or continues after observing an accepted message fails: %s", async (error) => {
    const observedIds: string[] = [];
    let observedError: unknown;
    try {
      await sendMessageTelegram("123", `${"A".repeat(4000)}${"B".repeat(4000)}tail`, {
        cfg,
        api: bot.api,
        textMode: "html",
        onDeliveryResult: (delivery) => {
          observedIds.push(delivery.messageId);
          if (observedIds.length === 2) {
            throw error;
          }
        },
      });
    } catch (caught) {
      observedError = caught;
    }

    expect(
      requests.map(({ method, fields }) => ({
        method,
        textPrefix: String(fields.text).slice(0, 4),
        textLength: String(fields.text).length,
        parseMode: fields.parse_mode,
      })),
    ).toEqual([
      { method: "sendMessage", textPrefix: "AAAA", textLength: 4000, parseMode: "HTML" },
      { method: "sendMessage", textPrefix: "BBBB", textLength: 4000, parseMode: "HTML" },
    ]);
    expect(observedIds).toEqual(["1", "2"]);
    expect(isChannelPartialDeliveryError(observedError)).toBe(true);
    if (!isChannelPartialDeliveryError(observedError)) {
      throw observedError;
    }
    expect(observedError.deliveryResult.messageIds).toEqual(["1", "2"]);
    expect(observedError.deliveryResult.receipt?.platformMessageIds).toEqual(["1", "2"]);
  });

  it.each([
    { label: "fractional channel limit", mediaMaxMb: 0.001, size: 1048, accepted: true },
    { label: "next byte above the limit", mediaMaxMb: 0.001, size: 1049, accepted: false },
    { label: "positive sub-byte limit", mediaMaxMb: 0.1 / (1024 * 1024), size: 1, accepted: false },
    {
      label: "explicit byte override",
      mediaMaxMb: 0.1 / (1024 * 1024),
      maxBytes: 1048,
      size: 1048,
      accepted: true,
    },
    { label: "explicit zero override", mediaMaxMb: 30.1, maxBytes: 0, size: 1048, accepted: false },
    {
      label: "invalid byte override fallback",
      mediaMaxMb: 0.001,
      maxBytes: Number.POSITIVE_INFINITY,
      size: 1049,
      accepted: false,
    },
    { label: "agent fallback limit", mediaMaxMb: undefined, size: 1048, accepted: false },
  ])("enforces $label for a local document", async (testCase) => {
    const document = Buffer.alloc(testCase.size, 0x61);
    document.write("%PDF-1.4\n");
    const documentPath = path.join(mediaDir, "limit.pdf");
    await fs.writeFile(documentPath, document);
    const sending = sendMessageTelegram("123", "document", {
      cfg: {
        agents: { defaults: { mediaMaxMb: 0.1 / (1024 * 1024) } },
        channels: { telegram: { ...cfg.channels.telegram, mediaMaxMb: testCase.mediaMaxMb } },
      },
      api: bot.api,
      mediaUrl: documentPath,
      mediaLocalRoots: [mediaDir],
      forceDocument: true,
      ...("maxBytes" in testCase ? { maxBytes: testCase.maxBytes } : {}),
    });
    if (!testCase.accepted) {
      await expect(sending).rejects.toThrow(/exceeds|too large/i);
      expect(requests).toHaveLength(0);
      return;
    }
    await sending;
    expect(requests.map(({ method }) => method)).toEqual(["sendDocument"]);
    await expectUploadedDocument(requests[0]?.fields, document);
  });

  it.each([
    {
      label: "inbound configured decimal cap",
      direction: "inbound",
      mediaMaxMb: 0.001,
      override: undefined,
      size: 1048,
      unavailable: false,
    },
    {
      label: "inbound MiB override",
      direction: "inbound",
      mediaMaxMb: 0.1 / (1024 * 1024),
      override: 0.001,
      size: 1048,
      unavailable: false,
    },
    {
      label: "inbound invalid override fallback",
      direction: "inbound",
      mediaMaxMb: 0.001,
      override: Number.POSITIVE_INFINITY,
      size: 1049,
      unavailable: true,
    },
    {
      label: "reply configured decimal cap",
      direction: "reply",
      mediaMaxMb: 30.1,
      override: undefined,
      size: 1048,
      unavailable: false,
    },
    {
      label: "reply MiB override",
      direction: "reply",
      mediaMaxMb: 0.1 / (1024 * 1024),
      override: 30.1,
      size: 1048,
      unavailable: false,
    },
    {
      label: "inbound integer cap control",
      direction: "inbound",
      mediaMaxMb: 1,
      override: undefined,
      size: 1048,
      unavailable: false,
    },
    {
      label: "inbound default cap control",
      direction: "inbound",
      mediaMaxMb: undefined,
      override: undefined,
      size: 1048,
      unavailable: false,
    },
    {
      label: "reply integer cap control",
      direction: "reply",
      mediaMaxMb: 1,
      override: undefined,
      size: 1048,
      unavailable: false,
    },
    {
      label: "reply default cap control",
      direction: "reply",
      mediaMaxMb: undefined,
      override: undefined,
      size: 1048,
      unavailable: false,
    },
    {
      label: "inbound oversize integer cap control",
      direction: "inbound",
      mediaMaxMb: 1,
      override: undefined,
      size: 1024 * 1024 + 1,
      unavailable: true,
    },
  ] as const)("preserves $label through the bot's real file read", async (testCase) => {
    const state = await createOpenClawTestState({ label: "telegram-media-limit" });
    const abort = new AbortController();
    let receivingBot: ReturnType<typeof createTelegramBot> | undefined;
    try {
      const document = Buffer.alloc(testCase.size, 0x61);
      document.write("%PDF-1.4\n");
      const documentName = testCase.unavailable ? "oversize-control.pdf" : "limit.pdf";
      const documentPath = path.join(state.workspaceDir, documentName);
      await fs.writeFile(documentPath, document);
      localBotFiles.set("local-document", documentPath);
      const botCfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        commands: { native: false, nativeSkills: false },
        channels: {
          telegram: {
            ...cfg.channels.telegram,
            apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            trustedLocalFileRoots: [state.workspaceDir],
            mediaMaxMb: testCase.mediaMaxMb,
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      };
      await state.writeConfig(botCfg);
      setTelegramRuntime({
        state: {
          openKeyedStore: ((options) =>
            createPluginStateKeyedStoreForTests(
              "telegram",
              options,
            )) as TelegramRuntime["state"]["openKeyedStore"],
          openSyncKeyedStore: ((options) =>
            createPluginStateSyncKeyedStoreForTests(
              "telegram",
              options,
            )) as TelegramRuntime["state"]["openSyncKeyedStore"],
        },
        channel: {},
      } as TelegramRuntime);
      const received: Buffer[] = [];
      const contexts: Array<{
        agentText: string | undefined;
        commandText: string | undefined;
        paths: string[];
      }> = [];
      receivingBot = createTelegramBot({
        token: cfg.channels.telegram.botToken,
        botInfo: telegramBotInfoForTest,
        config: botCfg,
        mediaMaxMb: testCase.override,
        accountAbortSignal: abort.signal,
        fetchAbortSignal: abort.signal,
        telegramTransport: { fetch, sourceFetch: fetch, close: async () => {} },
        telegramDeps: { ...defaultTelegramBotDeps, getRuntimeConfig: () => botCfg },
        dispatchReplyFromConfig: async ({ ctx, dispatcher }) => {
          contexts.push({
            agentText: ctx.agentText,
            commandText: ctx.commandText,
            paths: (ctx.media ?? []).flatMap((media) => (media.path ? [media.path] : [])),
          });
          for (const media of ctx.media ?? []) {
            if (media.path) {
              received.push(await fs.readFile(media.path));
            }
          }
          if (testCase.direction === "reply") {
            // Media emitted before the final answer uses Telegram's streaming send funnel.
            dispatcher.sendBlockReply({ mediaUrl: documentPath });
          }
          return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
        },
      });
      await receivingBot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: 123, type: "private", first_name: "Fixture" },
          from: { id: 77, is_bot: false, first_name: "Fixture" },
          ...(testCase.direction === "inbound"
            ? {
                caption: "read this document",
                document: {
                  file_id: "local-document",
                  file_unique_id: "local-document",
                  file_name: documentName,
                  mime_type: "application/pdf",
                  file_size: document.length,
                },
              }
            : { text: "send the document" }),
        },
      });
      if (testCase.direction === "inbound") {
        expect(requests.filter(({ method }) => method === "getFile")).toHaveLength(1);
        expect(contexts).toHaveLength(1);
        if (testCase.unavailable) {
          expect(received).toEqual([]);
          expect(contexts[0]?.paths).toEqual([]);
          // Local read failures currently project a download-failed notice, even for too-large.
          expect(contexts[0]?.agentText).toContain("[media unavailable: download failed]");
          expect(contexts[0]?.commandText).toBe("read this document");
          expect(
            requests.some(({ method }) =>
              /^send(?:Document|Photo|Video|Audio|Voice)$/.test(method),
            ),
          ).toBe(false);
        } else {
          expect(received).toEqual([document]);
          expect(contexts[0]?.agentText).not.toContain("[media unavailable:");
        }
      } else {
        const uploads = requests.filter(({ method }) => method === "sendDocument");
        expect(uploads).toHaveLength(1);
        await expectUploadedDocument(uploads[0]?.fields, document);
      }
    } finally {
      await receivingBot?.stop();
      abort.abort();
      resetPluginStateStoreForTests();
      resetTelegramMessageCacheForTest();
      resetTelegramSentMessageCacheForTest();
      resetTelegramAccountThrottlersForTest();
      clearTelegramRuntimeForTest();
      await state.cleanup();
    }
  });
});
