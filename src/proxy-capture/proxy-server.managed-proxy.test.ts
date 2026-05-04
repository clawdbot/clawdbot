import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDebugProxyDirectUpstreamAllowed, startDebugProxyServer } from "./proxy-server.js";

let testRoot: string | undefined;

async function cleanupTestDirs(): Promise<void> {
  if (!testRoot) {
    return;
  }
  const root = testRoot;
  testRoot = undefined;
  await rm(root, { recursive: true, force: true });
}

async function makeSettings() {
  testRoot = await mkdtemp(join(tmpdir(), "openclaw-debug-proxy-managed-proxy-"));
  return {
    enabled: true,
    required: false,
    dbPath: ":memory:",
    blobDir: join(testRoot, "blobs"),
    certDir: join(testRoot, "certs"),
    sessionId: "debug-proxy-managed-proxy-test",
    sourceProcess: "test",
  };
}

async function connectThroughProxy(proxyUrl: string): Promise<string> {
  const target = new URL(proxyUrl);
  const socket = new Socket();
  let data = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(Number(target.port), target.hostname, resolve);
  });
  socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  await new Promise<void>((resolve) => socket.once("end", resolve));
  socket.destroy();
  return data;
}

async function requestThroughProxy(proxyUrl: string, targetUrl: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  const socket = new Socket();
  let data = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(Number(proxy.port), proxy.hostname, resolve);
  });
  socket.write(`GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
  await new Promise<void>((resolve) => socket.once("end", resolve));
  socket.destroy();
  return data;
}

async function startCanaryOrigin(): Promise<{
  requestCount: () => number;
  stop: () => Promise<void>;
  url: string;
}> {
  let requests = 0;
  const server = createHttpServer((_req, res) => {
    requests += 1;
    res.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    requestCount: () => requests,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}/metadata`,
  };
}

describe("debug proxy managed-proxy direct upstream policy", () => {
  const originalProxyActive = process.env["OPENCLAW_PROXY_ACTIVE"];
  const originalAllowDirect =
    process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"];

  beforeEach(async () => {
    await cleanupTestDirs();
    delete process.env["OPENCLAW_PROXY_ACTIVE"];
    delete process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"];
  });

  afterEach(async () => {
    if (originalProxyActive === undefined) {
      delete process.env["OPENCLAW_PROXY_ACTIVE"];
    } else {
      process.env["OPENCLAW_PROXY_ACTIVE"] = originalProxyActive;
    }
    if (originalAllowDirect === undefined) {
      delete process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"];
    } else {
      process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"] =
        originalAllowDirect;
    }
    await cleanupTestDirs();
  });

  it("allows direct upstreams when managed proxy mode is inactive", () => {
    expect(() => assertDebugProxyDirectUpstreamAllowed()).not.toThrow();
  });

  it("rejects direct upstreams while managed proxy mode is active", () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";

    expect(() => assertDebugProxyDirectUpstreamAllowed()).toThrow(
      /Debug proxy direct upstream forwarding is disabled/,
    );
  });

  it("uses shared truthy parsing for managed proxy mode", () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "true";

    expect(() => assertDebugProxyDirectUpstreamAllowed()).toThrow(
      /Debug proxy direct upstream forwarding is disabled/,
    );
  });

  it("allows direct upstreams with explicit diagnostic override", () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"] = "1";

    expect(() => assertDebugProxyDirectUpstreamAllowed()).not.toThrow();
  });

  it("rejects CONNECT upstreams before opening direct sockets while managed proxy mode is active", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    const server = await startDebugProxyServer({ settings: await makeSettings() });
    try {
      const response = await connectThroughProxy(server.proxyUrl);

      expect(response).toContain("403 Forbidden");
      expect(response).toContain("Connection: close");
      expect(response).toContain("Debug proxy direct upstream forwarding is disabled");
    } finally {
      await server.stop();
    }
  });

  it("rejects absolute-form HTTP proxy requests before opening direct upstreams while managed proxy mode is active", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    const origin = await startCanaryOrigin();
    const server = await startDebugProxyServer({ settings: await makeSettings() });
    try {
      const response = await requestThroughProxy(server.proxyUrl, origin.url);

      expect(response).toContain("403 Forbidden");
      expect(response).toContain("Connection: close");
      expect(response).toContain("Debug proxy direct upstream forwarding is disabled");
      expect(origin.requestCount()).toBe(0);
    } finally {
      await server.stop();
      await origin.stop();
    }
  });
});
