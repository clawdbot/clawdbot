import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

type StreamingProviderServer = {
  baseUrl: string;
  requestedPaths: string[];
  socketClosures: Promise<void>[];
};

const activeServers = new Set<Server>();

async function startStreamingProviderServer(status = 200): Promise<StreamingProviderServer> {
  const requestedPaths: string[] = [];
  const socketClosures: Promise<void>[] = [];
  const server = createServer((request, response) => {
    requestedPaths.push(request.url ?? "");
    socketClosures.push(
      new Promise<void>((resolve) => {
        request.socket.once("close", resolve);
      }),
    );
    response.writeHead(status, { "content-type": "application/json" });
    // Keep the real HTTP response open: the probe needs only its status.
    response.write('{"models":[');
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  activeServers.add(server);
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestedPaths,
    socketClosures,
  };
}

describe("local cron provider preflight HTTP transport", () => {
  beforeEach(() => {
    resetCronModelProviderPreflightCacheForTest();
  });

  afterEach(async () => {
    resetCronModelProviderPreflightCacheForTest();
    const servers = [...activeServers];
    activeServers.clear();
    await Promise.all(
      servers.map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }),
    );
  });

  it.each([
    {
      label: "OpenAI-compatible /models",
      provider: "vllm",
      api: "openai-completions" as const,
      basePath: "/v1",
      expectedPath: "/v1/models",
      status: 401,
    },
    {
      label: "Ollama /api/tags",
      provider: "ollama",
      api: "ollama" as const,
      basePath: "",
      expectedPath: "/api/tags",
      status: 200,
    },
  ])("closes a never-ending $label response", async (scenario) => {
    const server = await startStreamingProviderServer(scenario.status);

    const result = await withTestTimeout(
      preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              [scenario.provider]: {
                api: scenario.api,
                baseUrl: `${server.baseUrl}${scenario.basePath}`,
                models: [],
              },
            },
          },
        },
        provider: scenario.provider,
        model: "streaming-model",
      }),
      2_500,
      `cron ${scenario.label} preflight stalled on a never-ending response body`,
    );

    expect(result).toEqual({ status: "available" });
    expect(server.requestedPaths).toEqual([scenario.expectedPath]);
    expect(server.socketClosures).toHaveLength(1);
    await withTestTimeout(
      Promise.all(server.socketClosures),
      2_500,
      `cron ${scenario.label} preflight left its real HTTP socket open`,
    );
  });

  it("closes every socket during a concurrent burst of streaming probes", async () => {
    const server = await startStreamingProviderServer();
    const probeCount = 24;

    const results = await withTestTimeout(
      Promise.all(
        Array.from({ length: probeCount }, (_, index) =>
          preflightCronModelProvider({
            cfg: {
              models: {
                providers: {
                  vllm: {
                    api: "openai-completions",
                    baseUrl: `${server.baseUrl}/v1/provider-${index}`,
                    models: [],
                  },
                },
              },
            },
            provider: "vllm",
            model: `streaming-model-${index}`,
          }),
        ),
      ),
      5_000,
      "concurrent cron provider preflights stalled on streaming HTTP responses",
    );

    expect(results).toEqual(Array.from({ length: probeCount }, () => ({ status: "available" })));
    expect(server.requestedPaths).toHaveLength(probeCount);
    expect(server.socketClosures).toHaveLength(probeCount);
    await withTestTimeout(
      Promise.all(server.socketClosures),
      5_000,
      "concurrent cron provider preflights left streaming HTTP sockets open",
    );
  });
});
