import { createConnection } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuClientMockModule,
  createFeishuRuntimeMockModule,
} from "./monitor.test-mocks.js";
import {
  buildWebhookConfig,
  getFreePort,
  withRunningWebhookMonitor,
} from "./monitor.webhook.test-helpers.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => createFeishuClientMockModule());
vi.mock("./runtime.js", () => createFeishuRuntimeMockModule());

vi.mock("@larksuiteoapi/node-sdk", () => ({
  adaptDefault: vi.fn(
    () => (_req: unknown, res: { statusCode?: number; end: (s: string) => void }) => {
      res.statusCode = 200;
      res.end("ok");
    },
  ),
}));

vi.mock("./monitor.state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor.state.js")>();
  return {
    ...actual,
    FEISHU_WEBHOOK_BODY_TIMEOUT_MS: 50,
  };
});

import type { RuntimeEnv } from "../runtime-api.js";
import {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  monitorFeishuProvider,
  stopFeishuMonitor,
} from "./monitor.js";
import { monitorWebhook } from "./monitor.transport.js";
import type { ResolvedFeishuAccount } from "./types.js";

async function waitForSlowBodyTimeoutResponse(
  url: string,
  timeoutMs: number,
): Promise<{ body: string; elapsedMs: number }> {
  return await new Promise<{ body: string; elapsedMs: number }>((resolve, reject) => {
    const target = new URL(url);
    const startedAt = Date.now();
    let response = "";
    const socket = createConnection(
      {
        host: target.hostname,
        port: Number(target.port),
      },
      () => {
        socket.write(`POST ${target.pathname} HTTP/1.1\r\n`);
        socket.write(`Host: ${target.hostname}\r\n`);
        socket.write("Content-Type: application/json\r\n");
        socket.write("Content-Length: 65536\r\n");
        socket.write("\r\n");
        socket.write('{"type":"url_verification"');
      },
    );

    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("Request body timeout")) {
        clearTimeout(failTimer);
        socket.destroy();
        resolve({ body: response, elapsedMs: Date.now() - startedAt });
      }
    });

    const failTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout response did not arrive within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function waitForOversizedBodyResponse(url: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify({ payload: "x".repeat(70 * 1024) });
    let response = "";
    let settled = false;
    const socket = createConnection(
      {
        host: target.hostname,
        port: Number(target.port),
      },
      () => {
        socket.write(`POST ${target.pathname} HTTP/1.1\r\n`);
        socket.write(`Host: ${target.hostname}\r\n`);
        socket.write("Content-Type: application/json\r\n");
        socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
        socket.write("\r\n");
        socket.write(body);
      },
    );

    const finish = (result: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(failTimer);
      socket.destroy();
      resolve(result);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("Payload too large")) {
        finish(response);
      }
    });
    socket.on("close", () => {
      if (response.includes("Payload too large")) {
        finish(response);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (response.includes("Payload too large")) {
        finish(response);
        return;
      }
      if (error.code === "ECONNRESET") {
        finish("ECONNRESET");
        return;
      }
      reject(error);
    });

    const failTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error("payload-too-large response did not arrive within 1000ms"));
    }, 1_000);
  });
}

afterEach(() => {
  clearFeishuWebhookRateLimitStateForTest();
  stopFeishuMonitor();
});

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("@larksuiteoapi/node-sdk");
  vi.doUnmock("./monitor.state.js");
  vi.resetModules();
});

describe("Feishu webhook security hardening", () => {
  it("rejects webhook mode without verificationToken", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildWebhookConfig({
      accountId: "missing-token",
      path: "/hook-missing-token",
      port: await getFreePort(),
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(
      /requires verificationToken/i,
    );
  });

  it("rejects webhook mode without encryptKey", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildWebhookConfig({
      accountId: "missing-encrypt-key",
      path: "/hook-missing-encrypt",
      port: await getFreePort(),
      verificationToken: "verify_token",
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(/requires encryptKey/i);
  });

  it("refuses to start the webhook transport without encryptKey", async () => {
    const account = {
      accountId: "transport-missing-encrypt-key",
      config: {
        enabled: true,
        connectionMode: "webhook",
        webhookHost: "127.0.0.1",
        webhookPort: await getFreePort(),
        webhookPath: "/hook-transport-missing-encrypt",
      },
    } as ResolvedFeishuAccount;

    await expect(
      monitorWebhook({
        account,
        accountId: account.accountId,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        } as RuntimeEnv,
        abortSignal: new AbortController().signal,
        eventDispatcher: {} as never,
      }),
    ).rejects.toThrow(/requires encryptKey/i);
  });

  it("returns 415 for POST requests without json content type", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "content-type",
        path: "/hook-content-type",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        });

        expect(response.status).toBe(415);
        expect(await response.text()).toBe("Unsupported Media Type");
      },
    );
  });

  it("rejects oversized unsigned webhook bodies with 413 before signature verification", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "payload-too-large",
        path: "/hook-payload-too-large",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await waitForOversizedBodyResponse(url);

        if (response === "ECONNRESET") {
          expect(response).toBe("ECONNRESET");
        } else {
          expect(response).toContain("413 Payload Too Large");
          expect(response).toContain("Payload too large");
        }
      },
    );
  });

  it("drops slow-body webhook requests within the tightened pre-auth timeout", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "slow-body-timeout",
        path: "/hook-slow-body-timeout",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const result = await waitForSlowBodyTimeoutResponse(url, 1_000);
        expect(result.body).toContain("408 Request Timeout");
        expect(result.body).toContain("Request body timeout");
        expect(result.elapsedMs).toBeLessThan(500);
      },
    );
  });

  it("rate limits webhook burst traffic with 429", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "rate-limit",
        path: "/hook-rate-limit",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        let saw429 = false;
        for (let i = 0; i < 130; i += 1) {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          });
          if (response.status === 429) {
            saw429 = true;
            expect(await response.text()).toBe("Too Many Requests");
            break;
          }
        }

        expect(saw429).toBe(true);
      },
    );
  });

  it("caps tracked webhook rate-limit keys to prevent unbounded growth", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4_500; i += 1) {
      isWebhookRateLimitedForTest(`/feishu-rate-limit:key-${i}`, now);
    }
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBeLessThanOrEqual(4_096);
  });

  it("prunes stale webhook rate-limit state after window elapses", () => {
    const now = 2_000_000;
    for (let i = 0; i < 100; i += 1) {
      isWebhookRateLimitedForTest(`/feishu-rate-limit-stale:key-${i}`, now);
    }
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBe(100);

    isWebhookRateLimitedForTest("/feishu-rate-limit-stale:fresh", now + 60_001);
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBe(1);
  });
});
