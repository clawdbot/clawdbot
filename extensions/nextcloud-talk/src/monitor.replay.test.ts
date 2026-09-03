// Nextcloud Talk tests cover monitor.replay plugin behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMockIncomingRequest, postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createNextcloudTalkWebhookServer as createRawNextcloudTalkWebhookServer } from "./monitor.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundMessage, NextcloudTalkWebhookServerOptions } from "./types.js";
import { inspectNextcloudTalkWebhookEnvelope } from "./webhook-spool-state.js";

type TestWebhookServerOptions = Omit<NextcloudTalkWebhookServerOptions, "onWebhook"> & {
  onMessage: (rawBody: string) => void | Promise<void>;
};

function createNextcloudTalkWebhookServer(options: TestWebhookServerOptions) {
  const { onMessage, ...serverOptions } = options;
  return createRawNextcloudTalkWebhookServer({
    ...serverOptions,
    onWebhook: async (rawBody) => {
      await onMessage(rawBody);
      return "accepted";
    },
  });
}

async function invokeWebhookRequestListener(params: {
  listener: (req: IncomingMessage, res: ServerResponse) => void;
  path: string;
  body: string;
  headers: Record<string, string>;
  remoteAddress: string;
}) {
  const req = Object.assign(createMockIncomingRequest([params.body]), {
    method: "POST",
    url: params.path,
    headers: params.headers,
  });
  Object.defineProperty(req.socket, "remoteAddress", { value: params.remoteAddress });

  return await new Promise<{ body: string; status: number }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      setHeader() {
        return this;
      },
      end(body?: string) {
        resolve({ body: body ?? "", status });
        return this;
      },
    };
    params.listener(req, res as unknown as ServerResponse);
  });
}

describe("createNextcloudTalkWebhookServer auth order", () => {
  it("closes when abort races with listener startup", async () => {
    const abortController = new AbortController();
    const webhook = createRawNextcloudTalkWebhookServer({
      host: "127.0.0.1",
      port: 0,
      path: "/nextcloud-abort-startup",
      secret: "test-secret",
      onWebhook: async () => "accepted",
      abortSignal: abortController.signal,
    });

    const starting = webhook.start();
    abortController.abort();
    await starting;

    expect(webhook.server.listening).toBe(false);
    await webhook.stop();
  });

  it("rejects missing signature headers before reading request body", async () => {
    const readBody = vi.fn(async () => {
      throw new Error("should not be called for missing signature headers");
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-order",
      maxBodyBytes: 128,
      readBody,
      onMessage: vi.fn(),
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing signature headers" });
    expect(readBody).not.toHaveBeenCalled();
  });
});

describe("createNextcloudTalkWebhookServer backend allowlist", () => {
  it("rejects requests from unexpected backend origins", async () => {
    const onMessage = vi.fn(async () => {});
    const harness = await startWebhookServer({
      path: "/nextcloud-backend-check",
      isBackendAllowed: (backend) => backend === "https://nextcloud.expected",
      onMessage,
    });

    const { body, headers } = createSignedCreateMessageRequest({
      backend: "https://nextcloud.unexpected",
    });
    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid backend" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("Nextcloud Talk replay identity fixture", () => {
  function buildInboundMessage(): NextcloudTalkInboundMessage {
    return {
      messageId: "msg-1",
      roomToken: "room-token",
      roomName: "Room 1",
      senderId: "alice",
      senderName: "Alice",
      text: "hello",
      mediaType: "text/plain",
      timestamp: 1_700_000_000_000,
      isGroupChat: true,
    };
  }

  it("keeps the retired guard identity fields represented", () => {
    const message = buildInboundMessage();
    const rawBody = JSON.stringify({
      type: "Create",
      actor: { type: "Person", id: message.senderId, name: message.senderName },
      object: {
        type: "Note",
        id: message.messageId,
        name: message.text,
        content: message.text,
        mediaType: message.mediaType,
      },
      target: { type: "Collection", id: message.roomToken, name: message.roomName },
    });
    expect(inspectNextcloudTalkWebhookEnvelope(rawBody)).toEqual({
      eventId: message.messageId,
      laneKey: `room:${message.roomToken}`,
    });
  });
});

describe("createNextcloudTalkWebhookServer payload validation", () => {
  it("acknowledges signed non-message Create events instead of rejecting them", async () => {
    const payload = {
      type: "Create",
      actor: { type: "Person", id: "alice", name: "Alice" },
      object: {
        type: "Document",
        id: "file-1",
        name: "report.pdf",
        content: "",
        mediaType: "application/pdf",
      },
      target: { type: "Collection", id: "room-1", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret", // pragma: allowlist secret
    });
    const onMessage = vi.fn();
    const harness = await startWebhookServer({
      path: "/nextcloud-non-message-event",
      onMessage,
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    // Driven over a raw socket rather than fetch: the server answers while the sender is
    // still uploading and then closes, so both halves of the contract - the status is
    // delivered, and the rejected request does not stay open - have to be observed on the
    // wire. A mocked response records status(413) either way and proves neither half.
    const body = JSON.stringify({ type: "Create", padding: "x".repeat(70 * 1024) });
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret", // pragma: allowlist secret
    });
    const onMessage = vi.fn();
    const harness = await startWebhookServer({
      path: "/nextcloud-oversized-body",
      onMessage,
    });

    const result = await postRawWebhook({
      url: harness.webhookUrl,
      body,
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
    });

    expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
    expect(result.body).toBe(JSON.stringify({ error: "Payload too large" }));
    expect(result.closedByServer).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("acknowledges signed non-Create Talk events instead of rejecting them", async () => {
    const payload = {
      type: "Join",
      actor: { type: "Application", id: "bots/bot-1", name: "Bot" },
      object: { type: "Collection", id: "room-1", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret", // pragma: allowlist secret
    });
    const onMessage = vi.fn();
    const harness = await startWebhookServer({
      path: "/nextcloud-lifecycle-event",
      onMessage,
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("rejects malformed webhook payloads after signature verification", async () => {
    const payload = {
      type: "Create",
      actor: { type: "Person", id: "alice", name: "Alice" },
      object: {
        type: "Note",
        id: "msg-1",
        name: "hello",
        content: "hello",
        mediaType: "text/plain",
      },
      target: { type: "Collection", id: "", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret", // pragma: allowlist secret
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-invalid-payload",
      onMessage: vi.fn(),
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid payload format" });
  });
});

describe("createNextcloudTalkWebhookServer auth rate limiting", () => {
  it("rate limits repeated invalid signature attempts from the same source", async () => {
    const maxRequests = 1;
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-rate-limit",
      authRateLimit: { maxRequests },
      onMessage: vi.fn(),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const invalidHeaders = {
      ...headers,
      "x-nextcloud-talk-signature": "invalid-signature",
    };

    let firstResponse: Response | undefined;
    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= maxRequests; attempt += 1) {
      const response = await fetch(harness.webhookUrl, {
        method: "POST",
        headers: invalidHeaders,
        body,
      });
      if (attempt === 0) {
        firstResponse = response;
      }
      lastResponse = response;
    }

    expect(firstResponse?.status).toBe(401);
    expect(lastResponse?.status).toBe(429);
    expect(await lastResponse?.text()).toBe("Too Many Requests");
  });

  it("isolates failed-auth limits by forwarded client behind a trusted proxy", async () => {
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-rate-limit-trusted-proxy",
      authRateLimit: { maxRequests: 1 },
      trustedProxies: ["127.0.0.1"],
      onMessage: vi.fn(),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const attackerHeaders = {
      ...headers,
      "x-forwarded-for": "198.51.100.10",
      "x-nextcloud-talk-signature": "invalid-signature",
    };

    const firstAttack = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: attackerHeaders,
      body,
    });
    const blockedAttack = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: attackerHeaders,
      body,
    });
    const legitimateDelivery = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: { ...headers, "x-forwarded-for": "198.51.100.11" },
      body,
    });

    expect(firstAttack.status).toBe(401);
    expect(blockedAttack.status).toBe(429);
    expect(legitimateDelivery.status).toBe(200);
  });

  it("keeps unattributed trusted proxies in separate socket buckets", async () => {
    const path = "/nextcloud-auth-rate-limit-proxy-fallback";
    const { server, stop } = createNextcloudTalkWebhookServer({
      host: "127.0.0.1",
      port: 0,
      path,
      secret: "nextcloud-secret", // pragma: allowlist secret
      authRateLimit: { maxRequests: 1 },
      trustedProxies: ["127.0.0.0/8"],
      onMessage: vi.fn(),
    });
    try {
      const listener = server.listeners("request")[0] as
        | ((req: IncomingMessage, res: ServerResponse) => void)
        | undefined;
      if (!listener) {
        throw new Error("expected Nextcloud Talk request listener");
      }
      const { body, headers } = createSignedCreateMessageRequest();
      const invalidHeaders = {
        ...headers,
        "x-nextcloud-talk-signature": "invalid-signature",
      };
      const invoke = (remoteAddress: string, requestHeaders: Record<string, string>) =>
        invokeWebhookRequestListener({
          listener,
          path,
          body,
          headers: requestHeaders,
          remoteAddress,
        });

      const firstAttack = await invoke("127.0.0.2", invalidHeaders);
      const blockedAttack = await invoke("127.0.0.2", invalidHeaders);
      const legitimateDelivery = await invoke("127.0.0.3", headers);

      expect(firstAttack.status).toBe(401);
      expect(blockedAttack.status).toBe(429);
      expect(legitimateDelivery.status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("does not rate limit valid signed webhook bursts from the same source", async () => {
    const maxRequests = 1;
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-rate-limit-valid",
      authRateLimit: { maxRequests },
      onMessage: vi.fn(),
    });
    const { body, headers } = createSignedCreateMessageRequest();

    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= maxRequests; attempt += 1) {
      lastResponse = await fetch(harness.webhookUrl, {
        method: "POST",
        headers,
        body,
      });
    }

    expect(lastResponse?.status).toBe(200);
  });
});
