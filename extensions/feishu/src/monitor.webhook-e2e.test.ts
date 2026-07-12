// Feishu tests cover monitor.webhook e2e plugin behavior.
import crypto from "node:crypto";
import type { Server } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  };
});

vi.mock("./runtime.js", () => createFeishuRuntimeMockModule());

import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";
import { httpServers } from "./monitor.state.js";

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

afterEach(async () => {
  await stopFeishuMonitor();
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
        expect(await response.text()).toContain("no unknown.event event handle");
      },
    );
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
