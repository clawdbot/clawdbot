// Prove Feishu DM routing against the real SDK, token exchange, and HTTP transport.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { sendMediaFeishu } from "./media.js";
import { feishuOutbound } from "./outbound.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

type RecordedFeishuRequest = {
  method: string;
  path: string;
  receiveIdType?: string;
  receiveId?: string;
  messageType?: string;
  appId?: string;
  authorization?: string;
  replyInThread?: boolean;
  content?: string;
  platformMessageId?: string;
};

describe("Feishu DM delivery over the real Lark SDK", () => {
  it("preserves routing, card byte envelopes and physical-send receipts", async () => {
    const requests: RecordedFeishuRequest[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }

        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const path = url.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const isJson = (request.headers["content-type"] ?? "").includes("application/json");
        const body = isJson && rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const record: RecordedFeishuRequest = {
          method: request.method ?? "",
          path,
          ...(url.searchParams.get("receive_id_type")
            ? { receiveIdType: url.searchParams.get("receive_id_type") ?? undefined }
            : {}),
          ...(typeof body.receive_id === "string" ? { receiveId: body.receive_id } : {}),
          ...(typeof body.msg_type === "string" ? { messageType: body.msg_type } : {}),
          ...(typeof body.app_id === "string" ? { appId: body.app_id } : {}),
          ...(typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {}),
          ...(body.reply_in_thread === true ? { replyInThread: true } : {}),
          ...(typeof body.content === "string" ? { content: body.content } : {}),
        };
        requests.push(record);

        const sendJson = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };

        if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
          if (body.app_id !== "cli_dm_primary" && body.app_id !== "cli_dm_secondary") {
            sendJson(401, { code: 99991663, msg: "unknown loopback test application" });
            return;
          }
          sendJson(200, {
            code: 0,
            msg: "ok",
            tenant_access_token: body.app_id === "cli_dm_primary" ? "tat-primary" : "tat-secondary",
            expire: 7200,
          });
          return;
        }

        if (
          record.authorization !== "Bearer tat-primary" &&
          record.authorization !== "Bearer tat-secondary"
        ) {
          sendJson(401, { code: 99991663, msg: "missing account-scoped tenant token" });
          return;
        }

        if (path === "/open-apis/im/v1/images") {
          sendJson(200, { code: 0, msg: "success", data: { image_key: "img_dm_loopback" } });
          return;
        }

        if (
          path === "/open-apis/im/v1/messages/om_dm_thread_root/reply" ||
          path === "/open-apis/im/v1/messages/om_card_split_root/reply"
        ) {
          record.platformMessageId = path.includes("om_dm_thread_root")
            ? "om_dm_thread_reply"
            : `om_dm_loopback_${requests.length}`;
          sendJson(200, {
            code: 0,
            msg: "success",
            data: { message_id: record.platformMessageId },
          });
          return;
        }

        if (path !== "/open-apis/im/v1/messages") {
          sendJson(404, { code: 404, msg: "unexpected loopback request" });
          return;
        }

        if (body.receive_id === "ou_dm_unavailable") {
          sendJson(400, {
            code: 230101,
            msg: "Sending messages to users is temporarily unavailable.",
          });
          return;
        }

        if (body.receive_id === "ou_dm_forbidden") {
          sendJson(400, { code: 230027, msg: "Lack of necessary permissions." });
          return;
        }

        if (
          body.receive_id === "oc_card_partial" &&
          requests.filter((entry) => entry.receiveId === body.receive_id).length === 3
        ) {
          sendJson(400, { code: 230027, msg: "Lack of necessary permissions." });
          return;
        }

        record.platformMessageId = `om_dm_loopback_${requests.length}`;
        sendJson(200, {
          code: 0,
          msg: "success",
          data: { message_id: record.platformMessageId },
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
    // Keep the production Feishu domain: the SDK treats a :port in a custom
    // base URL as an API path parameter. The real Axios request interceptor
    // redirects both its token POST and authenticated message transport.
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
      const cfg = {
        channels: {
          feishu: {
            enabled: true,
            appId: "cli_dm_primary",
            appSecret: "loopback-placeholder", // pragma: allowlist secret
            domain: "feishu",
            accounts: {
              secondary: {
                appId: "cli_dm_secondary",
                appSecret: "loopback-placeholder", // pragma: allowlist secret
                domain: "feishu",
              },
            },
          },
        },
      } as ClawdbotConfig;

      await expect(
        sendMessageFeishu({ cfg, to: "user:ou_dm_unavailable", text: "old DM target" }),
      ).rejects.toThrow(/230101|temporarily unavailable/);

      await expect(
        sendMessageFeishu({ cfg, to: "chat:oc_dm_conversation", text: "delivered DM" }),
      ).resolves.toMatchObject({ chatId: "oc_dm_conversation" });

      await expect(
        sendCardFeishu({
          cfg,
          to: "chat:oc_dm_conversation",
          card: { elements: [{ tag: "markdown", content: "delivered DM card" }] },
        }),
      ).resolves.toMatchObject({ chatId: "oc_dm_conversation" });

      await expect(
        sendMediaFeishu({
          cfg,
          to: "chat:oc_dm_conversation",
          mediaBuffer: Buffer.from(
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
            "hex",
          ),
          fileName: "loopback.png",
        }),
      ).resolves.toMatchObject({ chatId: "oc_dm_conversation" });

      await expect(
        sendMessageFeishu({ cfg, to: "chat:oc_group_conversation", text: "group control" }),
      ).resolves.toMatchObject({ chatId: "oc_group_conversation" });

      await expect(
        sendMessageFeishu({
          cfg,
          to: "chat:oc_dm_conversation",
          text: "thread control",
          replyToMessageId: "om_dm_thread_root",
          replyInThread: true,
        }),
      ).resolves.toMatchObject({ messageId: "om_dm_thread_reply" });

      await expect(
        sendMessageFeishu({
          cfg,
          to: "chat:oc_secondary_conversation",
          text: "secondary account control",
          accountId: "secondary",
        }),
      ).resolves.toMatchObject({ chatId: "oc_secondary_conversation" });

      await expect(
        sendMessageFeishu({ cfg, to: "user:ou_dm_allowed", text: "proactive control" }),
      ).resolves.toMatchObject({ chatId: "ou_dm_allowed" });

      await expect(
        sendMessageFeishu({ cfg, to: "user:ou_dm_forbidden", text: "permission control" }),
      ).rejects.toThrow(/230027|necessary permissions/);

      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/open-apis/auth/v3/tenant_access_token/internal",
            appId: "cli_dm_primary",
          }),
          expect.objectContaining({
            path: "/open-apis/auth/v3/tenant_access_token/internal",
            appId: "cli_dm_secondary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "open_id",
            receiveId: "ou_dm_unavailable",
            authorization: "Bearer tat-primary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_dm_conversation",
            messageType: "post",
            authorization: "Bearer tat-primary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_dm_conversation",
            messageType: "interactive",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/images",
            authorization: "Bearer tat-primary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_dm_conversation",
            messageType: "image",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_group_conversation",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages/om_dm_thread_root/reply",
            replyInThread: true,
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_secondary_conversation",
            authorization: "Bearer tat-secondary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "open_id",
            receiveId: "ou_dm_allowed",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "open_id",
            receiveId: "ou_dm_forbidden",
          }),
        ]),
      );

      const sendText = feishuOutbound.sendText!;
      for (const fixture of [
        { name: "default limit", body: "漢".repeat(11_000), limit: 4_000, header: "Header" },
        { name: "UTF-8 bytes", body: "漢".repeat(11_000), limit: 25_000, header: "Header" },
        { name: "JSON escapes", body: '"\\'.repeat(8_000), limit: 25_000, header: "Header" },
        {
          name: "header and fence overhead",
          body: "x".repeat(24_576),
          limit: 25_000,
          header: "界".repeat(2_000),
        },
      ]) {
        for (const thread of [false, true]) {
          const before = requests.length;
          const deliveries: string[] = [];
          const result = await sendText({
            cfg: {
              ...cfg,
              channels: { feishu: { ...cfg.channels!.feishu, textChunkLimit: fixture.limit } },
            },
            to: "chat:oc_dm_conversation",
            text: `\`\`\`text\n${fixture.body}\n\`\`\``,
            identity: { name: fixture.header },
            ...(thread ? { threadId: "om_card_split_root" } : {}),
            onDeliveryResult: (delivery) => {
              deliveries.push(delivery.messageId);
            },
          });
          const sent = requests.slice(before).filter((request) => request.messageType);
          expect
            .soft(sent.length, `${fixture.name}: split direct card, thread=${thread}`)
            .toBeGreaterThan(1);
          const bodies: string[] = [];
          for (const request of sent) {
            expect(request.messageType).toBe("interactive");
            expect(request.path).toBe(
              thread
                ? "/open-apis/im/v1/messages/om_card_split_root/reply"
                : "/open-apis/im/v1/messages",
            );
            expect(request.replyInThread).toBe(thread ? true : undefined);
            expect
              .soft(Buffer.byteLength(request.content!, "utf8"), fixture.name)
              .toBeLessThanOrEqual(30 * 1024);
            const card = JSON.parse(request.content!) as {
              header: { title: { content: string } };
              body: { elements: Array<{ tag: string; content: string }> };
            };
            expect(card.header.title.content).toBe(fixture.header);
            const markdown = card.body.elements[0]?.content;
            if (markdown === undefined) {
              throw new Error("Expected a Markdown card body");
            }
            expect(markdown.startsWith("```text\n")).toBe(true);
            expect(markdown.endsWith("\n```")).toBe(true);
            bodies.push(markdown.slice(8, -4));
          }
          expect(bodies.join("")).toBe(fixture.body);
          expect(deliveries).toEqual(sent.map((request) => request.platformMessageId));
          expect.soft(result.receipt?.platformMessageIds, fixture.name).toEqual(deliveries);
          expect(result.messageId).toBe(deliveries.at(-1));
          expect(result.receipt?.primaryPlatformMessageId).toBe(result.messageId);
        }
      }

      const postStart = requests.length;
      const post = await sendText({
        cfg,
        to: "chat:oc_dm_conversation",
        text: "漢".repeat(11_000),
      });
      const postIds = requests
        .slice(postStart)
        .flatMap((request) => request.platformMessageId ?? []);
      expect(postIds.length).toBeGreaterThan(1);
      expect
        .soft(post.receipt?.platformMessageIds, "logical post receipt contains every physical send")
        .toEqual(postIds);

      const partialStart = requests.length;
      let partialError: unknown;
      try {
        await sendText({
          cfg: { ...cfg, channels: { feishu: { ...cfg.channels!.feishu, textChunkLimit: 10 } } },
          to: "chat:oc_card_partial",
          text: "abcdefghij".repeat(3),
        });
      } catch (error) {
        partialError = error;
      }
      const acceptedIds = requests
        .slice(partialStart)
        .flatMap((request) => request.platformMessageId ?? []);
      expect(acceptedIds).toHaveLength(2);
      expect
        .soft(
          isChannelPartialDeliveryError(partialError),
          "later rejection preserves accepted chunks",
        )
        .toBe(true);
      if (isChannelPartialDeliveryError(partialError)) {
        expect(partialError.deliveryResult.visibleReplySent).toBe(true);
        expect(partialError.deliveryResult.messageIds).toEqual(acceptedIds);
      }

      const callbackStart = requests.length;
      let callbackError: unknown;
      let callbacks = 0;
      try {
        await sendText({
          cfg,
          to: "chat:oc_dm_conversation",
          text: "漢".repeat(11_000),
          onDeliveryResult: () => {
            if (++callbacks === 2) {
              throw new Error("recording failed");
            }
          },
        });
      } catch (error) {
        callbackError = error;
      }
      const callbackIds = requests
        .slice(callbackStart)
        .flatMap((request) => request.platformMessageId ?? []);
      expect(callbacks).toBe(2);
      expect(callbackIds).toHaveLength(2);
      expect(isChannelPartialDeliveryError(callbackError)).toBe(true);
      if (isChannelPartialDeliveryError(callbackError)) {
        expect(callbackError.deliveryResult.messageIds).toEqual(callbackIds);
      }
    } finally {
      Lark.defaultHttpInstance.interceptors.request.eject(loopbackInterceptor);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
