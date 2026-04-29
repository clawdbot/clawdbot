import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const CHILD_PROCESS_TIMEOUT_MS = process.env.CI ? 30_000 : 10_000;

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

function createTunnelProxy(seenConnectTargets: string[]): Server {
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

    const upstream = net.connect(Number(targetUrl.port), targetUrl.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
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
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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
  let httpsLikeTarget: Server | null = null;
  let proxy: Server | null = null;
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!wss) {
        resolve();
        return;
      }
      wss.close(() => resolve());
    });
    await closeServer(proxy);
    await closeServer(httpsLikeTarget);
    await closeServer(target);
    wss = null;
    proxy = null;
    httpsLikeTarget = null;
    target = null;
  });

  it("routes normal HTTP and WebSocket egress through an operator-managed proxy even when NO_PROXY includes loopback", async () => {
    target = createServer((_req, res) => {
      res.writeHead(218, { "content-type": "text/plain" });
      res.end("from loopback target");
    });
    wss = new WebSocketServer({ server: target });
    wss.on("connection", (ws) => {
      ws.close(1000, "done");
    });
    const targetPort = await listenOnLoopback(target);

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
        import { dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane } from "./src/infra/net/proxy/proxy-lifecycle.ts";

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
            req.setTimeout(5000, () => {
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
            req.setTimeout(5000, () => {
              req.destroy(new Error("node:https request timed out"));
            });
            req.on("error", reject);
          });
        }

        async function websocketProbe(url) {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, { handshakeTimeout: 5000 });
            ws.once("open", () => {
              ws.close();
              reject(new Error("proxied websocket unexpectedly opened"));
            });
            ws.once("error", () => resolve());
          });
        }

        async function gatewayLoopbackBypassProbe(url) {
          return new Promise((resolve, reject) => {
            const ws = dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane(url, () =>
              new WebSocket(url, { handshakeTimeout: 5000 }),
            );
            ws.once("open", () => {
              ws.close();
              resolve();
            });
            ws.once("error", reject);
          });
        }

        const handle = await startProxy({ enabled: true });
        if (handle === null) {
          throw new Error("expected external proxy routing to start");
        }
        try {
          const response = await undiciFetch(process.env.OPENCLAW_TEST_TARGET_URL, {
            signal: AbortSignal.timeout(5000),
          });
          const body = await response.text();
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
        OPENCLAW_TEST_NODE_HTTP_TARGET_URL: `http://127.0.0.1:${targetPort}/node-http-metadata`,
        OPENCLAW_TEST_EXPLICIT_AGENT_TARGET_URL: `http://127.0.0.1:${targetPort}/explicit-agent`,
        OPENCLAW_TEST_NODE_HTTPS_TARGET_URL: `https://127.0.0.1:${httpsLikeTargetPort}/https-connect-proof`,
        OPENCLAW_TEST_WS_TARGET_URL: `ws://127.0.0.1:${targetPort}/websocket-proxied`,
        OPENCLAW_TEST_GATEWAY_BYPASS_WS_URL: `ws://127.0.0.1:${targetPort}/gateway-bypass`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "localhost",
        GLOBAL_AGENT_NO_PROXY: "localhost",
      },
    );

    expect(child.stderr).toBe("");
    expect(child.code).toBe(0);
    expect(child.stdout).toContain('"fetch":{"status":218');
    expect(child.stdout).toContain('"nodeHttp":{"status":218');
    expect(child.stdout).toContain('"explicitAgent":{"status":218');
    expect(child.stdout).toContain('"body":"from loopback target"');
    expect(seenConnectTargets).toContain(`127.0.0.1:${targetPort}`);
    expect(seenConnectTargets).toContain(`127.0.0.1:${httpsLikeTargetPort}`);
    expect(seenConnectTargets).toContain(`http://127.0.0.1:${targetPort}/node-http-metadata`);
    expect(seenConnectTargets).toContain(`http://127.0.0.1:${targetPort}/explicit-agent`);
    expect(seenConnectTargets).toContain(`http://127.0.0.1:${targetPort}/websocket-proxied`);
    expect(seenConnectTargets).not.toContain(`http://127.0.0.1:${targetPort}/gateway-bypass`);
  });
});
