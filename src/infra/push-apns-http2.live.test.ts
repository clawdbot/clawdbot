import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "./env.js";
import { probeApnsHttp2ReachabilityViaProxy } from "./push-apns-http2.js";

const APNS_SANDBOX_AUTHORITY = "https://api.sandbox.push.apple.com";
const APNS_SANDBOX_HOST = "api.sandbox.push.apple.com";
const APNS_CONNECT_PORT = 443;
const DEFAULT_TIMEOUT_MS = 15_000;

const LIVE =
  (isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST)) &&
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_APNS_REACHABILITY);
const describeLive = LIVE ? describe : describe.skip;

function getLiveTimeoutMs(): number {
  const raw = process.env.OPENCLAW_LIVE_APNS_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`OPENCLAW_LIVE_APNS_TIMEOUT_MS must be a positive number, got ${raw}`);
  }
  return Math.trunc(parsed);
}

function parseConnectTarget(target: string): { hostname: string; port: number } | undefined {
  try {
    const parsed = new URL(`http://${target}`);
    const port = parsed.port ? Number(parsed.port) : APNS_CONNECT_PORT;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return undefined;
    }
    return { hostname: parsed.hostname, port };
  } catch {
    return undefined;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startApnsConnectProxy(): Promise<{ proxyUrl: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });

  server.on("connect", (request, clientSocket, head) => {
    const target = request.url ? parseConnectTarget(request.url) : undefined;
    if (!target || target.hostname !== APNS_SANDBOX_HOST || target.port !== APNS_CONNECT_PORT) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const upstreamSocket = connect(target.port, target.hostname);
    upstreamSocket.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.once("error", () => {
      clientSocket.destroy();
    });
    clientSocket.once("error", () => {
      upstreamSocket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("APNs live CONNECT proxy did not bind to a TCP port");
  }

  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
}

describeLive("APNs HTTP/2 live reachability via CONNECT proxy", () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((server) => closeServer(server)));
  });

  it(
    "receives Apple's 403 response through the HTTP/2 CONNECT tunnel",
    async () => {
      const { proxyUrl, server } = await startApnsConnectProxy();
      servers.push(server);

      const result = await probeApnsHttp2ReachabilityViaProxy({
        authority: APNS_SANDBOX_AUTHORITY,
        proxyUrl,
        timeoutMs: getLiveTimeoutMs(),
      });

      expect(result.status).toBe(403);
      expect(result.body).toContain("InvalidProviderToken");
    },
    getLiveTimeoutMs() + 5_000,
  );
});
