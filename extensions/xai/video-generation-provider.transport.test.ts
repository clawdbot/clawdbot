// xAI transport proof covers real provider HTTP request-policy forwarding.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    apiKey: "local-xai-key",
    source: "profile",
    mode: "api-key",
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

async function buildTransportProofProvider() {
  vi.resetModules();
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.doMock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
    resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  }));
  const { buildXaiVideoGenerationProvider } = await import("./video-generation-provider.js");
  return buildXaiVideoGenerationProvider();
}

type CapturedRequest = {
  body: string;
  headers: IncomingMessage["headers"];
  method?: string;
  url?: string;
};

const openServers: Server[] = [];

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, payload: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function writeVideo(response: ServerResponse) {
  response.writeHead(200, { "content-type": "video/mp4" });
  response.end(Buffer.from("mp4"));
}

async function startXaiVideoServer(): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  let videoUrl = "";
  const server = createServer((request, response) => {
    void (async () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readRequestBody(request),
      });
      if (request.method === "POST" && request.url === "/v1/videos/generations") {
        writeJson(response, { request_id: "local_request" });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/videos/local_request") {
        writeJson(response, {
          request_id: "local_request",
          status: "done",
          video: { url: videoUrl },
        });
        return;
      }
      if (request.method === "GET" && request.url === "/media/generated.mp4") {
        writeVideo(response);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  videoUrl = `${origin}/media/generated.mp4`;
  return {
    baseUrl: `${origin}/v1`,
    requests,
  };
}

async function closeOpenServers() {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
}

describe("xai video generation provider transport", () => {
  afterEach(async () => {
    await closeOpenServers();
  });

  it("uses configured policy for xAI API requests without leaking headers to video downloads", async () => {
    const server = await startXaiVideoServer();
    const provider = await buildTransportProofProvider();

    const result = await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "transport proof",
      cfg: {
        models: {
          providers: {
            xai: {
              baseUrl: server.baseUrl,
              request: {
                allowPrivateNetwork: true,
                headers: { "X-Xai-Trace": "transport-proof" },
              },
            },
          },
        },
      } as never,
    });

    expect(result.videos[0]?.buffer).toEqual(Buffer.from("mp4"));
    expect(server.requests).toHaveLength(3);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/videos/generations",
    });
    expect(server.requests[0]?.headers.authorization).toBe("Bearer local-xai-key");
    expect(server.requests[0]?.headers["x-xai-trace"]).toBe("transport-proof");
    expect(JSON.parse(server.requests[0]?.body ?? "{}")).toMatchObject({
      model: "grok-imagine-video",
      prompt: "transport proof",
    });
    expect(server.requests[1]).toMatchObject({
      method: "GET",
      url: "/v1/videos/local_request",
    });
    expect(server.requests[1]?.headers.authorization).toBe("Bearer local-xai-key");
    expect(server.requests[1]?.headers["x-xai-trace"]).toBe("transport-proof");
    expect(server.requests[2]).toMatchObject({
      method: "GET",
      url: "/media/generated.mp4",
    });
    expect(server.requests[2]?.headers.authorization).toBeUndefined();
    expect(server.requests[2]?.headers["x-xai-trace"]).toBeUndefined();
  });

  it.each([
    ["default", undefined],
    ["explicit false", { allowPrivateNetwork: false }],
  ] as const)(
    "blocks %s loopback xAI video requests before reaching the server",
    async (policyName, requestPolicy) => {
      const server = await startXaiVideoServer();
      const provider = await buildTransportProofProvider();

      await expect(
        provider.generateVideo({
          provider: "xai",
          model: "grok-imagine-video",
          prompt: `${policyName} policy loopback proof`,
          cfg: {
            models: {
              providers: {
                xai: {
                  baseUrl: server.baseUrl,
                  ...(requestPolicy ? { request: requestPolicy } : {}),
                },
              },
            },
          } as never,
        }),
      ).rejects.toThrow();

      expect(server.requests).toHaveLength(0);
    },
  );
});
