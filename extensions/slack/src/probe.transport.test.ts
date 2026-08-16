// Prove Slack probe deadlines against the real SDK and loopback HTTP transport.
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

const TEST_ENV_KEYS = [
  "SLACK_API_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;

const originalEnv = Object.fromEntries(
  TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof TEST_ENV_KEYS)[number], string | undefined>;

type TestServer = {
  apiUrl: string;
  sockets: Set<Socket>;
  close(): Promise<void>;
};

function clearSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

async function startSlackTransportServer(handler: RequestListener): Promise<TestServer> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Slack probe test server did not bind a TCP address");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    sockets,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

afterEach(() => {
  restoreSlackTransportEnv();
});

describe("probeSlack real network deadlines", () => {
  it("aborts a stalled Slack request and closes its only socket", async () => {
    clearSlackTransportEnv();
    let requests = 0;
    const server = await startSlackTransportServer((request) => {
      requests += 1;
      request.resume();
    });
    try {
      process.env.SLACK_API_URL = server.apiUrl;

      await expect(probeSlack("probe-fixture", 100)).resolves.toMatchObject({ ok: false });

      expect(requests).toBe(1);
      await expect.poll(() => server.sockets.size, { timeout: 400 }).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("does not retry a dropped request after the probe has already returned", async () => {
    clearSlackTransportEnv();
    let requests = 0;
    let notifyRequest: () => void = () => undefined;
    let notifyRetry: () => void = () => undefined;
    const requestArrived = new Promise<void>((resolve) => {
      notifyRequest = resolve;
    });
    const retryArrived = new Promise<void>((resolve) => {
      notifyRetry = resolve;
    });
    const server = await startSlackTransportServer((request, response) => {
      requests += 1;
      notifyRequest();
      if (requests === 2) {
        notifyRetry();
      }
      request.resume();
      response.destroy();
    });
    try {
      process.env.SLACK_API_URL = server.apiUrl;
      const nativeSetTimeout = globalThis.setTimeout;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const probe = probeSlack("probe-fixture", 100);
        await requestArrived;
        await vi.advanceTimersByTimeAsync(100);
        await expect(probe).resolves.toMatchObject({ ok: false });

        // The default Slack read retry is randomized between 500 and 1,000 ms.
        await vi.advanceTimersByTimeAsync(1_200);
        const retried = await Promise.race([
          retryArrived.then(() => true),
          new Promise<boolean>((resolve) => {
            nativeSetTimeout(() => resolve(false), 100);
          }),
        ]);
        expect(retried).toBe(false);
        expect(requests).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      await expect.poll(() => server.sockets.size, { timeout: 400 }).toBe(0);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it("rejects a rate limit without waiting or retrying", async () => {
    clearSlackTransportEnv();
    let requests = 0;
    const server = await startSlackTransportServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "2",
      });
      response.end(`${JSON.stringify({ ok: false, error: "ratelimited" })}\n`);
    });
    try {
      process.env.SLACK_API_URL = server.apiUrl;
      const startedAt = performance.now();

      await expect(probeSlack("probe-fixture", 1_000)).resolves.toMatchObject({ ok: false });

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("aborts response-body trickling at the absolute probe deadline", async () => {
    clearSlackTransportEnv();
    let requests = 0;
    const server = await startSlackTransportServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const trickle = setInterval(() => response.write(" "), 25);
      const finish = setTimeout(() => {
        clearInterval(trickle);
        response.end(`${JSON.stringify({ ok: true })}\n`);
      }, 750);
      response.once("close", () => {
        clearInterval(trickle);
        clearTimeout(finish);
      });
    });
    try {
      process.env.SLACK_API_URL = server.apiUrl;
      const startedAt = performance.now();

      await expect(probeSlack("probe-fixture", 100)).resolves.toMatchObject({ ok: false });

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(requests).toBe(1);
      await expect.poll(() => server.sockets.size, { timeout: 400 }).toBe(0);
    } finally {
      await server.close();
    }
  });
});
