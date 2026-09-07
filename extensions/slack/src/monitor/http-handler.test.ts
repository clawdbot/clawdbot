import { createHmac } from "node:crypto";
import { createServer, request, type RequestListener, type Server } from "node:http";
import { HTTPReceiver } from "@slack/bolt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackHttpRequestHandler } from "./http-handler.js";

type TestServer = {
  server: Server;
  port: number;
  requestCount: () => number;
};

type HttpResult = {
  statusCode: number | undefined;
  body: string;
};

type AsyncRequestListener = (...args: Parameters<RequestListener>) => Promise<void> | void;

const servers: Server[] = [];

async function startServer(handler: AsyncRequestListener): Promise<TestServer> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return { server, port: address.port, requestCount: () => requestCount };
}

function slackReceiver(): HTTPReceiver {
  return new HTTPReceiver({
    signingSecret: "test-secret",
    endpoints: "/slack/events",
  });
}

function openChunkedRequest(port: number): ReturnType<typeof request> {
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/slack/events",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "transfer-encoding": "chunked",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=invalid",
    },
  });
  req.on("error", () => {});
  return req;
}

function readResponse(req: ReturnType<typeof request>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    req.once("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.once("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.once("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("createSlackHttpRequestHandler", () => {
  it("rejects an oversized chunked body before Bolt signature verification", async () => {
    const { port } = await startServer(
      createSlackHttpRequestHandler({
        receiver: slackReceiver(),
        accountId: "default",
      }),
    );
    const req = openChunkedRequest(port);
    const response = readResponse(req);

    req.write(Buffer.alloc(768 * 1024, 0x61));
    req.end(Buffer.alloc(768 * 1024, 0x62));

    await expect(response).resolves.toEqual({
      statusCode: 413,
      body: "Payload too large",
    });
  });

  it("rejects a stalled body before Bolt's void listener starts reading", async () => {
    const { port } = await startServer(
      createSlackHttpRequestHandler({
        receiver: slackReceiver(),
        accountId: "default",
      }),
    );
    const req = openChunkedRequest(port);
    const response = readResponse(req);

    req.write("{");

    await expect(response).resolves.toEqual({
      statusCode: 408,
      body: "Request body timeout",
    });
    req.destroy();
  });

  it("preserves Bolt signature verification for requests within the bounds", async () => {
    const { port } = await startServer(
      createSlackHttpRequestHandler({
        receiver: slackReceiver(),
        accountId: "default",
      }),
    );
    const body = JSON.stringify({ type: "url_verification", challenge: "bounded" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", "test-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/slack/events",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });
    const response = readResponse(req);

    req.end(body);

    await expect(response).resolves.toEqual({
      statusCode: 200,
      body: JSON.stringify({ challenge: "bounded" }),
    });
  });

  it("bounds concurrent requests before another pre-auth body read starts", async () => {
    const receiver = { requestListener: vi.fn() };
    const { port, requestCount } = await startServer(
      createSlackHttpRequestHandler({
        receiver,
        accountId: "default",
      }),
    );
    const stalled = Array.from({ length: 8 }, () => openChunkedRequest(port));
    for (const req of stalled) {
      req.write("{");
    }
    await vi.waitFor(() => expect(requestCount()).toBe(8));

    const competing = openChunkedRequest(port);
    const response = readResponse(competing);
    competing.end("{}");

    await expect(response).resolves.toEqual({
      statusCode: 429,
      body: "Too Many Requests",
    });
    expect(receiver.requestListener).not.toHaveBeenCalled();
    for (const req of stalled) {
      req.destroy();
    }
  });
});
