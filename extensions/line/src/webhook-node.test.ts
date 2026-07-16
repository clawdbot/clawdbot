import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createMockIncomingRequest } from "../../../test/helpers/mock-incoming-request.js";
import { createLineNodeWebhookHandler, readLineWebhookRequestBody } from "./webhook-node.js";
import { createLineWebhookMiddleware } from "./webhook.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

function createRes() {
  const headers: Record<string, string> = {};
  const resObj = {
    statusCode: 0,
    headersSent: false,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: vi.fn((data?: unknown) => {
      resObj.headersSent = true;
      // Keep payload available for assertions
      resObj.body = data;
    }),
    body: undefined as unknown,
  };
  const res = resObj as unknown as ServerResponse & { body?: unknown };
  return { res, headers };
}

const SECRET = "secret";

function createMiddlewareRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    headersSent: false,
  } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function createPostWebhookTestHarness(rawBody: string, secret = "secret") {
  const bot = { handleWebhook: vi.fn(async () => {}) };
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const handler = createLineNodeWebhookHandler({
    channelSecret: secret,
    bot,
    runtime,
    readBody: async () => rawBody,
  });
  return { bot, handler, secret };
}

const runSignedPost = async (params: {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  rawBody: string;
  secret: string;
  res: ServerResponse;
}) =>
  await params.handler(
    {
      method: "POST",
      headers: { "x-line-signature": sign(params.rawBody, params.secret) },
    } as unknown as IncomingMessage,
    params.res,
  );

async function invokeWebhook(params: {
  body: unknown;
  headers?: Record<string, string>;
  onEvents?: ReturnType<typeof vi.fn>;
  autoSign?: boolean;
}) {
  const onEventsMock = params.onEvents ?? vi.fn(async () => {});
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents: onEventsMock as never,
  });

  const headers = { ...params.headers };
  const autoSign = params.autoSign ?? true;
  if (autoSign && !headers["x-line-signature"]) {
    if (typeof params.body === "string") {
      headers["x-line-signature"] = sign(params.body, SECRET);
    } else if (Buffer.isBuffer(params.body)) {
      headers["x-line-signature"] = sign(params.body.toString("utf-8"), SECRET);
    }
  }

  const req = {
    headers,
    body: params.body,
  } as any;
  const res = createMiddlewareRes();
  await middleware(req, res, {} as any);
  return { res, onEvents: onEventsMock };
}

async function expectSignedRawBodyWins(params: { rawBody: string | Buffer; signedUserId: string }) {
  const onEvents = vi.fn(async () => {});
  const reqBody = {
    events: [{ type: "message", source: { userId: "tampered-user" } }],
  };
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents,
  });
  const rawBodyText =
    typeof params.rawBody === "string" ? params.rawBody : params.rawBody.toString("utf-8");
  const req = {
    headers: { "x-line-signature": sign(rawBodyText, SECRET) },
    rawBody: params.rawBody,
    body: reqBody,
  } as any;
  const res = createMiddlewareRes();

  await middleware(req, res, {} as any);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(onEvents).toHaveBeenCalledTimes(1);
  const processedBody = (
    onEvents.mock.calls[0] as unknown as [{ events?: Array<{ source?: { userId?: string } }> }]
  )?.[0];
  expect(processedBody?.events?.[0]?.source?.userId).toBe(params.signedUserId);
  expect(processedBody?.events?.[0]?.source?.userId).not.toBe("tampered-user");
}

describe("createLineNodeWebhookHandler", () => {
  it("returns 200 for GET", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody: async () => "",
    });

    const { res } = createRes();
    await handler({ method: "GET", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("returns 204 for HEAD", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody: async () => "",
    });

    const { res } = createRes();
    await handler({ method: "HEAD", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it("rejects verification-shaped requests without a signature", async () => {
    const rawBody = JSON.stringify({ events: [] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res, headers } = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(headers["content-type"]).toBe("application/json");
    expect(res.body).toBe(JSON.stringify({ error: "Missing X-Line-Signature header" }));
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("accepts signed verification-shaped requests without dispatching events", async () => {
    const rawBody = JSON.stringify({ events: [] });
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res, headers } = createRes();
    await runSignedPost({ handler, rawBody, secret, res });

    expect(res.statusCode).toBe(200);
    expect(headers["content-type"]).toBe("application/json");
    expect(res.body).toBe(JSON.stringify({ status: "ok" }));
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("returns 405 for non-GET/HEAD/POST methods", async () => {
    const { bot, handler } = createPostWebhookTestHarness(JSON.stringify({ events: [] }));

    const { res, headers } = createRes();
    await handler({ method: "PUT", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(405);
    expect(headers.allow).toBe("GET, HEAD, POST");
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects missing signature when events are non-empty", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects unsigned POST requests before reading the body", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const readBody = vi.fn(async () => JSON.stringify({ events: [{ type: "message" }] }));
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody,
    });

    const { res } = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("uses strict pre-auth limits for signed POST requests", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const readBody = vi.fn(async (_req: IncomingMessage, maxBytes: number, timeoutMs?: number) => {
      expect(maxBytes).toBe(64 * 1024);
      expect(timeoutMs).toBe(5_000);
      return rawBody;
    });
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody,
      maxBodyBytes: 1024 * 1024,
    });

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, secret: "secret", res });

    expect(res.statusCode).toBe(200);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid signature", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler(
      { method: "POST", headers: { "x-line-signature": "bad" } } as unknown as IncomingMessage,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("accepts valid signature and dispatches events", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, secret, res });

    expect(res.statusCode).toBe(200);
    expect(bot.handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ events: expect.any(Array) }),
    );
  });

  it("releases authenticated requests before event processing completes", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    let releaseAuthenticated!: () => void;
    const bot = {
      handleWebhook: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            releaseAuthenticated = resolve;
          }),
      ),
    };
    const onRequestAuthenticated = vi.fn();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const handler = createLineNodeWebhookHandler({
      channelSecret: SECRET,
      bot,
      runtime,
      readBody: async () => rawBody,
      onRequestAuthenticated,
    });

    const { res } = createRes();
    const request = runSignedPost({ handler, rawBody, secret: SECRET, res });

    await vi.waitFor(() => {
      expect(onRequestAuthenticated).toHaveBeenCalledTimes(1);
      expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
    });

    expect(res.headersSent).toBe(false);
    releaseAuthenticated();
    await request;

    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when event processing fails and does not acknowledge with 200", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { secret } = createPostWebhookTestHarness(rawBody);
    const failingBot = {
      handleWebhook: vi.fn(async () => {
        throw new Error("transient failure");
      }),
    };
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const failingHandler = createLineNodeWebhookHandler({
      channelSecret: secret,
      bot: failingBot,
      runtime,
      readBody: async () => rawBody,
    });

    const { res } = createRes();
    await runSignedPost({ handler: failingHandler, rawBody, secret, res });

    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(failingBot.handleWebhook).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid JSON payload even when signature is valid", async () => {
    const rawBody = "not json";
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, secret, res });

    expect(res.statusCode).toBe(400);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
});

describe("readLineWebhookRequestBody", () => {
  it("reads body within limit", async () => {
    const req = createMockIncomingRequest(['{"events":[{"type":"message"}]}']);
    const body = await readLineWebhookRequestBody(req, 1024);
    expect(body).toContain('"events"');
  });

  it("rejects oversized body", async () => {
    const req = createMockIncomingRequest(["x".repeat(2048)]);
    await expect(readLineWebhookRequestBody(req, 128)).rejects.toThrow("PayloadTooLarge");
  });
});

describe("createLineWebhookMiddleware", () => {
  it.each([
    ["raw string body", JSON.stringify({ events: [{ type: "message" }] })],
    ["raw buffer body", Buffer.from(JSON.stringify({ events: [{ type: "follow" }] }), "utf-8")],
  ])("parses JSON from %s", async (_label, body) => {
    const { res, onEvents } = await invokeWebhook({ body });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(onEvents).toHaveBeenCalledWith(expect.objectContaining({ events: expect.any(Array) }));
  });

  it("rejects invalid JSON payloads", async () => {
    const { res, onEvents } = await invokeWebhook({ body: "not json" });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects webhooks with invalid signatures", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [{ type: "message" }] }),
      headers: { "x-line-signature": "invalid-signature" },
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects verification-shaped requests without a signature", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [] }),
      headers: {},
      autoSign: false,
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing X-Line-Signature header" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("accepts signed verification-shaped requests without dispatching events", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects oversized signed payloads before JSON parsing", async () => {
    const largeBody = JSON.stringify({ events: [], payload: "x".repeat(70 * 1024) });
    const { res, onEvents } = await invokeWebhook({ body: largeBody });
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: "Payload too large" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects missing signature when events are non-empty", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [{ type: "message" }] }),
      headers: {},
      autoSign: false,
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing X-Line-Signature header" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects signed requests when raw body is missing", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: { events: [{ type: "message" }] },
      headers: { "x-line-signature": "signed" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing raw request body for signature verification",
    });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("uses the signed raw body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: JSON.stringify({
        events: [{ type: "message", source: { userId: "signed-user" } }],
      }),
      signedUserId: "signed-user",
    });
  });

  it("uses signed raw buffer body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: Buffer.from(
        JSON.stringify({
          events: [{ type: "message", source: { userId: "signed-buffer-user" } }],
        }),
        "utf-8",
      ),
      signedUserId: "signed-buffer-user",
    });
  });

  it("rejects invalid signed raw JSON even when req.body is a valid object", async () => {
    const onEvents = vi.fn(async () => {});
    const rawBody = "not-json";
    const middleware = createLineWebhookMiddleware({
      channelSecret: SECRET,
      onEvents,
    });

    const req = {
      headers: { "x-line-signature": sign(rawBody, SECRET) },
      rawBody,
      body: { events: [{ type: "message" }] },
    } as any;
    const res = createMiddlewareRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid webhook payload" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("returns 500 when event processing fails and does not acknowledge with 200", async () => {
    const onEvents = vi.fn(async () => {
      throw new Error("boom");
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const middleware = createLineWebhookMiddleware({
      channelSecret: SECRET,
      onEvents,
      runtime,
    });

    const req = {
      headers: { "x-line-signature": sign(rawBody, SECRET) },
      body: rawBody,
    } as any;
    const res = createMiddlewareRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(runtime.error).toHaveBeenCalled();
  });
});
