import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliverReplies } from "./bot/delivery.js";
import { sendMessageTelegram } from "./send.js";

describe("Telegram physical send acceptance over HTTP", () => {
  let server: Server;
  let bot: Bot;
  let mediaDir: string;
  let photoPath: string;
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; fields: Record<string, unknown> }> = [];
  const events: string[] = [];
  const rejections: string[] = [];
  const cfg = { channels: { telegram: { botToken: "123456:telegram-send-http-fixture" } } };
  const buttons = [[{ text: "Continue", callback_data: "continue" }]];

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
});
