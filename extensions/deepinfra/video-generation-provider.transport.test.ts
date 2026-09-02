import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { withEnvAsync, withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    apiKey: "test",
    source: "profile",
    mode: "api-key",
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

type CapturedRequest = {
  body: string;
  headers: IncomingMessage["headers"];
  method?: string;
  url?: string;
};

type DestroyableConnection = {
  destroy: () => void;
};

let buildDeepInfraVideoGenerationProvider: typeof import("./video-generation-provider.js").buildDeepInfraVideoGenerationProvider;

beforeAll(async () => {
  vi.resetModules();
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.doMock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
    resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  }));
  ({ buildDeepInfraVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.resetModules();
});

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createDeepInfraHandler(requests: CapturedRequest[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readRequestBody(request),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "local-request",
          status: "succeeded",
          data: [
            {
              url: `data:video/webm;base64,${Buffer.from("local-video").toString("base64")}`,
            },
          ],
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  };
}

async function startConnectProxy(upstreamBaseUrl: string): Promise<{
  connectTargets: string[];
  proxyUrl: string;
  stop: () => Promise<void>;
}> {
  const upstreamUrl = new URL(upstreamBaseUrl);
  const upstreamPort = Number(upstreamUrl.port);
  const connectTargets: string[] = [];
  const sockets = new Set<DestroyableConnection>();
  const server = createServer((_request, response) => {
    response.writeHead(502);
    response.end("CONNECT required");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, clientSocket, head) => {
    connectTargets.push(request.url ?? "");
    const upstreamSocket = connect(upstreamPort, upstreamUrl.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    sockets.add(upstreamSocket);
    upstreamSocket.on("close", () => sockets.delete(upstreamSocket));
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("CONNECT proxy did not bind to a TCP port");
  }
  return {
    connectTargets,
    proxyUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function generateLocalVideo(params: {
  baseUrl: string;
  request?: {
    allowPrivateNetwork?: boolean;
    headers?: Record<string, string>;
    proxy?: { mode: "env-proxy" };
  };
}) {
  const provider = buildDeepInfraVideoGenerationProvider();
  return await provider.generateVideo({
    provider: "deepinfra",
    model: "deepinfra/Pixverse/Pixverse-T2V",
    prompt: "transport proof",
    cfg: {
      models: {
        providers: {
          deepinfra: {
            baseUrl: params.baseUrl,
            models: [],
            ...(params.request ? { request: params.request } : {}),
          },
        },
      },
    } as never,
    timeoutMs: 5_000,
  });
}

describe("deepinfra video generation provider transport", () => {
  it("forwards configured request policy through the real local video transport path", async () => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests), async (baseUrl) => {
      const result = await generateLocalVideo({
        baseUrl: `${baseUrl}/v1/openai`,
        request: {
          allowPrivateNetwork: true,
          headers: { "X-DeepInfra-Trace": "transport-proof" },
        },
      });

      expect(result.videos).toEqual([
        {
          buffer: Buffer.from("local-video"),
          mimeType: "video/webm",
          fileName: "video-1.webm",
        },
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: "/v1/openai/videos",
      });
      expect(requests[0]?.headers["x-deepinfra-trace"]).toBe("transport-proof");
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
        prompt: "transport proof",
      });
    });
  });

  it("routes configured env proxy policy through a real CONNECT tunnel", async () => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests), async (baseUrl) => {
      const proxy = await startConnectProxy(baseUrl);
      try {
        await withEnvAsync(
          {
            HTTP_PROXY: proxy.proxyUrl,
            http_proxy: undefined,
            HTTPS_PROXY: undefined,
            https_proxy: undefined,
            NO_PROXY: undefined,
            no_proxy: undefined,
          },
          async () => {
            await generateLocalVideo({
              baseUrl: `${baseUrl}/v1/openai`,
              request: {
                allowPrivateNetwork: true,
                proxy: { mode: "env-proxy" },
              },
            });
          },
        );

        expect(proxy.connectTargets).toEqual([new URL(baseUrl).host]);
        expect(requests).toHaveLength(1);
      } finally {
        await proxy.stop();
      }
    });
  });

  it.each([
    ["default", undefined],
    ["explicit false", { allowPrivateNetwork: false }],
  ])("blocks loopback before transport with %s private-network policy", async (_label, request) => {
    const requests: CapturedRequest[] = [];
    await withServer(createDeepInfraHandler(requests), async (baseUrl) => {
      await expect(
        generateLocalVideo({
          baseUrl: `${baseUrl}/v1/openai`,
          request,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "SsrFBlockedError",
          message: expect.stringContaining("private/internal/special-use IP address"),
        }),
      );
      expect(requests).toHaveLength(0);
    });
  });
});
