// Real-socket proof for diagnostic response deadlines: production Telegram
// transport against a local HTTP server, with no fetch or stream mocks.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeTelegram, resetTelegramProbeFetcherCacheForTests } from "./probe.js";

type ResponseMode = "stall" | "trickle";

describe("probeTelegram response body deadlines over real sockets", () => {
  let server: Server;
  let apiRoot: string;
  let responseMode: ResponseMode = "stall";
  let requestCount = 0;
  let closedSocketCount = 0;
  const liveSockets = new Set<Socket>();
  const activeIntervals = new Set<ReturnType<typeof setInterval>>();

  beforeAll(async () => {
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "OPENCLAW_PROXY_URL",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
      "OPENCLAW_DEBUG_PROXY_URL",
    ]) {
      vi.stubEnv(name, "");
    }

    server = createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":true,"result":{"id":123');
      if (responseMode === "stall") {
        return;
      }

      const interval = setInterval(() => {
        res.write(" ");
      }, 20);
      activeIntervals.add(interval);
      res.once("close", () => {
        clearInterval(interval);
        activeIntervals.delete(interval);
      });
    });
    server.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.once("close", () => {
        liveSockets.delete(socket);
        closedSocketCount += 1;
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetTelegramProbeFetcherCacheForTests();
    vi.unstubAllEnvs();
    for (const interval of activeIntervals) {
      clearInterval(interval);
    }
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  async function expectDeadlineFailure(mode: ResponseMode, expectedError: RegExp) {
    responseMode = mode;
    const previousRequestCount = requestCount;
    const previousClosedSocketCount = closedSocketCount;

    const result = await probeTelegram("placeholder", 200, {
      apiRoot,
      includeWebhookInfo: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(expectedError);
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(requestCount).toBe(previousRequestCount + 1);
    await vi.waitFor(() => expect(closedSocketCount).toBeGreaterThan(previousClosedSocketCount), {
      timeout: 1_000,
    });
  }

  it("cancels a socket whose response body stalls", async () => {
    await expectDeadlineFailure("stall", /response body stalled/i);
  });

  it("enforces the overall deadline while body bytes keep arriving", async () => {
    await expectDeadlineFailure("trickle", /response body timed out/i);
  });
});
