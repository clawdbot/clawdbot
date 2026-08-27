// Product proof for audio media-understanding proxy routing and size preflight.
import fs from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "../../../../extensions/openai/api.js";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

type RequestObservation = {
  body: Buffer;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  remotePort: number | undefined;
  url: string | undefined;
};

type LoopbackServer = {
  server: Server;
  sockets: Set<Socket>;
  url: string;
};

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) {
    return;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function listen(server: Server): Promise<LoopbackServer> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, sockets, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(handle: LoopbackServer): Promise<void> {
  for (const socket of handle.sockets) {
    socket.destroy();
  }
  handle.server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    handle.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function collectRequestBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function withRequestBody(
  request: NodeJS.ReadableStream,
  response: ServerResponse,
  handle: (body: Buffer) => void,
): void {
  void collectRequestBody(request)
    .then(handle)
    .catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
}

async function startProviderServer(observations: RequestObservation[]): Promise<LoopbackServer> {
  return await listen(
    createServer((request, response) => {
      withRequestBody(request, response, (body) => {
        observations.push({
          body,
          headers: request.headers,
          method: request.method,
          remotePort: request.socket.remotePort,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ text: "proxied audio transcript" }));
      });
    }),
  );
}

async function startForwardProxy(
  observations: RequestObservation[],
  upstreamLocalPorts: Set<number>,
): Promise<LoopbackServer> {
  const server = createServer((request, response) => {
    withRequestBody(request, response, (body) => {
      observations.push({
        body,
        headers: request.headers,
        method: request.method,
        remotePort: request.socket.remotePort,
        url: request.url,
      });

      let target: URL;
      try {
        target = new URL(request.url ?? "");
      } catch {
        response.writeHead(400, { connection: "close" });
        response.end("absolute-form proxy URL required");
        return;
      }

      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers: {
            ...request.headers,
            connection: "close",
            host: target.host,
            "x-qa-proxy-hop": "audio-media-understanding",
          },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            ...upstreamResponse.headers,
            connection: "close",
          });
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        response.writeHead(502, { "content-type": "text/plain", connection: "close" });
        response.end(error.message);
      });
      upstream.on("socket", (socket) => {
        const recordPort = () => {
          if (socket.localPort) {
            upstreamLocalPorts.add(socket.localPort);
          }
        };
        if (socket.connecting) {
          socket.once("connect", recordPort);
        } else {
          recordPort();
        }
      });
      upstream.end(body);
    });
  });
  server.on("connect", (request, clientSocket, head) => {
    observations.push({
      body: Buffer.alloc(0),
      headers: request.headers,
      method: request.method,
      remotePort: (clientSocket as Socket).remotePort,
      url: request.url,
    });
    let target: URL;
    try {
      target = new URL(`http://${request.url ?? ""}`);
    } catch {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      if (upstream.localPort) {
        upstreamLocalPorts.add(upstream.localPort);
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
  });
  return await listen(server);
}

function createConfig(providerBaseUrl: string, maxBytes: number): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test",
          baseUrl: providerBaseUrl,
          request: { allowPrivateNetwork: true },
          models: [],
        },
      },
    },
    tools: {
      media: {
        models: [{ provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] }],
        audio: {
          enabled: true,
          maxBytes,
        },
      },
    },
  };
}

async function createAudioContext(
  fileName: string,
  size: number,
): Promise<{
  ctx: MsgContext;
  filePath: string;
  workspaceDir: string;
}> {
  tempRoot ??= await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-qa-")));
  const filePath = path.join(tempRoot, fileName);
  await fs.writeFile(filePath, Buffer.alloc(size, 0x52));
  return {
    ctx: {
      Body: "",
      media: [{ path: filePath, contentType: "audio/wav" }],
    },
    filePath,
    workspaceDir: tempRoot,
  };
}

describe("media.audio-proxy-and-limit-handling", () => {
  it("routes provider audio through the proxy and rejects oversized audio before network IO", async () => {
    const proxyRequests: RequestObservation[] = [];
    const providerRequests: RequestObservation[] = [];
    const proxyUpstreamPorts = new Set<number>();
    const provider = await startProviderServer(providerRequests);
    const proxy = await startForwardProxy(proxyRequests, proxyUpstreamPorts);

    try {
      await withEnvAsync(
        {
          HTTPS_PROXY: proxy.url,
          HTTP_PROXY: proxy.url,
          ALL_PROXY: "",
          https_proxy: proxy.url,
          http_proxy: proxy.url,
          all_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
        },
        async () => {
          const accepted = await createAudioContext("accepted.wav", 2048);
          const acceptedResult = await applyMediaUnderstanding({
            ctx: accepted.ctx,
            cfg: createConfig(`${provider.url}/v1`, 4096),
            workspaceDir: accepted.workspaceDir,
            providers: { openai: openaiMediaUnderstandingProvider },
          });

          const acceptedEvidence = JSON.stringify({
            decisions: acceptedResult.decisions,
            providerRequests: providerRequests.map((request) => ({
              method: request.method,
              remotePort: request.remotePort,
              url: request.url,
            })),
            proxyRequests: proxyRequests.map((request) => ({
              method: request.method,
              url: request.url,
            })),
          });
          expect(acceptedResult.appliedAudio, acceptedEvidence).toBe(true);
          expect(accepted.ctx.Transcript).toBe("proxied audio transcript");
          expect(proxyRequests).toHaveLength(1);
          expect(providerRequests).toHaveLength(1);
          expect(proxyRequests[0]?.method).toBe("CONNECT");
          expect(proxyRequests[0]?.url).toBe(new URL(provider.url).host);
          expect(providerRequests[0]?.method).toBe("POST");
          expect(providerRequests[0]?.url).toBe("/v1/audio/transcriptions");
          expect(providerRequests[0]?.headers["content-type"]).toContain("multipart/form-data");
          expect(providerRequests[0]?.body.toString("utf8")).toContain("gpt-4o-transcribe");
          expect(proxyUpstreamPorts.has(providerRequests[0]?.remotePort ?? -1)).toBe(true);

          proxyRequests.length = 0;
          providerRequests.length = 0;
          proxyUpstreamPorts.clear();

          const oversized = await createAudioContext("oversized.wav", 4097);
          const oversizedResult = await applyMediaUnderstanding({
            ctx: oversized.ctx,
            cfg: createConfig(`${provider.url}/v1`, 4096),
            workspaceDir: oversized.workspaceDir,
            providers: { openai: openaiMediaUnderstandingProvider },
          });

          expect(oversizedResult.appliedAudio).toBe(false);
          expect(JSON.stringify(oversizedResult.decisions)).toContain("exceeds maxBytes 4096");
          expect(proxyRequests).toHaveLength(0);
          expect(providerRequests).toHaveLength(0);
        },
      );
    } finally {
      await closeServer(proxy);
      await closeServer(provider);
    }
  });
});
