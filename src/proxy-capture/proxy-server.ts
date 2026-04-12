import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import { URL } from "node:url";
import { ensureDebugProxyCa } from "./ca.js";
import type { DebugProxySettings } from "./env.js";
import { getDebugProxyCaptureStore } from "./store.sqlite.js";

type DebugProxyServerHandle = {
  proxyUrl: string;
  stop: () => Promise<void>;
};

export function parseConnectTarget(rawTarget: string | undefined): {
  hostname: string;
  port: number;
} {
  const trimmed = rawTarget?.trim() ?? "";
  if (!trimmed) {
    return { hostname: "127.0.0.1", port: 443 };
  }

  const bracketedMatch = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketedMatch) {
    const hostname = bracketedMatch[1]?.trim() || "127.0.0.1";
    const port = Number(bracketedMatch[2] || 443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid CONNECT target port");
    }
    return { hostname, port };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === trimmed.length - 1) {
    return { hostname: trimmed, port: 443 };
  }
  const hostname = trimmed.slice(0, lastColon).trim() || "127.0.0.1";
  const portText = trimmed.slice(lastColon + 1).trim();
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid CONNECT target port");
  }
  return { hostname, port };
}

function normalizeTargetUrl(req: IncomingMessage): URL {
  if (req.url?.startsWith("http://") || req.url?.startsWith("https://")) {
    return new URL(req.url);
  }
  const host = req.headers.host ?? "127.0.0.1";
  return new URL(`http://${host}${req.url ?? "/"}`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function startDebugProxyServer(params: {
  host?: string;
  port?: number;
  settings: DebugProxySettings;
}): Promise<DebugProxyServerHandle> {
  await ensureDebugProxyCa(params.settings.certDir);
  const store = getDebugProxyCaptureStore(params.settings.dbPath, params.settings.blobDir);
  const host = params.host?.trim() || "127.0.0.1";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const flowId = randomUUID();
    const target = normalizeTargetUrl(req);
    const body = await readBody(req);
    store.recordEvent({
      sessionId: params.settings.sessionId,
      ts: Date.now(),
      sourceScope: "openclaw",
      sourceProcess: params.settings.sourceProcess,
      protocol: target.protocol === "https:" ? "https" : "http",
      direction: "outbound",
      kind: "request",
      flowId,
      method: req.method,
      host: target.host,
      path: `${target.pathname}${target.search}`,
      headersJson: JSON.stringify(req.headers),
      dataText: body.subarray(0, 8192).toString("utf8"),
    });
    const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(buffer);
          res.write(buffer);
        });
        upstreamRes.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          store.recordEvent({
            sessionId: params.settings.sessionId,
            ts: Date.now(),
            sourceScope: "openclaw",
            sourceProcess: params.settings.sourceProcess,
            protocol: target.protocol === "https:" ? "https" : "http",
            direction: "inbound",
            kind: "response",
            flowId,
            method: req.method,
            host: target.host,
            path: `${target.pathname}${target.search}`,
            status: upstreamRes.statusCode ?? undefined,
            headersJson: JSON.stringify(upstreamRes.headers),
            dataText: responseBody.subarray(0, 8192).toString("utf8"),
          });
          res.end();
        });
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      },
    );
    upstream.on("error", (error) => {
      store.recordEvent({
        sessionId: params.settings.sessionId,
        ts: Date.now(),
        sourceScope: "openclaw",
        sourceProcess: params.settings.sourceProcess,
        protocol: target.protocol === "https:" ? "https" : "http",
        direction: "local",
        kind: "error",
        flowId,
        method: req.method,
        host: target.host,
        path: `${target.pathname}${target.search}`,
        errorText: error.message,
      });
      res.statusCode = 502;
      res.end(error.message);
    });
    if (body.byteLength > 0) {
      upstream.write(body);
    }
    upstream.end();
  });

  server.on("connect", (req, clientSocket, head) => {
    const flowId = randomUUID();
    let hostname = "127.0.0.1";
    let port = 443;
    try {
      const parsed = parseConnectTarget(req.url);
      hostname = parsed.hostname;
      port = parsed.port;
    } catch (error) {
      store.recordEvent({
        sessionId: params.settings.sessionId,
        ts: Date.now(),
        sourceScope: "openclaw",
        sourceProcess: params.settings.sourceProcess,
        protocol: "connect",
        direction: "local",
        kind: "error",
        flowId,
        host: hostname,
        path: req.url ?? "",
        errorText: error instanceof Error ? error.message : String(error),
      });
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    store.recordEvent({
      sessionId: params.settings.sessionId,
      ts: Date.now(),
      sourceScope: "openclaw",
      sourceProcess: params.settings.sourceProcess,
      protocol: "connect",
      direction: "local",
      kind: "connect",
      flowId,
      host: hostname,
      path: req.url ?? "",
      headersJson: JSON.stringify(req.headers),
    });
    const upstreamSocket = net.connect(port, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    upstreamSocket.on("error", (error) => {
      store.recordEvent({
        sessionId: params.settings.sessionId,
        ts: Date.now(),
        sourceScope: "openclaw",
        sourceProcess: params.settings.sourceProcess,
        protocol: "connect",
        direction: "local",
        kind: "error",
        flowId,
        host: hostname,
        path: req.url ?? "",
        errorText: error.message,
      });
      clientSocket.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve debug proxy server address");
  }
  return {
    proxyUrl: `http://${host}:${address.port}`,
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
  };
}
