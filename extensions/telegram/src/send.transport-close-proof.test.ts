// E2E proof for the transport cache-eviction lifecycle: no module mocks — real
// grammY Bot, real undici agents, production-mode cache, against a local HTTP
// server standing in for the Telegram Bot API. Observes actual TCP sockets.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let sendMessageTelegram: typeof import("./send.js").sendMessageTelegram;
let resetTelegramClientOptionsCacheForTests: typeof import("./send.js").resetTelegramClientOptionsCacheForTests;

describe("telegram transport cache eviction over real sockets", () => {
  let server: Server;
  let apiRoot: string;
  const liveSockets = new Set<Socket>();
  const sockets = { opened: 0, closed: 0 };
  let sendMessageCalls = 0;
  let slowMode = false;
  let slowRequestReceived: () => void = () => {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        const url = req.url ?? "";
        const respond = (result: unknown) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (url.includes("/sendMessage")) {
          sendMessageCalls += 1;
          if (slowMode) {
            slowRequestReceived();
            setTimeout(() => respond({ message_id: sendMessageCalls, chat: { id: 123 } }), 800);
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
    });
    server.on("connection", (socket) => {
      sockets.opened += 1;
      liveSockets.add(socket);
      socket.on("close", () => {
        sockets.closed += 1;
        liveSockets.delete(socket);
      });
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

  it("closes evicted transports, deferring close for an in-flight send", async () => {
    // The cache is disabled under test env; force the production path.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
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

    // Fill the cache to its 64-entry cap: one real agent + socket per account.
    for (let i = 0; i < 64; i += 1) {
      const result = await sendMessageTelegram("123", `hello ${i}`, {
        cfg,
        accountId: `acct-${i}`,
      });
      expect(result.messageId).toBeTruthy();
    }
    expect(sockets.opened).toBe(64);
    // Keep-alive is 30s; nothing may have closed yet.
    expect(sockets.closed).toBe(0);

    // Put acct-0 (the oldest cache entry) mid-flight, then evict it.
    slowMode = true;
    const inFlight = new Promise<void>((resolve) => {
      slowRequestReceived = resolve;
    });
    const slowSend = sendMessageTelegram("123", "slow", { cfg, accountId: "acct-0" });
    await inFlight;
    slowMode = false;

    // New cache key -> evicts acct-0 while its send holds the lease.
    const evictor = await sendMessageTelegram("123", "evictor", { cfg, accountId: "acct-64" });
    expect(evictor.messageId).toBeTruthy();
    // Deferred close: the evicted transport must NOT be closed mid-request.
    expect(sockets.closed).toBe(0);

    const slow = await slowSend;
    expect(slow.messageId).toBeTruthy();
    // Lease released -> the retired acct-0 transport closes its real socket.
    await vi.waitFor(() => expect(sockets.closed).toBeGreaterThanOrEqual(1), { timeout: 3000 });

    // Five more evictions against idle entries (acct-1..acct-5) close immediately.
    for (let i = 65; i < ACCOUNTS; i += 1) {
      const result = await sendMessageTelegram("123", `hello ${i}`, {
        cfg,
        accountId: `acct-${i}`,
      });
      expect(result.messageId).toBeTruthy();
    }
    await vi.waitFor(() => expect(sockets.closed).toBe(6), { timeout: 3000 });

    // All sends succeeded; retained cache entries keep their sockets open.
    expect(sendMessageCalls).toBe(ACCOUNTS + 1);
    expect(sockets.opened).toBe(ACCOUNTS);
    expect(liveSockets.size).toBe(ACCOUNTS - 6);
  });
});
