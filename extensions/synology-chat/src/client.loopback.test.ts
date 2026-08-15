import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synologyChatPlugin } from "./channel.js";
import { resolveLegacyWebhookNameToChatUserId, sendMessage } from "./client.js";

const { hostedCapabilityUrl, hostedCapabilityCleanup } = vi.hoisted(() => ({
  hostedCapabilityUrl:
    "https://gateway.example.com/webhook/synology?__openclaw_synology_media_token_aaaaaaaaaaaaaaaaaaaaaaaa=secret",
  hostedCapabilityCleanup: vi.fn(async () => undefined),
}));
vi.mock("./outbound-media.js", () => ({
  prepareSynologyHostedMedia: vi.fn(async () => ({
    url: hostedCapabilityUrl,
    cleanup: hostedCapabilityCleanup,
  })),
  resolveSynologyHostedMediaRoute: vi.fn(),
}));

const USER_LIST_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

describe("Synology Chat client loopback", () => {
  let server: http.Server | undefined;

  async function listenLoopback(handler: http.RequestListener, port = 0): Promise<number> {
    server = http.createServer(handler);
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  async function reserveLoopbackPort(): Promise<number> {
    const reservation = http.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") {
      throw new Error("expected reserved loopback address");
    }
    await new Promise<void>((resolve, reject) => {
      reservation.close((err) => (err ? reject(err) : resolve()));
    });
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

  it("retries once when a real connection refusal occurs before the listener starts", async () => {
    const port = await reserveLoopbackPort();
    const nativeSetTimeout = globalThis.setTimeout;
    let releaseRetry: (() => void) | undefined;
    let markRetryScheduled!: () => void;
    const retryScheduled = new Promise<void>((resolve) => {
      markRetryScheduled = resolve;
    });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    timeoutSpy.mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 300 && releaseRetry === undefined) {
        const heldTimer = nativeSetTimeout(() => {}, 10_000);
        heldTimer.unref?.();
        releaseRetry = () => {
          clearTimeout(heldTimer);
          callback(...args);
        };
        markRetryScheduled();
        return heldTimer;
      }
      return nativeSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);

    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
    const send = sendMessage(incomingUrl, "retry after refusal");
    const firstOutcome = await Promise.race([
      retryScheduled.then(() => "retry-scheduled" as const),
      send.then((sendResult) => ({ sendResult })),
    ]);
    expect(firstOutcome).toBe("retry-scheduled");

    let receivedRequests = 0;
    await listenLoopback((req, res) => {
      receivedRequests += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    }, port);
    if (!releaseRetry) {
      throw new Error("expected pre-connect retry backoff");
    }
    releaseRetry();

    await expect(send).resolves.toBe(true);
    expect(receivedRequests).toBe(1);
    expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 300)).toHaveLength(1);
    console.log(
      `[synology webhook retry proof] preconnect_refusal=true retry_scheduled=true server_received=${receivedRequests} outcome=success`,
    );
  });

  it("does not replay after the server receives the upload and disconnects", async () => {
    let requestCount = 0;
    let uploadedBody = "";
    const port = await listenLoopback((req, res) => {
      requestCount += 1;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        uploadedBody += chunk;
      });
      req.on("end", () => {
        res.destroy();
      });
    });
    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;

    await expect(sendMessage(incomingUrl, "post-upload disconnect")).resolves.toBe(false);

    expect(requestCount).toBe(1);
    expect(new URLSearchParams(uploadedBody).get("payload")).toBe(
      JSON.stringify({ text: "post-upload disconnect" }),
    );
    console.log(
      `[synology webhook retry proof] server_received=${requestCount} disconnect_after_upload=true replayed=${requestCount > 1} outcome=not_sent`,
    );
  });

  it("acquires durable send custody before webhook bytes cross the loopback boundary", async () => {
    const receivedPayloads: Array<Record<string, unknown>> = [];
    const port = await listenLoopback((req, res) => {
      let formBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        formBody += chunk;
      });
      req.on("end", () => {
        const payload = new URLSearchParams(formBody).get("payload");
        if (payload) {
          receivedPayloads.push(JSON.parse(payload) as Record<string, unknown>);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    });
    const incomingUrl = `http://127.0.0.1:${port}/webapi/entry.cgi`;
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          token: "synology-custody-proof",
          incomingUrl,
        },
      },
    };
    const marker = `autoqa-synology-custody-${randomUUID()}`;
    const custodyFailure = new Error(`fault-injected custody failure: ${marker}`);
    const rejectedDispatch = vi.fn(async () => {
      throw custodyFailure;
    });

    await expect(
      synologyChatPlugin.message.send?.text?.({
        cfg,
        text: marker,
        to: "42",
        onPlatformSendDispatch: rejectedDispatch,
      }),
    ).rejects.toThrow(custodyFailure.message);
    expect(rejectedDispatch).toHaveBeenCalledOnce();
    expect(receivedPayloads).toEqual([]);

    const acceptedDispatch = vi.fn(async () => undefined);
    await synologyChatPlugin.message.send?.text?.({
      cfg,
      text: marker,
      to: "42",
      onPlatformSendDispatch: acceptedDispatch,
    });
    expect(acceptedDispatch).toHaveBeenCalledOnce();
    expect(receivedPayloads).toEqual([{ text: marker, user_ids: [42] }]);

    const rejectedMediaDispatch = vi.fn(async () => {
      throw custodyFailure;
    });
    hostedCapabilityCleanup.mockClear();
    await expect(
      synologyChatPlugin.message.send?.media?.({
        cfg,
        text: marker,
        mediaUrl: "https://example.com/custody-proof.png",
        to: "42",
        onPlatformSendDispatch: rejectedMediaDispatch,
      }),
    ).rejects.toThrow(custodyFailure.message);
    expect(rejectedMediaDispatch).toHaveBeenCalledOnce();
    expect(hostedCapabilityCleanup).toHaveBeenCalledOnce();
    expect(receivedPayloads).toHaveLength(1);
  });

  it("delivers authenticated text and media without inventing platform message ids", async () => {
    const receivedPayloads: Array<Record<string, unknown>> = [];
    const port = await listenLoopback((req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        req.method !== "POST" ||
        requestUrl.pathname !== "/webapi/entry.cgi" ||
        requestUrl.searchParams.get("api") !== "SYNO.Chat.External" ||
        requestUrl.searchParams.get("method") !== "chatbot" ||
        requestUrl.searchParams.get("version") !== "2" ||
        requestUrl.searchParams.get("token") !== "synology-loopback-proof"
      ) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false }));
        return;
      }

      let formBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        formBody += chunk;
      });
      req.on("end", () => {
        const payload = new URLSearchParams(formBody).get("payload");
        if (!payload) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false }));
          return;
        }
        receivedPayloads.push(JSON.parse(payload) as Record<string, unknown>);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    });
    const incomingUrl =
      `http://127.0.0.1:${port}/webapi/entry.cgi?` +
      "api=SYNO.Chat.External&method=chatbot&version=2&token=synology-loopback-proof";
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          token: "synology-loopback-proof",
          incomingUrl,
        },
      },
    };
    const mediaUrl = "https://example.com/synology-receipt-proof.png";

    const outboundText = await synologyChatPlugin.outbound.sendText({
      cfg,
      text: "native outbound text",
      to: "42",
    });
    const outboundMedia = await synologyChatPlugin.outbound.sendMedia({
      cfg,
      mediaUrl,
      to: "42",
    });
    const durableText = await synologyChatPlugin.message.send?.text?.({
      cfg,
      text: "durable adapter text",
      to: "42",
    });
    const durableMedia = await synologyChatPlugin.message.send?.media?.({
      cfg,
      text: "durable adapter media",
      mediaUrl,
      to: "42",
    });

    expect(receivedPayloads).toEqual([
      { text: "native outbound text", user_ids: [42] },
      { file_url: hostedCapabilityUrl, user_ids: [42] },
      { text: "durable adapter text", user_ids: [42] },
      { file_url: hostedCapabilityUrl, user_ids: [42] },
    ]);
    expect(durableText).toBeDefined();
    expect(durableMedia).toBeDefined();
    for (const result of [outboundText, outboundMedia, durableText, durableMedia]) {
      expect(result).toMatchObject({
        channel: "synology-chat",
        messageId: "",
        chatId: "42",
        receipt: {
          platformMessageIds: [],
          parts: [],
          threadId: "42",
        },
      });
      expect(result?.receipt.primaryPlatformMessageId).toBeUndefined();
    }
  });

  it("chunks long text before the Synology payload limit for every text adapter", async () => {
    const receivedPayloads: Array<{ text: string; user_ids?: number[] }> = [];
    const port = await listenLoopback((req, res) => {
      let formBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        formBody += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(new URLSearchParams(formBody).get("payload") ?? "{}") as {
          text?: string;
          user_ids?: number[];
        };
        receivedPayloads.push({ text: payload.text ?? "", user_ids: payload.user_ids });
        const accepted = (payload.text?.length ?? 0) <= 2_000;
        res.writeHead(accepted ? 200 : 413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: accepted }));
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
    const text = "x".repeat(2_001);

    await synologyChatPlugin.outbound.sendText({ cfg, text, to: "42" });
    await synologyChatPlugin.message.send?.text?.({ cfg, text, to: "42" });
    await sendMessage(incomingUrl, text, "42");

    expect(receivedPayloads).toHaveLength(6);
    expect(receivedPayloads.map(({ text: chunk }) => chunk).join("")).toBe(text + text + text);
    expect(receivedPayloads.every(({ text: chunk }) => chunk.length <= 2_000)).toBe(true);
    expect(receivedPayloads.every(({ user_ids }) => user_ids?.[0] === 42)).toBe(true);
  });

  it("rejects unauthenticated webhook sends without fabricating delivery receipts", async () => {
    let rejectedRequests = 0;
    const port = await listenLoopback((_req, res) => {
      rejectedRequests += 1;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false }));
    });
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          token: "synology-loopback-rejected",
          incomingUrl:
            `http://127.0.0.1:${port}/webapi/entry.cgi?` +
            "api=SYNO.Chat.External&method=chatbot&version=2&token=synology-loopback-rejected",
        },
      },
    };

    await expect(
      synologyChatPlugin.outbound.sendText({ cfg, text: "rejected", to: "42" }),
    ).rejects.toThrow("Failed to send message to Synology Chat");
    expect(rejectedRequests).toBe(1);

    await expect(
      synologyChatPlugin.outbound.sendMedia({
        cfg,
        mediaUrl: "https://example.com/synology-receipt-proof.png",
        to: "42",
      }),
    ).rejects.toThrow("rejected the attachment request");
    expect(rejectedRequests).toBe(2);
  });

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

  it("does not replay a code-less wall-clock timeout from a dripping chatbot response", async () => {
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

    expect(requestCount).toBe(1);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
  });
});
