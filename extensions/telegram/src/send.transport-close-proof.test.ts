// E2E proof for the transport cache-eviction lifecycle: no module mocks — real
// grammY Bot, real undici agents, and the shared cache against a local HTTP
// server standing in for the Telegram Bot API. Observes actual TCP sockets.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let sendMessageTelegram: typeof import("./send.js").sendMessageTelegram;
let resetTelegramClientOptionsCacheForTests: typeof import("./send.js").resetTelegramClientOptionsCacheForTests;

describe("telegram transport cache eviction over real sockets", () => {
  let server: Server;
  let apiRoot: string;
  const liveSockets = new Set<Socket>();
  const requestSockets = new Map<string, Socket>();
  let sendMessageCalls = 0;
  let slowResponse: ReturnType<typeof createDeferred<() => void>> | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.on("end", () => {
        const url = req.url ?? "";
        const respond = (result: unknown) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (url.includes("/sendMessage")) {
          requestSockets.set(url, req.socket);
          sendMessageCalls += 1;
          if (slowResponse) {
            slowResponse.resolve(() => {
              respond({ message_id: sendMessageCalls, chat: { id: 123 } });
            });
            return;
          }
          respond({ message_id: sendMessageCalls, chat: { id: 123 } });
          return;
        }
        if (url.includes("/getChat")) {
          respond({ id: 123, type: "private" });
          return;
        }
        respond(true);
      });
      req.resume();
    });
    // Omit the peer idle deadline so the unchanged client 30s idle policy cannot
    // satisfy the 3s eviction checks. Idle peer closure is injected explicitly below.
    server.keepAliveTimeout = 0;
    server.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.on("close", () => liveSockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ sendMessageTelegram, resetTelegramClientOptionsCacheForTests } = await import("./send.js"));
  });

  afterAll(async () => {
    resetTelegramClientOptionsCacheForTests();
    vi.unstubAllEnvs();
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("closes retired transports only after their active sends finish", async () => {
    resetTelegramClientOptionsCacheForTests();

    const ACCOUNTS = 70;
    const cfg = {
      channels: {
        telegram: {
          accounts: Object.fromEntries(
            Array.from({ length: ACCOUNTS }, (_, i) => [
              `acct-${i}`,
              { botToken: `10${i}:e2e-token-${i}`, apiRoot },
            ]),
          ),
        },
      },
    };
    const socketForAccount = (account: number) => {
      const socket = requestSockets.get(`/bot10${account}:e2e-token-${account}/sendMessage`);
      if (!socket) {
        throw new Error(`Telegram socket for acct-${account} was not captured`);
      }
      return socket;
    };
    const send = async (account: number, text: string) => {
      const result = await sendMessageTelegram("123", text, { cfg, accountId: `acct-${account}` });
      expect(result.messageId).toBeTruthy();
      return socketForAccount(account);
    };

    // Fill the cache to its 64-entry cap, then let the peer retire an idle socket.
    for (let i = 0; i < 64; i += 1) {
      await send(i, `hello ${i}`);
    }
    expect(requestSockets.size).toBe(64);
    const peerSocket = await send(0, "refresh before peer close");
    const peerClosed = new Promise<void>((resolve) => {
      peerSocket.once("close", resolve);
    });
    peerSocket.end();
    await peerClosed;
    expect(liveSockets.has(peerSocket)).toBe(false);

    // Put acct-0 (the oldest cache entry) mid-flight on its replacement socket.
    const inFlight = createDeferred<() => void>();
    slowResponse = inFlight;
    const slowSend = send(0, "slow");
    const releaseResponse = await inFlight.promise;
    slowResponse = undefined;
    const activeSocket = socketForAccount(0);

    try {
      expect(activeSocket).not.toBe(peerSocket);
      // New cache key retires acct-0, but its exact socket must survive the lease.
      await send(64, "evictor");
      expect(liveSockets.has(activeSocket)).toBe(true);
    } finally {
      releaseResponse();
      await slowSend.catch(() => undefined);
    }
    expect(await slowSend).toBe(activeSocket);
    await vi.waitFor(() => expect(liveSockets.has(activeSocket)).toBe(false), { timeout: 3000 });

    // Refresh each idle entry before eviction so an earlier peer close cannot
    // stand in for closing the transport's current socket.
    for (let i = 65; i < ACCOUNTS; i += 1) {
      const idleSocket = await send(i - 64, "refresh before eviction");
      expect(liveSockets.has(idleSocket)).toBe(true);
      await send(i, `hello ${i}`);
      await vi.waitFor(() => expect(liveSockets.has(idleSocket)).toBe(false), { timeout: 3000 });
    }

    // Retained transports still deliver after an unrelated idle peer close.
    await send(6, "retained");
    expect(sendMessageCalls).toBe(ACCOUNTS + 8);
    expect(requestSockets.size).toBe(ACCOUNTS);

    const idleBeforeReset = await send(7, "idle before reset");
    const resetInFlight = createDeferred<() => void>();
    slowResponse = resetInFlight;
    const resetSend = send(6, "active during reset");
    const releaseResetResponse = await resetInFlight.promise;
    slowResponse = undefined;
    const activeBeforeReset = socketForAccount(6);
    try {
      resetTelegramClientOptionsCacheForTests();
      expect(liveSockets.has(activeBeforeReset)).toBe(true);
      await vi.waitFor(() => expect(liveSockets.has(idleBeforeReset)).toBe(false), {
        timeout: 3000,
      });
    } finally {
      releaseResetResponse();
      await resetSend.catch(() => undefined);
    }
    expect(await resetSend).toBe(activeBeforeReset);
    await vi.waitFor(() => expect(liveSockets.has(activeBeforeReset)).toBe(false), {
      timeout: 3000,
    });
    expect(await send(6, "fresh after reset")).not.toBe(activeBeforeReset);
  });
});
