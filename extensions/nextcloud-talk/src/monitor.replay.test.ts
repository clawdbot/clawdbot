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

describe("createNextcloudTalkWebhookServer pre-authentication concurrency", () => {
  // The per-request budget bounds one unauthenticated read. Nothing bounded how many ran at
  // once, and the auth limiter cannot: it counts recorded failures, and a caller that never
  // finishes a body never reaches the signature check that records one.
  function holdBodyReads(): {
    readBody: NextcloudTalkWebhookServerOptions["readBody"];
    entered: () => number;
    release: () => void;
  } {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      readBody: async (req) => {
        entered += 1;
        await gate;
        // Read what the caller actually sent once released, so a request that arrives after
        // the gate opens is still verified against its own body.
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks).toString("utf-8");
      },
      entered: () => entered,
      release: () => release(),
    };
  }

  const preAuthHeaders = {
    "content-type": "application/json",
    "x-nextcloud-talk-random": "0".repeat(64),
    "x-nextcloud-talk-signature": "unverified-at-this-point",
    "x-nextcloud-talk-backend": "https://cloud.example.com",
  };

  // Poll for the target rather than for a quiet interval: a loaded runner can leave the
  // count unchanged between two samples while connections are still arriving, which would
  // assert capacity against a half-filled budget.
  async function waitForReaders(entered: () => number, target: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (entered() < target) {
      if (Date.now() >= deadline) {
        throw new Error(`only ${String(entered())} of ${String(target)} pre-auth readers started`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }

  it("answers 503 on the wire once the pre-auth read budget is full", async () => {
    const gate = holdBodyReads();
    const harness = await startWebhookServer({
      path: "/nextcloud-preauth-in-flight",
      readBody: gate.readBody,
      onMessage: vi.fn(),
    });

    // 64 is the cap; hold exactly that many so the next one has to be refused.
    const held = Array.from({ length: 64 }, () =>
      postRawWebhook({
        url: harness.webhookUrl,
        body: "{}",
        idleTimeoutMs: 3_000,
        headers: preAuthHeaders,
      }),
    );
    // Release and drain from a finally: a failed assertion must not leave afterEach waiting
    // on 64 requests that are still parked inside their body read.
    try {
      await waitForReaders(gate.entered, 64);

      const overflow = await postRawWebhook({
        url: harness.webhookUrl,
        body: "{}",
        idleTimeoutMs: 3_000,
        headers: preAuthHeaders,
      });

      expect(overflow.statusLine).toBe("HTTP/1.1 503 Service Unavailable");
      expect(overflow.headers.connection).toBe("close");
      expect(overflow.body).toBe(
        JSON.stringify({ error: "Pre-authentication capacity exhausted" }),
      );
      expect(overflow.closedByServer).toBe(true);
      // The refusal must happen before the read, not after it.
      expect(gate.entered()).toBe(64);
    } finally {
      gate.release();
      await Promise.all(held);
    }
  }, 30_000);

  it("returns an over-limit body's slot, so later deliveries still land", async () => {
    // The 413 answer was moved inside the guarded region so a rejected request keeps its slot
    // until the shared rejection lifecycle has finished answering. Scope: saturating the budget
    // with 413s and then getting a 200 proves the release runs on that path, not that all 64
    // slots returned - one free slot is enough for one delivery. It is all-or-nothing by
    // construction: the release is a single finally with no branch, so the 64 requests either
    // all release or none do. The hold itself is bounded by REJECTION_CLOSE_TIMEOUT_MS, a
    // wall-clock grace in a shared owner, and any assertion that it is still held would have to
    // win a race against that clock on the runner - so it is deliberately not asserted here.
    const oversized = JSON.stringify({ type: "Create", padding: "x".repeat(70 * 1024) });
    const harness = await startWebhookServer({
      path: "/nextcloud-preauth-in-flight-oversized",
      onMessage: vi.fn(),
    });

    const rejected = await Promise.all(
      Array.from({ length: 64 }, () =>
        postRawWebhook({
          url: harness.webhookUrl,
          body: oversized,
          idleTimeoutMs: 3_000,
          headers: { ...preAuthHeaders, "x-nextcloud-talk-signature": "not-checked-yet" },
        }),
      ),
    );
    for (const answer of rejected) {
      expect(answer.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
    }

    // Past the grace, the budget must admit a delivery again.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const delivered = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    expect(delivered.status).toBe(200);
  }, 30_000);

  it("answers a stalled upload with 408 on the wire and does not wedge the route", async () => {
    // The 408 branch was moved into the guarded region alongside 413, so it needs its own
    // trigger rather than inheriting the oversized case's coverage: a body that never
    // arrives, declared but not sent, until the pre-auth read timeout fires.
    //
    // Scope: this holds one request against a budget of 64, so the follow-up 200 shows the
    // route still serves after a timed-out read - it does NOT establish that the timed-out
    // request returned its slot, because 63 were free regardless. The release ordering for
    // this block is covered by the oversized case above, which does saturate the budget;
    // both branches are the same rejectWebhookRequest call in the same position.
    const harness = await startWebhookServer({
      path: "/nextcloud-preauth-in-flight-stalled",
      onMessage: vi.fn(),
    });

    const stalled = await postRawWebhook({
      url: harness.webhookUrl,
      body: "{",
      contentLength: 4096,
      idleTimeoutMs: 15_000,
      headers: { ...preAuthHeaders, "x-nextcloud-talk-signature": "not-checked-yet" },
    });

    expect(stalled.statusLine).toBe("HTTP/1.1 408 Request Timeout");
    expect(stalled.closedByServer).toBe(true);

    // The route still serves after the timeout (see the scope note above).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const delivered = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    expect(delivered.status).toBe(200);
  }, 30_000);

  it("releases the slot a rejected signature took, so later deliveries still land", async () => {
    const gate = holdBodyReads();
    const harness = await startWebhookServer({
      path: "/nextcloud-preauth-in-flight-release",
      readBody: gate.readBody,
      // The 64 held requests all fail their signature check, which is the point: the failure
      // path is where a slot leak would hide. Keep the (separate) failed-auth limiter out of
      // the way so the recovery below measures slot release and nothing else.
      authRateLimit: { maxRequests: 1_000 },
      onMessage: vi.fn(),
    });

    const held = Array.from({ length: 64 }, () =>
      postRawWebhook({
        url: harness.webhookUrl,
        body: "{}",
        idleTimeoutMs: 3_000,
        headers: preAuthHeaders,
      }),
    );
    try {
      await waitForReaders(gate.entered, 64);
    } finally {
      gate.release();
      // Every held request fails its signature check; each must hand its slot back.
      await Promise.all(held);
    }

    const { body, headers } = createSignedCreateMessageRequest();
    const delivered = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    expect(delivered.status).toBe(200);
  }, 30_000);
});
