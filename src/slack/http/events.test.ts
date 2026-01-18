import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createSlackHttpHandler } from "./events.js";

type SignatureFixture = {
  timestamp: string;
  body: string;
  signingSecret: string;
};

const makeSignature = ({ timestamp, body, signingSecret }: SignatureFixture) => {
  const baseString = `v0:${timestamp}:${body}`;
  const digest = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  return `v0=${digest}`;
};

const createRequest = (
  body: string,
  headers: Record<string, string>,
  method = "POST",
) => {
  const req = new PassThrough() as IncomingMessage;
  req.method = method;
  req.headers = headers;
  req.end(body);
  return req;
};

const createResponse = () => {
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  return res;
};

describe("createSlackHttpHandler", () => {
  it("rejects missing signature headers with 401", async () => {
    const handler = createSlackHttpHandler({
      signingSecret: "whispered-secret",
      onEvent: vi.fn(),
    });
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
    const req = createRequest(body, {});
    const res = createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.end).toHaveBeenCalledWith("Unauthorized");
  });

  it("rejects invalid signature with 401", async () => {
    const signingSecret = "whispered-secret";
    const handler = createSlackHttpHandler({
      signingSecret,
      onEvent: vi.fn(),
    });
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = makeSignature({ timestamp, body, signingSecret });
    const invalidSignature =
      signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
    const req = createRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": invalidSignature,
    });
    const res = createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.end).toHaveBeenCalledWith("Unauthorized");
  });

  it("handles URL verification challenge correctly", async () => {
    const signingSecret = "whispered-secret";
    const handler = createSlackHttpHandler({
      signingSecret,
      onEvent: vi.fn(),
    });
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
      token: "verification-token",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = makeSignature({ timestamp, body, signingSecret });
    const req = createRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    });
    const res = createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.end).toHaveBeenCalledWith("challenge-token");
  });

  it("acknowledges valid events with 200", async () => {
    const signingSecret = "whispered-secret";
    const onEvent = vi.fn();
    const handler = createSlackHttpHandler({
      signingSecret,
      onEvent,
    });
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = makeSignature({ timestamp, body, signingSecret });
    const req = createRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    });
    const res = createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.end).toHaveBeenCalledWith("OK");
  });

  it("calls onEvent callback asynchronously", async () => {
    const signingSecret = "whispered-secret";
    const onEvent = vi.fn();
    const handler = createSlackHttpHandler({
      signingSecret,
      onEvent,
    });
    const payload = { type: "event_callback", event: { type: "app_mention" } };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = makeSignature({ timestamp, body, signingSecret });
    const req = createRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    });
    const res = createResponse();

    await handler(req, res);

    expect(onEvent).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onEvent).toHaveBeenCalledWith(payload);
  });
});
