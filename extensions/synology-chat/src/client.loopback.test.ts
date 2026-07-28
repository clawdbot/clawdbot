import { once } from "node:events";
import * as http from "node:http";
import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synologyChatPlugin } from "./channel.js";
import { resolveLegacyWebhookNameToChatUserId, sendMessage } from "./client.js";
import type { SynologyInboundMessage } from "./inbound-context.js";
import { dispatchSynologyChatInboundEvent } from "./inbound-event.js";
import { setSynologyRuntime } from "./runtime.js";

const USER_LIST_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

describe("Synology Chat user_list loopback", () => {
  let server: http.Server | undefined;

  async function listenLoopback(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
        server?.closeAllConnections?.();
      });
      server = undefined;
    }
  });

  const chunkingCases = [
    { name: "long unbroken text", text: "x".repeat(4_501), requests: 3, joiner: "" },
    { name: "Unicode surrogate pairs", text: "😀".repeat(1_201), requests: 2, joiner: "" },
    {
      name: "Markdown and newline boundaries",
      text: "Read [the documentation](https://example.com/guide).\n".repeat(90).trim(),
      requests: 3,
      joiner: " ",
    },
    { name: "short messages", text: "A short 😀 message.", requests: 1, joiner: "" },
  ];

  it.each(
    chunkingCases.flatMap((entry) => [
      { ...entry, delivery: "outbound" as const },
      { ...entry, delivery: "inbound reply" as const },
    ]),
  )(
    "delivers $name via $delivery within the Synology Chat payload limit",
    async ({ text, requests, joiner, delivery }) => {
      const receivedTexts: string[] = [];
      const port = await listenLoopback((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          const rawPayload = new URLSearchParams(body).get("payload");
          const payload = JSON.parse(rawPayload ?? "{}") as {
            text?: string;
            user_ids?: number[];
          };
          const receivedText = payload.text ?? "";
          receivedTexts.push(receivedText);
          res.writeHead(200, { "Content-Type": "application/json" });
          if (receivedText.length > 2_000) {
            res.end(
              JSON.stringify({ success: false, error: { code: 410, errors: "msg too long" } }),
            );
            return;
          }
          res.end(JSON.stringify({ success: true }));
        });
      });
      const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
      const cfg = {
        channels: {
          "synology-chat": {
            enabled: true,
            token: "loopback-token",
            incomingUrl,
          },
        },
      };

      if (delivery === "outbound") {
        const result = await sendTextMediaPayload({
          channel: "synology-chat",
          ctx: { cfg, to: "42", payload: { text } },
          adapter: synologyChatPlugin.outbound,
        });
        expect(result.channel).toBe("synology-chat");
      } else {
        const inboundRun = vi.fn(
          async (params: {
            raw: SynologyInboundMessage;
            adapter: {
              ingest: (raw: SynologyInboundMessage) => unknown;
              resolveTurn: (
                input: unknown,
                admission: { kind: "message"; canStartAgentTurn: true },
              ) => Promise<{
                delivery: { deliver: (payload: { text: string }) => Promise<unknown> };
              }>;
            };
          }) => {
            const input = params.adapter.ingest(params.raw);
            const resolved = await params.adapter.resolveTurn(input, {
              kind: "message",
              canStartAgentTurn: true,
            });
            return await resolved.delivery.deliver({ text });
          },
        );
        setSynologyRuntime({
          config: { current: () => cfg },
          channel: {
            routing: {
              resolveAgentRoute: () => ({
                agentId: "main",
                accountId: "default",
                sessionKey: "agent:main:synology-chat:default:direct:42",
              }),
            },
            inbound: {
              run: inboundRun,
              buildContext: (context: unknown) => context,
            },
          },
        } as unknown as Parameters<typeof setSynologyRuntime>[0]);
        const account = synologyChatPlugin.config.resolveAccount(cfg, "default");
        await dispatchSynologyChatInboundEvent({
          account,
          msg: {
            body: "Trigger the reply",
            from: "42",
            chatUserId: "42",
            senderName: "Loopback User",
            provider: "synology-chat",
            chatType: "direct",
            accountId: "default",
            commandAuthorized: true,
          },
        });
        expect(inboundRun).toHaveBeenCalledOnce();
      }

      expect(receivedTexts).toHaveLength(requests);
      for (const receivedText of receivedTexts) {
        expect(receivedText.length).toBeLessThanOrEqual(2_000);
        expect(receivedText).not.toMatch(/\p{Surrogate}/u);
      }

      const expectedWireText =
        delivery === "outbound"
          ? text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
          : text;
      expect(receivedTexts.join(joiner).replace(/\s+/g, " ")).toBe(
        expectedWireText.replace(/\s+/g, " "),
      );
    },
  );

  it("aborts a streamed overflow and returns the stale cached identity", async () => {
    let requestCount = 0;
    const port = await listenLoopback((_req, res) => {
      requestCount += 1;
      res.on("error", () => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      if (requestCount === 1) {
        res.end(
          JSON.stringify({
            success: true,
            data: { users: [{ user_id: 17, username: "cached", nickname: "cached-user" }] },
          }),
        );
        return;
      }
      res.write(Buffer.alloc(USER_LIST_RESPONSE_MAX_BYTES, 0x78));
      res.end(Buffer.from("x"));
    });
    const incomingUrl =
      `http://127.0.0.1:${port}/webapi/entry.cgi?` +
      "api=SYNO.Chat.External&method=chatbot&version=2";
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_700_000_000_000);

    await expect(
      resolveLegacyWebhookNameToChatUserId({
        incomingUrl,
        mutableWebhookUsername: "cached-user",
      }),
    ).resolves.toBe(17);

    now.mockReturnValue(1_700_000_000_000 + 10 * 60 * 1000);
    const warnings: string[] = [];
    await expect(
      resolveLegacyWebhookNameToChatUserId({
        incomingUrl,
        mutableWebhookUsername: "cached-user",
        log: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
      }),
    ).resolves.toBe(17);

    expect(requestCount).toBe(2);
    expect(warnings).toContain(
      `fetchChatUsers: user_list response exceeded ${USER_LIST_RESPONSE_MAX_BYTES} bytes, using cached data`,
    );
  });

  it("bounds a dripping user_list body with a wall-clock deadline", async () => {
    let requestCount = 0;
    const port = await listenLoopback((_req, res) => {
      requestCount += 1;
      res.on("error", () => {});
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      });
      if (requestCount === 1) {
        res.end(
          JSON.stringify({
            success: true,
            data: { users: [{ user_id: 21, username: "cached", nickname: "drip-user" }] },
          }),
        );
        return;
      }
      // Keep sending bytes so ClientRequest socket-idle alone would never fire.
      const dripTimer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write("x");
      }, 20);
      res.on("close", () => clearInterval(dripTimer));
      res.write("x");
    });
    const incomingUrl =
      `http://127.0.0.1:${port}/webapi/entry.cgi?` +
      "api=SYNO.Chat.External&method=chatbot&version=2";
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_700_000_100_000);

    await expect(
      resolveLegacyWebhookNameToChatUserId({
        incomingUrl,
        mutableWebhookUsername: "drip-user",
      }),
    ).resolves.toBe(21);

    now.mockReturnValue(1_700_000_100_000 + 10 * 60 * 1000);
    const warnings: string[] = [];
    const timeoutMs = 250;
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    timeoutSpy.mockImplementationOnce(((
      callback: (...args: unknown[]) => void,
      _delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, timeoutMs, ...args)) as typeof setTimeout);
    const startedAt = performance.now();
    await expect(
      resolveLegacyWebhookNameToChatUserId({
        incomingUrl,
        mutableWebhookUsername: "drip-user",
        log: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
      }),
    ).resolves.toBe(21);
    const elapsedMs = performance.now() - startedAt;

    expect(requestCount).toBe(2);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(warnings).toContain("fetchChatUsers: request timed out, using cached data");
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
  });

  it("bounds a dripping chatbot response with a wall-clock deadline", async () => {
    let requestCount = 0;
    const port = await listenLoopback((_req, res) => {
      requestCount += 1;
      res.on("error", () => {});
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      });
      const dripTimer = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write("x");
        }
      }, 20);
      res.on("close", () => clearInterval(dripTimer));
      res.write("x");
    });
    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
    const timeoutMs = 250;
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    timeoutSpy.mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      nativeSetTimeout(
        callback,
        delay === 30_000 ? timeoutMs : delay,
        ...args,
      )) as typeof setTimeout);

    const startedAt = performance.now();
    await expect(sendMessage(incomingUrl, "hello")).resolves.toBe(false);
    const elapsedMs = performance.now() - startedAt;

    expect(requestCount).toBe(3);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs * 3 - 100);
    expect(elapsedMs).toBeLessThan(3_500);
  });
});
