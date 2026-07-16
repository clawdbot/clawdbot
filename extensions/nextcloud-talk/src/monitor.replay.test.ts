// Nextcloud Talk tests cover monitor.replay plugin behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  createNextcloudTalkWebhookServer,
  processNextcloudTalkReplayGuardedMessage,
} from "./monitor.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { createNextcloudTalkReplayGuard } from "./replay-guard.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

async function invokeWebhookServerRequest(params: {
  body: string;
  headers: Record<string, string>;
  maxBodyBytes: number;
}) {
  const { server } = createNextcloudTalkWebhookServer({
    host: "127.0.0.1",
    port: 0,
    path: "/nextcloud-body-limit",
    secret: "nextcloud-secret", // pragma: allowlist secret
    maxBodyBytes: params.maxBodyBytes,
    onMessage: vi.fn(),
  });
  const listener = server.listeners("request")[0] as
    | ((req: IncomingMessage, res: ServerResponse) => void)
    | undefined;
  if (!listener) {
    throw new Error("expected Nextcloud Talk request listener");
  }
  const req = Object.assign(createMockIncomingRequest([params.body]), {
    method: "POST",
    url: "/nextcloud-body-limit",
    headers: params.headers,
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;

  return await new Promise<{ body: string; status: number }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end(body?: string) {
        resolve({ body: body ?? "", status });
        return this;
      },
    };
    listener(req, res as unknown as ServerResponse);
  });
}

describe("createNextcloudTalkWebhookServer auth order", () => {
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

  it("rejects signed payloads over the configured body limit", async () => {
    const { body, headers } = createSignedCreateMessageRequest();

    const response = await invokeWebhookServerRequest({
      body,
      headers,
      maxBodyBytes: 128,
    });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "Payload too large" });
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

describe("createNextcloudTalkWebhookServer replay handling", () => {
  function createReplayGuardedProcess(params: {
    stateDir?: string;
    accountId?: string;
    handleMessage: () => Promise<void>;
  }) {
    const replayGuard = createNextcloudTalkReplayGuard(
      params.stateDir ? { stateDir: params.stateDir } : {},
    );

    return (message: NextcloudTalkInboundMessage) =>
      processNextcloudTalkReplayGuardedMessage({
        replayGuard,
        accountId: params.accountId ?? "acct",
        message,
        handleMessage: params.handleMessage,
      });
  }

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

  it("acknowledges replayed requests and skips onMessage side effects", async () => {
    const seen = new Set<string>();
    const onMessage = vi.fn(async () => {});
    const shouldProcessMessage = vi.fn(async (message: NextcloudTalkInboundMessage) => {
      if (seen.has(message.messageId)) {
        return false;
      }
      seen.add(message.messageId);
      return true;
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-replay",
      shouldProcessMessage,
      onMessage,
    });

    const { body, headers } = createSignedCreateMessageRequest();

    const first = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });
    const second = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(shouldProcessMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps replay committed after a non-retryable replay-guarded processing failure", async () => {
    const visibleSideEffect = vi.fn();
    const handleMessage = vi.fn(async () => {
      visibleSideEffect();
      throw new Error("post-send failure");
    });
    const processMessage = createReplayGuardedProcess({
      handleMessage,
    });
    const message = buildInboundMessage();

    await expect(processMessage(message)).rejects.toThrow("post-send failure");
    await expect(processMessage(message)).resolves.toBe("duplicate");

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(visibleSideEffect).toHaveBeenCalledTimes(1);
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
