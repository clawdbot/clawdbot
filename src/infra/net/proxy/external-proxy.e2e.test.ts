import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import * as net from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { withTempDir } from "../../../test-helpers/temp-dir.js";
import { createNodeEvalArgs } from "../../../test-utils/node-process.js";
import { resolveSystemBin } from "../../resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir.js";

const CHILD_PROCESS_TIMEOUT_MS = process.env.CI ? 45_000 : 15_000;
const PROBE_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;
const PROXY_TUNNEL_SOCKETS = new WeakMap<Server, Set<Duplex>>();
type DiscordTlsFixture = {
  caPath: string;
  cert: string;
  key: string;
};

function createDiscordTlsFixture(dir: string): DiscordTlsFixture {
  const openssl = resolveSystemBin("openssl");
  if (!openssl) {
    throw new Error("openssl is required to generate proxy TLS test certificates");
  }
  const caKeyPath = join(dir, "ca-key.pem");
  const caCertPath = join(dir, "ca-cert.pem");
  const serverKeyPath = join(dir, "server-key.pem");
  const serverCsrPath = join(dir, "server.csr");
  const serverCertPath = join(dir, "server-cert.pem");
  const extPath = join(dir, "server-ext.cnf");

  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKeyPath,
      "-out",
      caCertPath,
      "-days",
      "1",
      "-subj",
      "/CN=OpenClaw Proxy Test CA",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    openssl,
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      serverKeyPath,
      "-out",
      serverCsrPath,
      "-subj",
      "/CN=discord.com",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(extPath, "subjectAltName=DNS:discord.com\n");
  execFileSync(
    openssl,
    [
      "x509",
      "-req",
      "-in",
      serverCsrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      serverCertPath,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extPath,
    ],
    { stdio: "ignore" },
  );

  return {
    caPath: caCertPath,
    cert: readFileSync(serverCertPath, "utf8"),
    key: readFileSync(serverKeyPath, "utf8"),
  };
}

async function withDiscordTlsFixture<T>(
  run: (fixture: DiscordTlsFixture) => Promise<T>,
): Promise<T> {
  return await withTempDir(
    {
      prefix: "openclaw-discord-tls-",
      parentDir: resolvePreferredOpenClawTmpDir(),
    },
    async (dir) => {
      return await run(createDiscordTlsFixture(dir));
    },
  );
}

async function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server | null): Promise<void> {
  if (server === null || !server.listening) {
    return;
  }
  for (const socket of PROXY_TUNNEL_SOCKETS.get(server) ?? []) {
    socket.destroy();
  }
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

type ConnectTargetOverride = {
  hostname: string;
  port: number;
};

function createTunnelProxy(
  seenConnectTargets: string[],
  connectTargetOverrides: Record<string, ConnectTargetOverride> = {},
): Server {
  const tunnelSockets = new Set<Duplex>();
  const proxy = createServer((req, res) => {
    const target = req.url ?? "";
    seenConnectTargets.push(target);

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("absolute-form proxy URL required");
      return;
    }

    const upstream = httpRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host, connection: "close" },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error");
    });
    req.pipe(upstream);
  });
  PROXY_TUNNEL_SOCKETS.set(proxy, tunnelSockets);

  proxy.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    seenConnectTargets.push(target);

    let targetUrl: URL;
    try {
      targetUrl = new URL(`http://${target}`);
    } catch {
      clientSocket.destroy();
      return;
    }

    const override = connectTargetOverrides[target];
    tunnelSockets.add(clientSocket);
    clientSocket.once("close", () => {
      tunnelSockets.delete(clientSocket);
    });
    const upstream = net.connect(
      override?.port ?? Number(targetUrl.port),
      override?.hostname ?? targetUrl.hostname,
      () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );
    tunnelSockets.add(upstream);
    upstream.once("close", () => {
      tunnelSockets.delete(upstream);
    });

    upstream.on("error", () => {
      if (!clientSocket.destroyed && !clientSocket.writableEnded) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    });
  });

  proxy.on("upgrade", (req, socket) => {
    seenConnectTargets.push(req.url ?? "");
    socket.destroy();
  });

  return proxy;
}

async function runNodeModule(
  source: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, createNodeEvalArgs(source, { imports: ["tsx"] }), {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child process timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, CHILD_PROCESS_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("SSRF external proxy routing", () => {
  let target: Server | null = null;
  let globalFetchTarget: Server | null = null;
  let wsTarget: Server | null = null;
  let gatewayBypassWsTarget: Server | null = null;
  let httpsLikeTarget: Server | null = null;
  let tlsTarget: Server | null = null;
  let proxy: Server | null = null;
  let wss: WebSocketServer | null = null;
  let gatewayBypassWss: WebSocketServer | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!wss) {
        resolve();
        return;
      }
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!gatewayBypassWss) {
        resolve();
        return;
      }
      gatewayBypassWss.close(() => resolve());
    });
    await closeServer(proxy);
    await closeServer(tlsTarget);
    await closeServer(httpsLikeTarget);
    await closeServer(gatewayBypassWsTarget);
    await closeServer(wsTarget);
    await closeServer(globalFetchTarget);
    await closeServer(target);
    gatewayBypassWss = null;
    wss = null;
    proxy = null;
    tlsTarget = null;
    httpsLikeTarget = null;
    gatewayBypassWsTarget = null;
    wsTarget = null;
    globalFetchTarget = null;
    target = null;
  });

  it("routes normal HTTP and WebSocket egress through an operator-managed proxy even when NO_PROXY includes loopback", async () => {
    target = createServer((_req, res) => {
      res.writeHead(218, { "content-type": "text/plain" });
      res.end("from loopback target");
    });
    globalFetchTarget = createServer((_req, res) => {
      res.writeHead(219, { "content-type": "text/plain" });
      res.end("from global fetch target");
    });
    wsTarget = createServer();
    wss = new WebSocketServer({ server: wsTarget });
    wss.on("connection", (ws) => {
      ws.close(1000, "done");
    });
    gatewayBypassWsTarget = createServer();
    gatewayBypassWss = new WebSocketServer({ server: gatewayBypassWsTarget });
    gatewayBypassWss.on("connection", (ws) => {
      ws.close(1000, "done");
    });
    const targetPort = await listenOnLoopback(target);
    const globalFetchTargetPort = await listenOnLoopback(globalFetchTarget);
    const wsTargetPort = await listenOnLoopback(wsTarget);
    const gatewayBypassWsTargetPort = await listenOnLoopback(gatewayBypassWsTarget);

    httpsLikeTarget = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("plain target for https CONNECT proof");
    });
    const httpsLikeTargetPort = await listenOnLoopback(httpsLikeTarget);

    const seenConnectTargets: string[] = [];
    proxy = createTunnelProxy(seenConnectTargets);
    const proxyPort = await listenOnLoopback(proxy);

    const child = await runNodeModule(
      `
        import http from "node:http";
        import https from "node:https";
        import { fetch as undiciFetch } from "undici";
        import { WebSocket } from "ws";
        import { startProxy, stopProxy } from "./src/infra/net/proxy/proxy-lifecycle.ts";
        import { registerManagedProxyGatewayLoopbackBypass } from "./src/infra/net/proxy/proxy-lifecycle.ts";

        async function nodeHttpGet(url, options = {}) {
          return new Promise((resolve, reject) => {
            const req = http.get(url, options, (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => {
                resolve({ status: response.statusCode, body });
              });
            });
            req.setTimeout(${PROBE_TIMEOUT_MS}, () => {
              req.destroy(new Error("node:http request timed out"));
            });
            req.on("error", reject);
          });
        }

        async function expectFailure(label, run) {
          try {
            await run();
          } catch {
            return;
          }
          throw new Error(label + " unexpectedly succeeded");
        }

        async function nodeHttpsProbe(url) {
          return new Promise((resolve, reject) => {
            const req = https.get(url, { rejectUnauthorized: false }, (response) => {
              response.resume();
              response.on("end", resolve);
            });
            req.setTimeout(${PROBE_TIMEOUT_MS}, () => {
              req.destroy(new Error("node:https request timed out"));
            });
            req.on("error", reject);
          });
        }

        async function websocketProbe(url) {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, { handshakeTimeout: ${PROBE_TIMEOUT_MS} });
            ws.once("open", () => {
              ws.close();
              resolve();
            });
            ws.once("error", reject);
          });
        }

        async function gatewayLoopbackBypassProbe(url) {
          return new Promise((resolve, reject) => {
            const unregister = registerManagedProxyGatewayLoopbackBypass(url);
            const ws = new WebSocket(url, { handshakeTimeout: ${PROBE_TIMEOUT_MS} });
            const cleanup = () => unregister?.();
            ws.once("open", () => {
              ws.close();
              cleanup();
              resolve();
            });
            ws.once("error", (err) => {
              cleanup();
              reject(err);
            });
          });
        }

        const handle = await startProxy({ enabled: true });
        if (handle === null) {
          throw new Error("expected external proxy routing to start");
        }
        try {
          const response = await undiciFetch(process.env.OPENCLAW_TEST_TARGET_URL, {
            signal: AbortSignal.timeout(${PROBE_TIMEOUT_MS}),
          });
          const body = await response.text();
          const globalFetchResponse = await fetch(process.env.OPENCLAW_TEST_GLOBAL_FETCH_TARGET_URL, {
            signal: AbortSignal.timeout(${PROBE_TIMEOUT_MS}),
          });
          const globalFetchBody = await globalFetchResponse.text();
          const nodeHttp = await nodeHttpGet(process.env.OPENCLAW_TEST_NODE_HTTP_TARGET_URL);
          const explicitAgent = await nodeHttpGet(process.env.OPENCLAW_TEST_EXPLICIT_AGENT_TARGET_URL, {
            agent: new http.Agent(),
          });
          await expectFailure("node:https", () =>
            nodeHttpsProbe(process.env.OPENCLAW_TEST_NODE_HTTPS_TARGET_URL),
          );
          await websocketProbe(process.env.OPENCLAW_TEST_WS_TARGET_URL);
          await gatewayLoopbackBypassProbe(process.env.OPENCLAW_TEST_GATEWAY_BYPASS_WS_URL);
          await expectFailure("non-loopback bypass", () =>
            gatewayLoopbackBypassProbe("wss://gateway.example.com/socket"),
          );
          console.log(JSON.stringify({
            fetch: { status: response.status, body },
            globalFetch: { status: globalFetchResponse.status, body: globalFetchBody },
            nodeHttp,
            explicitAgent,
          }));
        } finally {
          await stopProxy(handle);
        }
      `,
      {
        ...process.env,
        OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
        OPENCLAW_TEST_TARGET_URL: `http://127.0.0.1:${targetPort}/private-metadata`,
        OPENCLAW_TEST_GLOBAL_FETCH_TARGET_URL: `http://127.0.0.1:${globalFetchTargetPort}/global-fetch-metadata`,
        OPENCLAW_TEST_NODE_HTTP_TARGET_URL: `http://127.0.0.1:${targetPort}/node-http-metadata`,
        OPENCLAW_TEST_EXPLICIT_AGENT_TARGET_URL: `http://127.0.0.1:${targetPort}/explicit-agent`,
        OPENCLAW_TEST_NODE_HTTPS_TARGET_URL: `https://127.0.0.1:${httpsLikeTargetPort}/https-connect-proof`,
        OPENCLAW_TEST_WS_TARGET_URL: `ws://127.0.0.1:${wsTargetPort}/websocket-proxied`,
        OPENCLAW_TEST_GATEWAY_BYPASS_WS_URL: `ws://127.0.0.1:${gatewayBypassWsTargetPort}/gateway-bypass`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "localhost",
      },
    );

    expect(child.stderr).toBe("");
    expect(child.code).toBe(0);
    expect(child.stdout).toContain('"fetch":{"status":218');
    expect(child.stdout).toContain('"globalFetch":{"status":219');
    expect(child.stdout).toContain('"nodeHttp":{"status":218');
    expect(child.stdout).toContain('"explicitAgent":{"status":218');
    expect(child.stdout).toContain('"body":"from loopback target"');
    expect(seenConnectTargets).toContain(`127.0.0.1:${wsTargetPort}`);
    expect(seenConnectTargets).toContain(`127.0.0.1:${httpsLikeTargetPort}`);
    expect(seenConnectTargets).toContain(`127.0.0.1:${targetPort}`);
    expect(seenConnectTargets).toContain(`127.0.0.1:${globalFetchTargetPort}`);
    expect(seenConnectTargets).toContain(`http://127.0.0.1:${targetPort}/node-http-metadata`);
    expect(seenConnectTargets).toContain(`http://127.0.0.1:${targetPort}/explicit-agent`);
    expect(seenConnectTargets).not.toContain(`127.0.0.1:${gatewayBypassWsTargetPort}`);
  });

  it("preserves the target TLS hostname for Node HTTPS requests through the managed proxy", async () => {
    await withDiscordTlsFixture(async (tlsFixture) => {
      tlsTarget = createHttpsServer({ key: tlsFixture.key, cert: tlsFixture.cert }, (_req, res) => {
        res.writeHead(209, { "content-type": "text/plain" });
        res.end("discord target tls ok");
      });
      const tlsTargetPort = await listenOnLoopback(tlsTarget);

      const seenConnectTargets: string[] = [];
      proxy = createTunnelProxy(seenConnectTargets, {
        [`discord.com:${tlsTargetPort}`]: { hostname: "127.0.0.1", port: tlsTargetPort },
      });
      const proxyPort = await listenOnLoopback(proxy);

      const child = await runNodeModule(
        `
        import https from "node:https";
        import { startProxy, stopProxy } from "./src/infra/net/proxy/proxy-lifecycle.ts";

        async function nodeHttpsGet(url) {
          return new Promise((resolve, reject) => {
            const req = https.get(url, (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => {
                resolve({ status: response.statusCode, body });
              });
            });
            req.setTimeout(${PROBE_TIMEOUT_MS}, () => {
              req.destroy(new Error("node:https request timed out"));
            });
            req.on("error", reject);
          });
        }

        const handle = await startProxy({ enabled: true });
        if (handle === null) {
          throw new Error("expected external proxy routing to start");
        }
        try {
          const response = await nodeHttpsGet(process.env.OPENCLAW_TEST_DISCORD_TLS_URL);
          console.log(JSON.stringify(response));
        } finally {
          await stopProxy(handle);
        }
      `,
        {
          ...process.env,
          NODE_EXTRA_CA_CERTS: tlsFixture.caPath,
          OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
          OPENCLAW_TEST_DISCORD_TLS_URL: `https://discord.com:${tlsTargetPort}/tls-proxy-proof`,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "localhost",
        },
      );

      expect(child.stderr).toBe("");
      expect(child.code).toBe(0);
      expect(child.stdout).toContain('"status":209');
      expect(child.stdout).toContain('"body":"discord target tls ok"');
      expect(seenConnectTargets).toContain(`discord.com:${tlsTargetPort}`);
    });
  });
});
