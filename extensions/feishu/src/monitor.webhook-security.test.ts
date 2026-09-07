// Feishu tests cover monitor.webhook security plugin behavior.
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFeishuClientMockModule,
  createFeishuRuntimeMockModule,
} from "./monitor.test-mocks.js";
import {
  buildWebhookConfig,
  createFeishuWebhookTestAccount,
  getFreePort,
  signFeishuPayload,
  waitUntilServerReady,
  withRunningWebhookMonitor,
} from "./monitor.webhook.test-helpers.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const webhookBodyTimeoutMs = vi.hoisted(() => ({ value: 50 }));
const preAuthInFlightLimit = vi.hoisted(() => ({ value: undefined as number | undefined }));

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/webhook-request-guards")>();
  return {
    ...actual,
    createWebhookInFlightLimiter: (
      options?: Parameters<typeof actual.createWebhookInFlightLimiter>[0],
    ) =>
      actual.createWebhookInFlightLimiter({
        ...options,
        ...(preAuthInFlightLimit.value === undefined
          ? {}
          : { maxInFlightPerKey: preAuthInFlightLimit.value }),
      }),
  };
});

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
  registerFeishuAiAgent: vi.fn().mockResolvedValue({ ok: true }),
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
  generateChallenge: vi.fn(() => ({ isChallenge: false })),
}));

vi.mock("./monitor.state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor.state.js")>();
  return {
    ...actual,
    get FEISHU_WEBHOOK_BODY_TIMEOUT_MS() {
      return webhookBodyTimeoutMs.value;
    },
  };
});

import type { RuntimeEnv } from "../runtime-api.js";
import { buildFeishuWebhookRateLimitKey } from "./monitor-rate-limit-key.js";
import { resolveRequestClientIp } from "./monitor-transport-runtime-api.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { monitorFeishuProvider } from "./monitor.js";
import { feishuWebhookRateLimiter, httpServers } from "./monitor.state.js";
import { monitorWebhook } from "./monitor.transport.js";
import type { ResolvedFeishuAccount } from "./types.js";

beforeAll(async () => {
  await import("./monitor.account.js");
});

async function waitForSlowBodyTimeoutResponse(
  url: string,
  timeoutMs: number,
): Promise<{ body: string; elapsedMs: number }> {
  return await new Promise<{ body: string; elapsedMs: number }>((resolve, reject) => {
    const target = new URL(url);
    const startedAt = Date.now();
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
        socket.write("Content-Length: 65536\r\n");
        socket.write("\r\n");
        socket.write('{"type":"url_verification"');
      },
    );

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(failTimer);
      resolve({ body: response, elapsedMs: Date.now() - startedAt });
    });
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        reject(error);
      }
    });

    const failTimer = setTimeout(() => {
      settled = true;
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
      resolve(result);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("close", () => {
      finish(response);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!settled) {
        if (response.includes("Payload too large")) {
          finish(response);
          return;
        }
        settled = true;
        clearTimeout(failTimer);
        reject(new Error(`${error.message}; partial response: ${JSON.stringify(response)}`));
      }
    });

    const failTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error("payload-too-large response did not arrive within 1000ms"));
    }, 1_000);
  });
}

function openIncompleteWebhookRequest(url: string): {
  socket: ReturnType<typeof createConnection>;
  response: Promise<string>;
  finish: () => void;
  isClosed: () => boolean;
} {
  const target = new URL(url);
  const body = '{"type":"url_verification"}';
  const bodyPrefix = body.slice(0, -1);
  const bodySuffix = body.slice(-1);
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port),
  });
  let response = "";
  let settled = false;
  const responsePromise = new Promise<string>((resolve, reject) => {
    const failTimer = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(new Error("incomplete webhook request did not close within 10000ms"));
      }
    }, 10_000);
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(failTimer);
      resolve(response);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("close", finish);
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        reject(error);
      }
    });
    socket.once("connect", () => {
      socket.write(`POST ${target.pathname} HTTP/1.1\r\n`);
      socket.write(`Host: ${target.hostname}\r\n`);
      socket.write("Content-Type: application/json\r\n");
      socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
      socket.write("Connection: close\r\n");
      socket.write("\r\n");
      socket.write(bodyPrefix);
    });
  });

  return {
    socket,
    response: responsePromise,
    finish: () => socket.write(bodySuffix),
    isClosed: () => settled,
  };
}

function resolveTestClientIp(remoteAddress: string | undefined): string | undefined {
  return resolveRequestClientIp({
    headers: {},
    socket: { remoteAddress },
  } as IncomingMessage);
}

function waitForWebhookResponseClose(accountId: string): Promise<void> {
  const server = httpServers.get(accountId);
  if (!server) {
    throw new Error("expected webhook server");
  }
  return new Promise<void>((resolve) => {
    server.once("request", (_req, res) => res.once("close", resolve));
  });
}

afterEach(async () => {
  preAuthInFlightLimit.value = undefined;
  webhookBodyTimeoutMs.value = 50;
  feishuWebhookRateLimiter.clear();
  cleanupFeishuMonitorStateForTests();
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
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const statusSink = vi.fn();
    await withRunningWebhookMonitor(
      {
        accountId: "payload-too-large",
        path: "/hook-payload-too-large",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
        runtime,
        statusSink,
      },
      monitorFeishuProvider,
      async (url) => {
        statusSink.mockClear();
        const responseClosed = waitForWebhookResponseClose("payload-too-large");
        const response = await waitForOversizedBodyResponse(url);

        expect(response).toContain("413 Payload Too Large");
        expect(response).toContain("Payload too large");
        expect(response).toMatch(/connection: close/i);
        await responseClosed;
        expect(
          runtime.log.mock.calls.filter(([message]) => message.includes("webhook anomaly")),
        ).toEqual([
          [
            "feishu[payload-too-large]: webhook anomaly path=/hook-payload-too-large status=413 count=1",
          ],
        ]);
        expect(statusSink).not.toHaveBeenCalled();
      },
    );
  });

  it("drops slow-body webhook requests within the tightened pre-auth timeout", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const statusSink = vi.fn();
    await withRunningWebhookMonitor(
      {
        accountId: "slow-body-timeout",
        path: "/hook-slow-body-timeout",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
        runtime,
        statusSink,
      },
      monitorFeishuProvider,
      async (url) => {
        statusSink.mockClear();
        const responseClosed = waitForWebhookResponseClose("slow-body-timeout");
        const result = await waitForSlowBodyTimeoutResponse(url, 1_000);
        expect(result.body).toContain("408 Request Timeout");
        expect(result.body).toContain("Request body timeout");
        expect(result.body).toMatch(/connection: close/i);
        expect(result.elapsedMs).toBeLessThan(500);
        await responseClosed;
        expect(
          runtime.log.mock.calls.filter(([message]) => message.includes("webhook anomaly")),
        ).toEqual([
          [
            "feishu[slow-body-timeout]: webhook anomaly path=/hook-slow-body-timeout status=408 count=1",
          ],
        ]);
        expect(statusSink).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects excess concurrent pre-auth webhook reads and recovers capacity", async () => {
    webhookBodyTimeoutMs.value = 5_000;
    const accountId = "pre-auth-inflight";
    const path = "/hook-pre-auth-inflight";
    const port = await getFreePort();
    const abortController = new AbortController();
    const invokeWebhookEvent = vi.fn(async () => ({
      kind: "durable" as const,
      value: { accepted: true },
    }));
    const openRequests: Array<ReturnType<typeof openIncompleteWebhookRequest>> = [];
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, port, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
      invokeWebhookEvent,
    });

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      await waitUntilServerReady(url);
      const server = httpServers.get(accountId);
      if (!server) {
        throw new Error("expected webhook server");
      }
      const heldRequestsReceived = new Promise<void>((resolve) => {
        let requestCount = 0;
        const onRequest = () => {
          requestCount += 1;
          if (requestCount === 64) {
            server.off("request", onRequest);
            resolve();
          }
        };
        server.on("request", onRequest);
      });
      const held = Array.from({ length: 64 }, () => openIncompleteWebhookRequest(url));
      openRequests.push(...held);
      await heldRequestsReceived;
      expect(held.every((request) => !request.isClosed())).toBe(true);

      const overflowStartedAt = Date.now();
      const overflow = openIncompleteWebhookRequest(url);
      openRequests.push(overflow);
      const overflowResponse = await overflow.response;

      expect(overflowResponse).toContain("429 Too Many Requests");
      expect(overflowResponse).toMatch(/connection: close/i);
      expect(Date.now() - overflowStartedAt).toBeLessThan(400);
      expect(invokeWebhookEvent).not.toHaveBeenCalled();

      for (const request of held) {
        request.finish();
      }
      const heldResponses = await Promise.all(held.map((request) => request.response));
      expect(heldResponses).toHaveLength(64);
      expect(heldResponses.every((response) => response.includes("401 Unauthorized"))).toBe(true);

      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "test.pre_auth_inflight" },
        event: {},
      });
      const recovered = await fetch(url, {
        method: "POST",
        headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
        body: rawBody,
      });

      expect(recovered.status).toBe(200);
      expect(recovered.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      expect(invokeWebhookEvent).toHaveBeenCalledTimes(1);
    } finally {
      for (const request of openRequests) {
        request.socket.destroy();
      }
      webhookBodyTimeoutMs.value = 50;
      abortController.abort();
      await monitorPromise;
    }
  });

  it("releases pre-auth capacity before signed event dispatch", { timeout: 15_000 }, async () => {
    preAuthInFlightLimit.value = 1;
    const accountId = "pre-auth-dispatch";
    const path = "/hook-pre-auth-dispatch";
    const port = await getFreePort();
    const abortController = new AbortController();
    let releaseDispatch = () => {};
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const invokeWebhookEvent = vi.fn(async () => {
      await dispatchGate;
      return { kind: "durable" as const, value: { accepted: true } };
    });
    let signedRequest: Promise<Response> | undefined;
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, port, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
      invokeWebhookEvent,
    });

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      await waitUntilServerReady(url);
      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "test.pre_auth_dispatch" },
        event: {},
      });
      signedRequest = fetch(url, {
        method: "POST",
        headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
        body: rawBody,
      });
      await vi.waitFor(() => expect(invokeWebhookEvent).toHaveBeenCalledOnce(), {
        timeout: 5_000,
        interval: 10,
      });

      const admittedInvalidSignature = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(admittedInvalidSignature.status).toBe(401);
      expect(invokeWebhookEvent).toHaveBeenCalledOnce();

      releaseDispatch();
      expect((await signedRequest).status).toBe(200);
    } finally {
      releaseDispatch();
      if (signedRequest) {
        await signedRequest.catch(() => undefined);
      }
      abortController.abort();
      await monitorPromise;
    }
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

  it("uses one webhook rate-limit key for loopback address-family variants", () => {
    const base = {
      accountId: "rate-limit-key",
      path: "/hook-rate-limit-key",
    };

    expect([
      buildFeishuWebhookRateLimitKey({
        ...base,
        clientIp: resolveTestClientIp("127.0.0.1"),
      }),
      buildFeishuWebhookRateLimitKey({
        ...base,
        clientIp: resolveTestClientIp("127.0.0.42"),
      }),
      buildFeishuWebhookRateLimitKey({
        ...base,
        clientIp: resolveTestClientIp("::ffff:127.0.0.1"),
      }),
      buildFeishuWebhookRateLimitKey({
        ...base,
        clientIp: resolveTestClientIp("::1"),
      }),
    ]).toEqual([
      "rate-limit-key:/hook-rate-limit-key:loopback",
      "rate-limit-key:/hook-rate-limit-key:loopback",
      "rate-limit-key:/hook-rate-limit-key:loopback",
      "rate-limit-key:/hook-rate-limit-key:loopback",
    ]);
  });

  it("keeps non-loopback and unknown webhook rate-limit key suffixes distinct", () => {
    const base = {
      accountId: "rate-limit-key",
      path: "/hook-rate-limit-key",
    };

    expect(buildFeishuWebhookRateLimitKey({ ...base, clientIp: "10.0.0.1" })).toBe(
      "rate-limit-key:/hook-rate-limit-key:10.0.0.1",
    );
    expect(buildFeishuWebhookRateLimitKey(base)).toBe(
      "rate-limit-key:/hook-rate-limit-key:unknown",
    );
  });

  it("caps tracked webhook rate-limit keys to prevent unbounded growth", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4_500; i += 1) {
      feishuWebhookRateLimiter.isRateLimited(`/feishu-rate-limit:key-${i}`, now);
    }
    expect(feishuWebhookRateLimiter.size()).toBeLessThanOrEqual(4_096);
  });

  it("prunes stale webhook rate-limit state after window elapses", () => {
    const now = 2_000_000;
    for (let i = 0; i < 100; i += 1) {
      feishuWebhookRateLimiter.isRateLimited(`/feishu-rate-limit-stale:key-${i}`, now);
    }
    expect(feishuWebhookRateLimiter.size()).toBe(100);

    feishuWebhookRateLimiter.isRateLimited("/feishu-rate-limit-stale:fresh", now + 60_001);
    expect(feishuWebhookRateLimiter.size()).toBe(1);
  });
});
