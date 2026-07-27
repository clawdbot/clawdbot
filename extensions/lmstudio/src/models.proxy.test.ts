import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { fetchLmstudioModels } from "./models.fetch.js";

const servers: Server[] = [];
const sockets = new Set<Duplex>();
const proxyEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const savedProxyEnv = new Map<string, string | undefined>();
let originalDispatcher: Dispatcher | undefined;

function trackSocket(socket: Duplex): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  if (originalDispatcher) {
    setGlobalDispatcher(originalDispatcher);
    originalDispatcher = undefined;
  }
  for (const key of proxyEnvKeys) {
    const value = savedProxyEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedProxyEnv.clear();
});

describe("LM Studio model discovery proxy policy", () => {
  it("keeps the configured local catalog direct when HTTP_PROXY is set", async () => {
    for (const key of proxyEnvKeys) {
      savedProxyEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    const targetRequests: Array<{ authorization?: string; url?: string }> = [];
    const target = createServer((req, res) => {
      targetRequests.push({ authorization: req.headers.authorization, url: req.url });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [] }));
    });
    const connects: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket) => {
      connects.push(req.url ?? "");
      trackSocket(socket);
      socket.destroy();
    });
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    originalDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new EnvHttpProxyAgent());

    const result = await fetchLmstudioModels({
      baseUrl: `http://localhost:${targetPort}/v1`,
      apiKey: "local-test-token",
    });

    expect(result).toMatchObject({ reachable: true, status: 200, models: [] });
    expect(connects).toEqual([]);
    expect(targetRequests).toEqual([
      {
        authorization: "Bearer local-test-token",
        url: "/api/v1/models",
      },
    ]);
  });
});
