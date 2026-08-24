// Prove configured Zalo delivery against the actual Bot API HTTP boundary.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";

type RecordedZaloRequest = {
  body: Record<string, unknown>;
  method: string;
};

const originalZaloApiUrl = process.env.ZALO_API_URL;
const cfg = {
  channels: {
    zalo: {
      accounts: {
        default: {
          botToken: "test-bot-token",
        },
      },
    },
  },
} as OpenClawConfig;

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback Zalo Bot API address");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("configured Zalo outbound target delivery", () => {
  let server: Server;
  let requests: RecordedZaloRequest[];

  beforeEach(async () => {
    requests = [];
    server = createServer((request, response) => {
      void (async () => {
        const method = request.url?.match(/\/bot[^/]+\/([^/?]+)/u)?.[1] ?? "unknown";
        const body = await readJsonBody(request);
        requests.push({ body, method });

        const chatId = typeof body.chat_id === "string" ? body.chat_id : "";
        const isBareChatId = Boolean(chatId) && !/^(?:zalo|zl|group|user|dm):/iu.test(chatId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            isBareChatId
              ? {
                  ok: true,
                  result: {
                    message_id: `${method}-delivered`,
                  },
                }
              : {
                  ok: false,
                  error_code: 400,
                  description: "chat_id must be a bare Zalo conversation ID",
                },
          ),
        );
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, description: String(error) }));
      });
    });
    process.env.ZALO_API_URL = await listen(server);
  });

  afterEach(async () => {
    if (originalZaloApiUrl === undefined) {
      delete process.env.ZALO_API_URL;
    } else {
      process.env.ZALO_API_URL = originalZaloApiUrl;
    }
    await close(server);
  });

  it.each([
    { target: "zalo:group:group-123", peer: "group-123", kind: "text" },
    { target: "zl:user:direct-456", peer: "direct-456", kind: "text" },
    { target: "group:group-789", peer: "group-789", kind: "media" },
    { target: "zalo:dm:direct-987", peer: "direct-987", kind: "media" },
  ] as const)(
    "sends $kind to the same bare peer selected by the session route ($target)",
    async ({ target, peer, kind }) => {
      const route = await zaloPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg,
        agentId: "main",
        accountId: "default",
        target,
      });
      expect(route?.peer.id).toBe(peer);

      if (kind === "text") {
        const sendText = zaloPlugin.outbound?.sendText;
        if (!sendText) {
          throw new Error("expected configured Zalo outbound text adapter");
        }
        const result = await sendText({ cfg, to: target, text: "proof" });
        expect(result.messageId).toBe("sendMessage-delivered");
        expect(requests).toEqual([
          {
            method: "sendMessage",
            body: { chat_id: peer, text: "proof" },
          },
        ]);
        return;
      }

      const sendMedia = zaloPlugin.outbound?.sendMedia;
      if (!sendMedia) {
        throw new Error("expected configured Zalo outbound media adapter");
      }
      const mediaUrl = "https://93.184.216.34/proof.png";
      const result = await sendMedia({ cfg, to: target, text: "proof", mediaUrl });
      expect(result.messageId).toBe("sendPhoto-delivered");
      expect(requests).toEqual([
        {
          method: "sendPhoto",
          body: { chat_id: peer, photo: mediaUrl, caption: "proof" },
        },
      ]);
    },
  );
});
