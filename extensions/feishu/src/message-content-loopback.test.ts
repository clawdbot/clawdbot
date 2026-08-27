// Prove Feishu message parsing against the real SDK, auth exchange, and HTTP transport.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuMediaList } from "./bot-content.js";
import { sendStickerFeishu } from "./media.js";
import { getMessageFeishu } from "./send.js";

const { mockLogVerbose } = vi.hoisted(() => ({ mockLogVerbose: vi.fn() }));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return { ...actual, logVerbose: mockLogVerbose };
});

type RecordedMessageRequest = {
  method: string;
  path: string;
  cardMessageContentType?: string;
  appId?: string;
  authorization?: string;
  messageType?: unknown;
  content?: unknown;
  receiveId?: unknown;
  replyInThread?: unknown;
};

describe("Feishu message content over the real Lark SDK", () => {
  it("authenticates message reads and sticker sends without exposing malformed content", async () => {
    const requests: RecordedMessageRequest[] = [];
    const sensitiveContentByMessageId = new Map([
      ["om_loopback_bad_text", { type: "text", content: "LKTEXT107" }],
      ["om_loopback_bad_post", { type: "post", content: "LKPOST107" }],
      ["om_loopback_bad_card", { type: "interactive", content: "LKCARD107" }],
    ]);

    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }

        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const record: RecordedMessageRequest = {
          method: request.method ?? "",
          path: url.pathname,
          ...(url.searchParams.get("card_msg_content_type")
            ? { cardMessageContentType: url.searchParams.get("card_msg_content_type") ?? undefined }
            : {}),
          ...(typeof body.app_id === "string" ? { appId: body.app_id } : {}),
          ...(typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {}),
          ...(body.msg_type ? { messageType: body.msg_type, content: body.content } : {}),
          ...(body.receive_id ? { receiveId: body.receive_id } : {}),
          ...(body.reply_in_thread ? { replyInThread: body.reply_in_thread } : {}),
        };
        requests.push(record);

        const sendJson = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };

        if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
          if (
            request.method !== "POST" ||
            body.app_id !== "cli_feishu_content_107947" ||
            body.app_secret !== "loopback-placeholder"
          ) {
            sendJson(401, { code: 99991663, msg: "invalid loopback application" });
            return;
          }
          sendJson(200, {
            code: 0,
            msg: "ok",
            tenant_access_token: "tat-feishu-content-107947",
            expire: 7200,
          });
          return;
        }

        if (record.authorization !== "Bearer tat-feishu-content-107947") {
          sendJson(401, { code: 99991663, msg: "missing authenticated message request" });
          return;
        }

        if (request.method === "POST" && body.msg_type === "sticker") {
          if (url.pathname === "/open-apis/im/v1/messages/om_withdrawn_sticker/reply") {
            sendJson(200, { code: 230011, msg: "The message was withdrawn." });
            return;
          }
          const isCreate = url.pathname === "/open-apis/im/v1/messages";
          const isReply = url.pathname === "/open-apis/im/v1/messages/om_received_sticker/reply";
          if ((isCreate && url.searchParams.get("receive_id_type") === "chat_id") || isReply) {
            sendJson(200, {
              code: 0,
              data: { message_id: isCreate ? "om_sticker_sent" : "om_sticker_reply" },
            });
            return;
          }
        }

        if (request.method !== "GET" || record.cardMessageContentType !== "user_card_content") {
          sendJson(400, { code: 400, msg: "unexpected loopback request" });
          return;
        }

        const messageId = url.pathname.match(/^\/open-apis\/im\/v1\/messages\/([^/]+)$/)?.[1];
        if (!messageId) {
          sendJson(404, { code: 404, msg: "unexpected loopback message route" });
          return;
        }

        if (messageId === "om_loopback_vendor_error") {
          sendJson(200, { code: 230001, msg: "message not found" });
          return;
        }

        const malformed = sensitiveContentByMessageId.get(messageId);
        const message = malformed
          ? { msg_type: malformed.type, body: { content: malformed.content } }
          : messageId === "om_loopback_valid_text"
            ? { msg_type: "text", body: { content: JSON.stringify({ text: "safe message" }) } }
            : messageId === "om_loopback_empty_text"
              ? { msg_type: "text", body: { content: "" } }
              : undefined;

        if (!message) {
          sendJson(404, { code: 404, msg: "unknown loopback message" });
          return;
        }

        sendJson(200, {
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: messageId,
                chat_id: "oc_feishu_content_107947",
                chat_type: "group",
                ...message,
              },
            ],
          },
        });
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const loopbackOrigin = `http://127.0.0.1:${address.port}`;
    // Preserve the real SDK domain; its path filler interprets custom :port
    // values as route parameters. Redirect the original Axios transport only.
    const loopbackInterceptor = Lark.defaultHttpInstance.interceptors.request.use(
      (options) => {
        const upstream = new URL(options.url ?? "");
        if (upstream.hostname === "open.feishu.cn") {
          options.url = new URL(
            `${upstream.pathname}${upstream.search}`,
            loopbackOrigin,
          ).toString();
        }
        return options;
      },
      undefined,
      { synchronous: true },
    );

    try {
      mockLogVerbose.mockClear();
      const cfg = {
        channels: {
          feishu: {
            enabled: true,
            appId: "cli_feishu_content_107947",
            appSecret: "loopback-placeholder", // pragma: allowlist secret
            domain: "feishu",
          },
        },
      } as ClawdbotConfig;

      for (const [messageId, malformed] of sensitiveContentByMessageId) {
        let exposedParserError: unknown;
        try {
          JSON.parse(malformed.content);
        } catch (error) {
          exposedParserError = error;
        }
        expect(exposedParserError).toBeInstanceOf(SyntaxError);
        expect((exposedParserError as Error).message).toContain(malformed.content);

        await expect(getMessageFeishu({ cfg, messageId })).resolves.toMatchObject({
          messageId,
          chatId: "oc_feishu_content_107947",
          contentType: malformed.type,
          content: malformed.content,
        });
        expect(mockLogVerbose).toHaveBeenCalledWith(
          `feishu message content parse failed for ${malformed.type} message (id: ${messageId})`,
        );
      }

      await expect(
        getMessageFeishu({ cfg, messageId: "om_loopback_valid_text" }),
      ).resolves.toMatchObject({
        messageId: "om_loopback_valid_text",
        contentType: "text",
        content: "safe message",
      });

      await expect(
        getMessageFeishu({ cfg, messageId: "om_loopback_empty_text" }),
      ).resolves.toMatchObject({
        messageId: "om_loopback_empty_text",
        contentType: "text",
        content: "",
      });

      await expect(
        getMessageFeishu({ cfg, messageId: "om_loopback_vendor_error" }),
      ).resolves.toBeNull();

      const loggedValues = mockLogVerbose.mock.calls.flat().map(String).join("\n");
      for (const { content } of sensitiveContentByMessageId.values()) {
        expect(loggedValues).not.toContain(content);
      }
      expect(loggedValues).not.toContain("loopback-placeholder");
      expect(mockLogVerbose).toHaveBeenCalledTimes(sensitiveContentByMessageId.size);

      expect(requests.filter((request) => request.path.includes("tenant_access_token"))).toEqual([
        {
          method: "POST",
          path: "/open-apis/auth/v3/tenant_access_token/internal",
          appId: "cli_feishu_content_107947",
        },
      ]);
      expect(requests.filter((request) => request.method === "GET")).toHaveLength(6);
      for (const request of requests.filter((entry) => entry.method === "GET")) {
        expect(request).toMatchObject({
          authorization: "Bearer tat-feishu-content-107947",
          cardMessageContentType: "user_card_content",
        });
      }

      const requestCountBeforeSticker = requests.length;
      await expect(
        resolveFeishuMediaList({
          cfg,
          messageId: "om_received_sticker",
          messageType: "sticker",
          content: JSON.stringify({ file_key: "file_sticker_received" }),
          maxBytes: 1024,
        }),
      ).resolves.toEqual([]);
      expect(requests).toHaveLength(requestCountBeforeSticker);

      for (const replyInThread of [false, true]) {
        const result = await sendStickerFeishu({
          cfg,
          to: "chat:oc_feishu_content_107947",
          fileKey: "file_sticker_received",
          ...(replyInThread ? { replyToMessageId: "om_received_sticker", replyInThread } : {}),
        });
        expect(result.messageId).toBe(replyInThread ? "om_sticker_reply" : "om_sticker_sent");
        expect(result.receipt.parts).toEqual([expect.objectContaining({ kind: "media" })]);
      }
      expect(requests.filter((request) => request.messageType === "sticker")).toEqual([
        {
          method: "POST",
          path: "/open-apis/im/v1/messages",
          authorization: "Bearer tat-feishu-content-107947",
          messageType: "sticker",
          content: JSON.stringify({ file_key: "file_sticker_received" }),
          receiveId: "oc_feishu_content_107947",
        },
        {
          method: "POST",
          path: "/open-apis/im/v1/messages/om_received_sticker/reply",
          authorization: "Bearer tat-feishu-content-107947",
          messageType: "sticker",
          content: JSON.stringify({ file_key: "file_sticker_received" }),
          replyInThread: true,
        },
      ]);
      const createsBeforeWithdrawnReply = requests.filter(
        (request) => request.path === "/open-apis/im/v1/messages",
      ).length;
      await expect(
        sendStickerFeishu({
          cfg,
          to: "chat:oc_feishu_content_107947",
          fileKey: "file_sticker_received",
          replyToMessageId: "om_withdrawn_sticker",
          replyInThread: true,
        }),
      ).rejects.toThrow("cannot safely fall back to a top-level send");
      expect(
        requests.filter((request) => request.path === "/open-apis/im/v1/messages"),
      ).toHaveLength(createsBeforeWithdrawnReply);
    } finally {
      Lark.defaultHttpInstance.interceptors.request.eject(loopbackInterceptor);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
