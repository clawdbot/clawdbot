// Discord plugin module implements send harness behavior.
import { createServer } from "node:http";
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { vi } from "vitest";
import { RequestClient } from "./internal/discord.js";

type DiscordWebMediaMockFactoryResult = {
  loadWebMedia: MockFn;
  loadWebMediaRaw: MockFn;
};

type DiscordRestFactoryResult = {
  rest: import("./internal/discord.js").RequestClient;
  postMock: MockFn;
  putMock: MockFn;
  getMock: MockFn;
  patchMock: MockFn;
  deleteMock: MockFn;
};

type DiscordLoopbackRequest = {
  body: string;
  contentType: string | undefined;
  method: string | undefined;
  path: string | undefined;
};

export type MockCallSource = Pick<MockFn, "mock">;

const requireRecord = createRequireRecord("object", "expected-label");

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call[argIndex];
}

function requestOptions(source: MockCallSource, callIndex = 0) {
  return requireRecord(
    mockArg(source, callIndex, 1, `request options ${callIndex}`),
    "request options",
  );
}

export function requestPath(source: MockCallSource, callIndex = 0) {
  return mockArg(source, callIndex, 0, `request path ${callIndex}`);
}

export function requestBody(source: MockCallSource, callIndex = 0) {
  return requireRecord(requestOptions(source, callIndex).body, `request body ${callIndex}`);
}

export function timerDelayAt(source: MockCallSource, callIndex = 0) {
  return mockArg(source, callIndex, 1, `timer delay ${callIndex}`);
}

export async function createDiscordLoopbackRest(options?: {
  respond?: (request: DiscordLoopbackRequest) => unknown;
  status?: (request: DiscordLoopbackRequest) => number;
}): Promise<{
  rest: RequestClient;
  requests: DiscordLoopbackRequest[];
  close: () => Promise<void>;
}> {
  const requests: DiscordLoopbackRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", (error) => response.destroy(error));
    request.on("end", () => {
      const received = {
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: request.headers["content-type"],
        method: request.method,
        path: request.url,
      };
      requests.push(received);
      // server.close() does not await the fetch client's deferred keep-alive timer.
      response.writeHead(options?.status?.(received) ?? 200, {
        "Content-Type": "application/json",
        Connection: "close",
      });
      response.end(
        JSON.stringify(
          options?.respond?.(received) ??
            (request.method === "GET"
              ? { id: "789", type: 0 }
              : { id: "loopback-message", channel_id: "789" }),
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Discord loopback server did not bind to a TCP port");
  }
  return {
    rest: new RequestClient("test-token", {
      baseUrl: `http://127.0.0.1:${address.port}`,
      queueRequests: false,
    }),
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

export function discordWebMediaMockFactory(): DiscordWebMediaMockFactoryResult {
  return {
    loadWebMedia: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "photo.jpg",
      contentType: "image/jpeg",
      kind: "image",
    }),
    loadWebMediaRaw: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "asset.png",
      contentType: "image/png",
      kind: "image",
    }),
  };
}

export function makeDiscordRest(): DiscordRestFactoryResult {
  const postMock = vi.fn() as unknown as MockFn;
  const putMock = vi.fn() as unknown as MockFn;
  const getMock = vi.fn() as unknown as MockFn;
  const patchMock = vi.fn() as unknown as MockFn;
  const deleteMock = vi.fn() as unknown as MockFn;

  return {
    rest: {
      post: postMock,
      put: putMock,
      get: getMock,
      patch: patchMock,
      delete: deleteMock,
    } as unknown as import("./internal/discord.js").RequestClient,
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock,
  };
}
