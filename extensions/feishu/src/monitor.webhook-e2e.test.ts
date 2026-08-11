// Feishu tests cover monitor.webhook e2e plugin behavior.
import crypto from "node:crypto";
import type { Server } from "node:http";
import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";
import { createFeishuRuntimeMockModule } from "./monitor.test-mocks.js";
import {
  buildWebhookConfig,
  getFreePort,
  waitUntilServerReady,
  withRunningWebhookMonitor,
} from "./monitor.webhook.test-helpers.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
  registerFeishuAiAgent: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  };
});

vi.mock("./runtime.js", () => createFeishuRuntimeMockModule());

import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { monitorFeishuProvider } from "./monitor.js";
import { httpServers } from "./monitor.state.js";
import { monitorWebhook } from "./monitor.transport.js";
import type { ResolvedFeishuAccount } from "./types.js";

function createFeishuWebhookTestAccount(
  accountId: string,
  port: number,
  webhookPath: string,
): ResolvedFeishuAccount {
  return {
    accountId,
    encryptKey: "encrypt_key",
    config: {
      enabled: true,
      connectionMode: "webhook",
      webhookHost: "127.0.0.1",
      webhookPort: port,
      webhookPath,
    },
  } as ResolvedFeishuAccount;
}

beforeAll(async () => {
  await import("./monitor.account.js");
});

function signFeishuPayload(params: {
  encryptKey: string;
  rawBody: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = params.timestamp ?? "1711111111";
  const nonce = params.nonce ?? "nonce-test";
  const signature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + params.encryptKey + params.rawBody)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

function encryptFeishuPayload(encryptKey: string, payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

async function postSignedPayload(url: string, payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  return await fetch(url, {
    method: "POST",
    headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
    body: rawBody,
  });
}

async function sendRawSignedFeishuRequest(params: {
  port: number;
  target: string;
  method?: string;
  rawBody: string;
  headers: Record<string, string>;
}): Promise<string> {
  const rawHeaders = Object.entries(params.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");

  return await new Promise<string>((resolve, reject) => {
    let response = "";
    const socket = createConnection({ host: "127.0.0.1", port: params.port }, () => {
      socket.end(
        `${params.method ?? "POST"} ${params.target} HTTP/1.1\r\nHost: localhost\r\n` +
          `${rawHeaders}\r\nContent-Length: ${Buffer.byteLength(params.rawBody)}\r\n` +
          `Connection: close\r\n\r\n${params.rawBody}`,
      );
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

afterEach(() => {
  cleanupFeishuMonitorStateForTests();
});

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

describe("Feishu webhook signed-request e2e", () => {
  it("waits for HTTP close before resolving webhook abort cleanup", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const accountId = "abort-delayed-close";
    const path = "/hook-e2e-abort-delayed-close";
    const port = await getFreePort();
    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildWebhookConfig({
        accountId,
        path,
        port,
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      }),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      accountId,
    });
    await waitUntilServerReady(`http://127.0.0.1:${port}${path}`);

    const server = httpServers.get(accountId);
    expect(server).toBeDefined();
    if (!server) {
      throw new Error("expected webhook server to be tracked");
    }

    const originalClose = server.close.bind(server);
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeSpy = vi.fn((callback?: (err?: Error) => void) => {
      void closeGate.then(() => {
        originalClose(callback);
      });
      return server;
    });
    server.close = closeSpy as unknown as Server["close"];

    let monitorSettled = false;
    const observedMonitorPromise = monitorPromise.finally(() => {
      monitorSettled = true;
    });

    try {
      abortController.abort();
      await vi.waitFor(() => {
        expect(closeSpy).toHaveBeenCalledTimes(1);
      });
      expect(monitorSettled).toBe(false);
      expect(httpServers.get(accountId)).toBe(server);

      releaseClose?.();
      await observedMonitorPromise;

      expect(httpServers.has(accountId)).toBe(false);
    } finally {
      releaseClose?.();
    }
  });

  it("rejects webhook monitor when abort cleanup close fails", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const accountId = "abort-close-fails";
    const path = "/hook-e2e-abort-close-fails";
    const port = await getFreePort();
    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildWebhookConfig({
        accountId,
        path,
        port,
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      }),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      accountId,
    });
    await waitUntilServerReady(`http://127.0.0.1:${port}${path}`);

    const server = httpServers.get(accountId);
    expect(server).toBeDefined();
    if (!server) {
      throw new Error("expected webhook server to be tracked");
    }

    const originalClose = server.close.bind(server);
    server.close = vi.fn((callback?: (err?: Error) => void) => {
      originalClose(() => {
        callback?.(new Error("close failed"));
      });
      return server;
    }) as unknown as Server["close"];

    abortController.abort();
    await expect(monitorPromise).rejects.toThrow("close failed");
    expect(httpServers.has(accountId)).toBe(false);
  });

  it("rejects invalid signatures with 401 instead of empty 200", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "invalid-signature",
        path: "/hook-e2e-invalid-signature",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { type: "url_verification", challenge: "challenge-token" };
        const rawBody = JSON.stringify(payload);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            ...signFeishuPayload({ encryptKey: "wrong_key", rawBody }),
          },
          body: rawBody,
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("rejects missing signature headers with 401", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "missing-signature",
        path: "/hook-e2e-missing-signature",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "url_verification", challenge: "challenge-token" }),
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("rejects malformed short signatures with 401", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "short-signature",
        path: "/hook-e2e-short-signature",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { type: "url_verification", challenge: "challenge-token" };
        const headers = signFeishuPayload({
          encryptKey: "encrypt_key",
          rawBody: JSON.stringify(payload),
        });
        headers["x-lark-signature"] = expectDefined(
          headers["x-lark-signature"],
          "Feishu webhook signature",
        ).slice(0, 12);

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("returns 401 for unsigned invalid json before parsing", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "invalid-json",
        path: "/hook-e2e-invalid-json",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("returns 400 for signed invalid json after signature validation", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-invalid-json",
        path: "/hook-e2e-signed-invalid-json",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const rawBody = "{not-json";
        const response = await fetch(url, {
          method: "POST",
          headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
          body: rawBody,
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Invalid JSON");
      },
    );
  });

  it("accepts signed plaintext url_verification challenges end-to-end", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-challenge",
        path: "/hook-e2e-signed-challenge",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { type: "url_verification", challenge: "challenge-token" };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
        await expect(response.json()).resolves.toEqual({ challenge: "challenge-token" });
      },
    );
  });

  it("accepts signed non-challenge events and reaches the dispatcher", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-dispatch",
        path: "/hook-e2e-signed-dispatch",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          schema: "2.0",
          header: { event_type: "unknown.event" },
          event: {},
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
        expect(await response.text()).toContain("no unknown.event event handle");
      },
    );
  });

  it("admits signed requests only on the configured POST webhook route", async () => {
    const accountId = "signed-route-boundary";
    const path = "/hook-e2e-signed-route-boundary";
    const port = await getFreePort();
    const encryptKey = "encrypt_key";
    const handler = vi.fn(async () => ({ accepted: true }));
    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey,
      verificationToken: "verify_token",
    });
    eventDispatcher.register({ "test.route_boundary": handler });
    const statusSink = vi.fn();
    const abortController = new AbortController();
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, port, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher,
      statusSink,
    });
    const url = `http://127.0.0.1:${port}${path}`;
    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "test.route_boundary" },
      event: { marker: "signed-route-boundary" },
    });
    const headers = signFeishuPayload({ encryptKey, rawBody });
    const requests = [
      { label: "different route", route: "/hook-e2e-other", method: "POST", status: 404 },
      { label: "route prefix", route: `${path}/nested`, method: "POST", status: 404 },
      { label: "trailing slash", route: `${path}/`, method: "POST", status: 404 },
      { label: "PUT method", route: path, method: "PUT", status: 405 },
      { label: "DELETE method", route: path, method: "DELETE", status: 405 },
      { label: "configured route", route: path, method: "POST", status: 200 },
      {
        label: "configured route with query",
        route: `${path}?delivery=validated`,
        method: "POST",
        status: 200,
      },
    ];

    try {
      await waitUntilServerReady(url);
      statusSink.mockClear();
      const server = httpServers.get(accountId);
      const requestListener = server?.listeners("request")[0];
      if (!server || !requestListener) {
        throw new Error("expected Feishu webhook request listener");
      }
      let malformedTargetError: unknown;
      server.removeListener("request", requestListener);
      server.on("request", (request, response) => {
        try {
          requestListener.call(server, request, response);
        } catch (error) {
          malformedTargetError = error;
          response.statusCode = 500;
          response.end("Webhook request handler threw");
        }
      });

      const rawTargets = [
        { label: "malformed authority", target: "//[" },
        { label: "foreign authority", target: `//attacker${path}` },
        { label: "duplicate-slash authority", target: `//localhost${path}` },
        { label: "dot-segment traversal", target: `/other/..${path}` },
        { label: "encoded dot-segment traversal", target: `/other/%2e%2e${path}` },
        { label: "backslash authority", target: `/\\attacker${path}` },
        { label: "backslash traversal", target: `/other\\..${path}` },
        { label: "encoded separator", target: `${path}%2Fextra` },
        { label: "raw fragment", target: `${path}#fragment` },
        { label: "query fragment", target: `${path}?delivery=ok#fragment` },
        { label: "invalid percent escape", target: `${path}%ZZ` },
      ];
      const observedRawTargets = [];

      for (const rawTarget of rawTargets) {
        const initialDispatches = handler.mock.calls.length;
        const initialActivity = statusSink.mock.calls.length;
        malformedTargetError = undefined;
        const rawResponse = await sendRawSignedFeishuRequest({
          port,
          target: rawTarget.target,
          rawBody,
          headers,
        });
        observedRawTargets.push({
          label: rawTarget.label,
          statusLine: rawResponse.split("\r\n", 1)[0],
          error: malformedTargetError instanceof Error ? malformedTargetError.message : undefined,
          dispatched: handler.mock.calls.length > initialDispatches,
          publishedActivity: statusSink.mock.calls.length > initialActivity,
        });
      }

      expect(observedRawTargets).toEqual(
        rawTargets.map((rawTarget) => ({
          label: rawTarget.label,
          statusLine: "HTTP/1.1 404 Not Found",
          error: undefined,
          dispatched: false,
          publishedActivity: false,
        })),
      );

      const observed = [];

      for (const request of requests) {
        const initialDispatches = handler.mock.calls.length;
        const initialActivity = statusSink.mock.calls.length;
        const response = await fetch(new URL(request.route, url), {
          method: request.method,
          headers,
          body: rawBody,
        });
        await response.text();
        observed.push({
          label: request.label,
          status: response.status,
          allow: response.headers.get("allow"),
          dispatched: handler.mock.calls.length > initialDispatches,
          publishedActivity: statusSink.mock.calls.length > initialActivity,
        });
      }

      expect(observed).toEqual(
        requests.map((request) => ({
          label: request.label,
          status: request.status,
          allow: request.status === 405 ? "POST" : null,
          dispatched: request.status === 200,
          publishedActivity: request.status === 200,
        })),
      );
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it.each([
    ["root relative", "root", "old-root", "/old-root"],
    ["account relative", "account", "old-account", "/old-account"],
    ["root fragment", "root", "/old#fragment", "/old"],
    ["account relative fragment", "account", "old#fragment", "/old"],
    ["empty fragment", "root", "/old#", "/old"],
    ["query fragment", "account", "old?tenant=alpha#fragment", "/old?tenant=alpha"],
    ["fragment only", "root", "#fragment", "/"],
    ["question inside fragment", "account", "#?", "/"],
    ["query-only fragment", "account", "?tenant=alpha#fragment", "/?tenant=alpha"],
    ["dot segments", "root", "/other/../old", "/old"],
    ["encoded dot segments", "account", "/other/%2e%2e/old", "/old"],
    ["backslash", "root", "/other\\old", "/other/old"],
    ["backslash traversal", "account", "/other\\..\\old", "/old"],
    ["external authority", "root", "//example.com/old#fragment", "/old"],
    ["backslash authority", "account", "/\\example.com/old", "/old"],
    ["absolute HTTPS", "root", "https://example.com/old/?x=1#fragment", "/old/?x=1"],
    ["absolute HTTP", "account", "http://example.com:80/old/", "/old/"],
    ["raw space", "root", "/old path", "/old%20path"],
    ["query space", "account", "/old?name=hello world", "/old?name=hello%20world"],
    ["Unicode", "root", "/café", "/caf%C3%A9"],
    ["Unicode emoji", "account", "/💬", "/%F0%9F%92%AC"],
    ["Unicode query", "account", "/old?name=café", "/old?name=caf%C3%A9"],
    ["tab control", "root", "/old\tpath", "/oldpath"],
    ["CRLF controls", "account", "/old\r\npath", "/oldpath"],
    ["NUL control", "account", "/old\u0000path", "/old%00path"],
    ["encoded hash", "root", "/old%23fragment", "/old%23fragment"],
    ["encoded slash", "account", "/old%2Fnext", "/old%2Fnext"],
    ["encoded backslash", "root", "/old%5Cnext", "/old%5Cnext"],
    ["encoded NUL", "account", "/old%00next", "/old%00next"],
    ["invalid percent escape", "root", "/old%ZZ", "/old%ZZ"],
    ["dangling percent escape", "account", "/old%", "/old%"],
    ["exact empty query", "account", "/old?", "/old?"],
    ["empty query fragment", "root", "/old?#", "/old"],
    ["relative trailing slash", "account", "old/", "/old/"],
    ["canonical trailing slash", "root", "/old/", "/old/"],
    ["empty root", "root", "", "/feishu/events"],
    ["whitespace account", "account", "   ", "/feishu/events"],
  ])(
    "requires Doctor to canonicalize the configured %s before raw webhook admission",
    async (_label, scope, configuredPath, acceptedTarget) => {
      const accountId = `legacy-route-${scope}`;
      const port = await getFreePort();
      const encryptKey = "encrypt_key";
      const config = {
        channels: {
          feishu: {
            ...(scope === "root" ? { webhookPath: configuredPath } : {}),
            accounts: {
              [accountId]: {
                appId: "cli_test",
                appSecret: "secret_test", // pragma: allowlist secret
                connectionMode: "webhook" as const,
                webhookPort: port,
                ...(scope === "account" ? { webhookPath: configuredPath } : {}),
                encryptKey,
                verificationToken: "verify_token",
              },
            },
          },
        },
      };
      const unmigratedAccount = resolveFeishuRuntimeAccount(
        { cfg: config, accountId },
        { requireEventSecrets: true },
      );
      expect(unmigratedAccount.config.webhookPath).toBe(configuredPath);

      const handler = vi.fn(async () => ({ accepted: true }));
      const eventDispatcher = new Lark.EventDispatcher({
        encryptKey,
        verificationToken: "verify_token",
      });
      eventDispatcher.register({ "test.legacy_route_boundary": handler });
      const statusSink = vi.fn();
      const abortController = new AbortController();
      const monitorParams = {
        account: unmigratedAccount,
        accountId,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        abortSignal: abortController.signal,
        eventDispatcher,
        statusSink,
      };
      const needsMigration = configuredPath !== acceptedTarget;
      if (needsMigration) {
        await expect(monitorWebhook(monitorParams)).rejects.toThrow("openclaw doctor --fix");
        expect(httpServers.has(accountId)).toBe(false);
        expect(handler).not.toHaveBeenCalled();
        expect(statusSink).not.toHaveBeenCalled();
      }
      const migrated = normalizeCompatibilityConfig({ cfg: config });
      expect(migrated.changes.some((change) => change.includes(".webhookPath"))).toBe(
        needsMigration,
      );
      const account = resolveFeishuRuntimeAccount(
        { cfg: migrated.config, accountId },
        { requireEventSecrets: true },
      );
      expect(account.config.webhookPath).toBe(acceptedTarget);
      const monitorPromise = monitorWebhook({ ...monitorParams, account });
      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "test.legacy_route_boundary" },
        event: { marker: configuredPath },
      });
      const headers = signFeishuPayload({ encryptKey, rawBody });
      const acceptedPath = acceptedTarget.split("?", 1)[0];
      const rejectedTarget = acceptedTarget.includes("?")
        ? `${acceptedTarget}&wrong=1`
        : acceptedTarget.endsWith("/") && acceptedTarget.length > 1
          ? acceptedTarget.slice(0, -1)
          : `${acceptedTarget}/`;
      const requests = [
        { label: "different raw target", target: rejectedTarget, status: 404 },
        { label: "foreign authority", target: `//attacker${acceptedPath}`, status: 404 },
        { label: "raw fragment", target: `${acceptedTarget}#fragment`, status: 404 },
        { label: "normalized configured target", target: acceptedTarget, status: 200 },
      ];

      try {
        await waitUntilServerReady(`http://127.0.0.1:${port}${acceptedTarget}`);
        statusSink.mockClear();
        const observed = [];

        for (const request of requests) {
          const initialDispatches = handler.mock.calls.length;
          const initialActivity = statusSink.mock.calls.length;
          const rawResponse = await sendRawSignedFeishuRequest({
            port,
            target: request.target,
            rawBody,
            headers,
          });
          observed.push({
            label: request.label,
            statusLine: rawResponse.split("\r\n", 1)[0],
            dispatched: handler.mock.calls.length > initialDispatches,
            publishedActivity: statusSink.mock.calls.length > initialActivity,
          });
        }

        expect(observed).toEqual(
          requests.map((request) => ({
            label: request.label,
            statusLine: `HTTP/1.1 ${request.status} ${request.status === 200 ? "OK" : "Not Found"}`,
            dispatched: request.status === 200,
            publishedActivity: request.status === 200,
          })),
        );
      } finally {
        abortController.abort();
        await monitorPromise;
      }
    },
  );

  it("matches an explicitly configured webhook query exactly", async () => {
    const accountId = "signed-configured-query-boundary";
    const route = "/hook-e2e-configured-query";
    const configuredPath = `${route}?tenant=alpha&mode=exact`;
    const port = await getFreePort();
    const encryptKey = "encrypt_key";
    const handler = vi.fn(async () => ({ accepted: true }));
    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey,
      verificationToken: "verify_token",
    });
    eventDispatcher.register({ "test.query_route_boundary": handler });
    const statusSink = vi.fn();
    const abortController = new AbortController();
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, port, configuredPath),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher,
      statusSink,
    });
    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "test.query_route_boundary" },
      event: { marker: "configured-query-boundary" },
    });
    const headers = signFeishuPayload({ encryptKey, rawBody });
    const requests = [
      { label: "missing query", target: route, method: "POST", status: 404 },
      {
        label: "different query",
        target: `${route}?tenant=other&mode=exact`,
        method: "POST",
        status: 404,
      },
      {
        label: "reordered query",
        target: `${route}?mode=exact&tenant=alpha`,
        method: "POST",
        status: 404,
      },
      {
        label: "additional query",
        target: `${configuredPath}&extra=value`,
        method: "POST",
        status: 404,
      },
      { label: "wrong method", target: configuredPath, method: "PUT", status: 405 },
      { label: "exact configured query", target: configuredPath, method: "POST", status: 200 },
    ];

    try {
      await waitUntilServerReady(`http://127.0.0.1:${port}${configuredPath}`);
      statusSink.mockClear();
      const observed = [];

      for (const request of requests) {
        const initialDispatches = handler.mock.calls.length;
        const initialActivity = statusSink.mock.calls.length;
        const rawResponse = await sendRawSignedFeishuRequest({
          port,
          target: request.target,
          method: request.method,
          rawBody,
          headers,
        });
        observed.push({
          label: request.label,
          statusLine: rawResponse.split("\r\n", 1)[0],
          allow: rawResponse.match(/\r\nallow:\s*([^\r\n]+)/i)?.[1] ?? null,
          dispatched: handler.mock.calls.length > initialDispatches,
          publishedActivity: statusSink.mock.calls.length > initialActivity,
        });
      }

      expect(observed).toEqual(
        requests.map((request) => ({
          label: request.label,
          statusLine: `HTTP/1.1 ${request.status} ${
            request.status === 200
              ? "OK"
              : request.status === 405
                ? "Method Not Allowed"
                : "Not Found"
          }`,
          allow: request.status === 405 ? "POST" : null,
          dispatched: request.status === 200,
          publishedActivity: request.status === 200,
        })),
      );
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("marks durably admitted message acks with the delivery-accepted header", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-durable-ack",
        path: "/hook-e2e-durable-ack",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          schema: "2.0",
          header: { event_type: "im.message.receive_v1", event_id: "evt-durable-ack-1" },
          event: { message: { chat_id: "oc_durable_ack" } },
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      },
    );
  });

  it("acks durable envelopes only after ingress admission resolves", async () => {
    const accountId = "durable-ack-ordering";
    const path = "/hook-e2e-durable-ack-ordering";
    const port = await getFreePort();
    const abortController = new AbortController();
    let releaseAdmission: (() => void) | undefined;
    const invoke = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseAdmission = resolve;
        }),
    );
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, port, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: { invoke } as never,
      invokeWebhookEvent: async () => {
        await invoke();
        return { kind: "durable", value: undefined };
      },
    });

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      await waitUntilServerReady(url);

      const payload = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", event_id: "evt-durable-ack-ordering-1" },
        event: { message: { chat_id: "oc_durable_ack_ordering" } },
      };
      let acceptedResponseReceived = false;
      const acceptedRequest = postSignedPayload(url, payload).then((response) => {
        acceptedResponseReceived = true;
        return response;
      });
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledTimes(1);
      });
      expect(acceptedResponseReceived).toBe(false);
      if (!releaseAdmission) {
        throw new Error("expected pending Feishu durable admission");
      }
      releaseAdmission();

      const accepted = await acceptedRequest;
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
    } finally {
      releaseAdmission?.();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("does not mark acks when durable admission fails", async () => {
    const accountId = "durable-ack-failure";
    const path = "/hook-e2e-durable-ack-failure";
    const port = await getFreePort();
    const abortController = new AbortController();
    const invoke = vi.fn(async () => {
      throw new Error("admission failed");
    });
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, port, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: { invoke } as never,
      invokeWebhookEvent: async () => {
        await invoke();
        return { kind: "durable", value: undefined };
      },
    });

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      await waitUntilServerReady(url);

      const response = await postSignedPayload(url, {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", event_id: "evt-durable-ack-failure-1" },
        event: { message: { chat_id: "oc_durable_ack_failure" } },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("filters prototype-bearing keys without changing the Lark webhook envelope", async () => {
    const accountId = "prototype-guard";
    const path = "/hook-e2e-prototype-guard";
    const port = await getFreePort();
    const encryptKey = "encrypt_key";
    const account = {
      accountId,
      encryptKey,
      verificationToken: "verify_token",
      config: {
        enabled: true,
        connectionMode: "webhook",
        webhookHost: "127.0.0.1",
        webhookPort: port,
        webhookPath: path,
      },
    } as ResolvedFeishuAccount;
    const handler = vi.fn(async () => ({ accepted: true }));
    const dispatcher = new Lark.EventDispatcher({
      encryptKey,
      verificationToken: account.verificationToken,
    });
    dispatcher.register({ "test.prototype_guard": handler });

    let observedEnvelope: Record<string, unknown> | undefined;
    const invoke = dispatcher.invoke.bind(dispatcher);
    const eventDispatcher = {
      invoke: async (data: Record<string, unknown>, params?: { needCheck?: boolean }) => {
        observedEnvelope = data;
        return await invoke(data, params);
      },
    } as Lark.EventDispatcher;
    const abortController = new AbortController();
    const monitorPromise = monitorWebhook({
      account,
      accountId,
      abortSignal: abortController.signal,
      eventDispatcher,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const url = `http://127.0.0.1:${port}${path}`;
    await waitUntilServerReady(url);

    const rawBody =
      '{"schema":"2.0","header":{"event_type":"test.prototype_guard"},"event":{"safe":"kept"},"headers":{"x-envelope-marker":"forged"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}';
    const headers = {
      ...signFeishuPayload({ encryptKey, rawBody }),
      "x-envelope-marker": "preserved",
    };

    try {
      const response = await fetch(url, { method: "POST", headers, body: rawBody });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(observedEnvelope).toBeDefined();
      if (!observedEnvelope) {
        throw new Error("expected Lark webhook envelope");
      }
      const envelopePrototype = Object.getPrototypeOf(observedEnvelope) as Record<string, unknown>;
      expect(Object.hasOwn(observedEnvelope, "headers")).toBe(false);
      expect(Object.hasOwn(envelopePrototype, "headers")).toBe(true);
      expect(
        (observedEnvelope.headers as Record<string, string | string[] | undefined>)[
          "x-envelope-marker"
        ],
      ).toBe("preserved");
      expect(observedEnvelope.event).toEqual({ safe: "kept" });
      expect(observedEnvelope.polluted).toBeUndefined();
      expect(Object.hasOwn(observedEnvelope, "__proto__")).toBe(false);
      expect(Object.hasOwn(observedEnvelope, "constructor")).toBe(false);
      expect(Object.hasOwn(observedEnvelope, "prototype")).toBe(false);
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("does not emit unhandled-event warning for bot_p2p_chat_entered_v1", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "p2p-chat-entered",
        path: "/hook-e2e-p2p-chat-entered",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          schema: "2.0",
          header: { event_type: "im.chat.access_event.bot_p2p_chat_entered_v1" },
          event: {},
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).not.toContain("no im.chat.access_event.bot_p2p_chat_entered_v1 event handle");
      },
    );
  });

  it("accepts signed encrypted url_verification challenges end-to-end", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "encrypted-challenge",
        path: "/hook-e2e-encrypted-challenge",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          encrypt: encryptFeishuPayload("encrypt_key", {
            type: "url_verification",
            challenge: "encrypted-challenge-token",
          }),
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          challenge: "encrypted-challenge-token",
        });
      },
    );
  });
});
