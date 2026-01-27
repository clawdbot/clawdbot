import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createLineWebhookMiddleware } from "./webhook.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

const createRes = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    headersSent: false,
  } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

describe("createLineWebhookMiddleware", () => {
  it("parses JSON from raw string body", async () => {
    const onEvents = vi.fn(async () => {});
    const secret = "secret";
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const middleware = createLineWebhookMiddleware({ channelSecret: secret, onEvents });

    const req = {
      headers: { "x-line-signature": sign(rawBody, secret) },
      body: rawBody,
    } as any;
    const res = createRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(onEvents).toHaveBeenCalledWith(expect.objectContaining({ events: expect.any(Array) }));
  });

  it("parses JSON from raw buffer body", async () => {
    const onEvents = vi.fn(async () => {});
    const secret = "secret";
    const rawBody = JSON.stringify({ events: [{ type: "follow" }] });
    const middleware = createLineWebhookMiddleware({ channelSecret: secret, onEvents });

    const req = {
      headers: { "x-line-signature": sign(rawBody, secret) },
      body: Buffer.from(rawBody, "utf-8"),
    } as any;
    const res = createRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(onEvents).toHaveBeenCalledWith(expect.objectContaining({ events: expect.any(Array) }));
  });

  it("rejects invalid JSON payloads", async () => {
    const onEvents = vi.fn(async () => {});
    const secret = "secret";
    const rawBody = "not json";
    const middleware = createLineWebhookMiddleware({ channelSecret: secret, onEvents });

    const req = {
      headers: { "x-line-signature": sign(rawBody, secret) },
      body: rawBody,
    } as any;
    const res = createRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects webhooks with invalid signatures", async () => {
    const onEvents = vi.fn(async () => {});
    const secret = "secret";
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const middleware = createLineWebhookMiddleware({ channelSecret: secret, onEvents });

    const req = {
      headers: { "x-line-signature": "invalid-signature" },
      body: rawBody,
    } as any;
    const res = createRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects webhooks with signatures computed using wrong secret", async () => {
    const onEvents = vi.fn(async () => {});
    const correctSecret = "correct-secret";
    const wrongSecret = "wrong-secret";
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const middleware = createLineWebhookMiddleware({ channelSecret: correctSecret, onEvents });

    const req = {
      headers: { "x-line-signature": sign(rawBody, wrongSecret) },
      body: rawBody,
    } as any;
    const res = createRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(onEvents).not.toHaveBeenCalled();
  });
});
