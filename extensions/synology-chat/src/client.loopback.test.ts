import { once } from "node:events";
import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLegacyWebhookNameToChatUserId, sendMessage } from "./client.js";

const USER_LIST_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

describe("Synology Chat user_list loopback", () => {
  let server: http.Server | undefined;

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

  it("aborts a streamed overflow and returns the stale cached identity", async () => {
    let requestCount = 0;
    server = http.createServer((_req, res) => {
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
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const incomingUrl =
      `http://127.0.0.1:${address.port}/webapi/entry.cgi?` +
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
    server = http.createServer((_req, res) => {
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
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const incomingUrl =
      `http://127.0.0.1:${address.port}/webapi/entry.cgi?` +
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
    server = http.createServer((_req, res) => {
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
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const incomingUrl = `http://127.0.0.1:${address.port}/webapi/entry.cgi`;
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
