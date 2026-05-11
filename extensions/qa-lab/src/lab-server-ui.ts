import { createHash } from "node:crypto";
import fs from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { writeError } from "./bus-server.js";

export function detectContentType(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "text/html; charset=utf-8";
}

export function missingUiHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QA Lab UI Missing</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #f5f7fb; margin: 0; display: grid; place-items: center; min-height: 100vh; }
      main { max-width: 42rem; padding: 2rem; background: #171b22; border: 1px solid #283140; border-radius: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #9ee8d8; }
      h1 { margin-top: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>QA Lab UI not built</h1>
      <p>Build the private debugger bundle, then reload this page.</p>
      <p><code>pnpm qa:lab:build</code></p>
    </main>
  </body>
</html>`;
}

function resolveUiDistDir(overrideDir?: string | null, repoRoot = process.cwd()) {
  if (overrideDir?.trim()) {
    return overrideDir;
  }
  const candidates = [
    path.resolve(repoRoot, "extensions/qa-lab/web/dist"),
    path.resolve(repoRoot, "dist/extensions/qa-lab/web/dist"),
    fileURLToPath(new URL("../web/dist", import.meta.url)),
  ];
  return (
    candidates.find((candidate) => {
      if (!fs.existsSync(candidate)) {
        return false;
      }
      const indexPath = path.join(candidate, "index.html");
      return fs.existsSync(indexPath) && fs.statSync(indexPath).isFile();
    }) ?? candidates[0]
  );
}

function listUiAssetFiles(rootDir: string, currentDir = rootDir): string[] {
  const entries = fs
    .readdirSync(currentDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listUiAssetFiles(rootDir, resolved));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push(path.relative(rootDir, resolved));
  }
  return files;
}

export function resolveUiAssetVersion(overrideDir?: string | null): string | null {
  try {
    const distDir = resolveUiDistDir(overrideDir);
    const indexPath = path.join(distDir, "index.html");
    if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) {
      return null;
    }
    const hash = createHash("sha1");
    for (const relativeFile of listUiAssetFiles(distDir)) {
      hash.update(relativeFile);
      hash.update("\0");
      hash.update(fs.readFileSync(path.join(distDir, relativeFile)));
      hash.update("\0");
    }
    return hash.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

export function resolveAdvertisedBaseUrl(params: {
  bindHost?: string;
  bindPort: number;
  advertiseHost?: string;
  advertisePort?: number;
}) {
  const advertisedHost =
    params.advertiseHost?.trim() ||
    (params.bindHost && params.bindHost !== "0.0.0.0" ? params.bindHost : "127.0.0.1");
  const advertisedPort =
    typeof params.advertisePort === "number" && Number.isFinite(params.advertisePort)
      ? params.advertisePort
      : params.bindPort;
  return `http://${advertisedHost}:${advertisedPort}`;
}

export function isControlUiProxyPath(pathname: string) {
  return pathname === "/control-ui" || pathname.startsWith("/control-ui/");
}

function rewriteControlUiProxyPath(pathname: string, search: string) {
  const stripped = pathname === "/control-ui" ? "/" : pathname.slice("/control-ui".length) || "/";
  return `${stripped}${search}`;
}

function rewriteEmbeddedControlUiHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[] | number | undefined> {
  const rewritten: Record<string, string | string[] | number | undefined> = { ...headers };
  delete rewritten["x-frame-options"];

  const csp = headers["content-security-policy"];
  if (typeof csp === "string") {
    rewritten["content-security-policy"] = csp.includes("frame-ancestors")
      ? csp.replace(/frame-ancestors\s+[^;]+/i, "frame-ancestors 'self'")
      : `${csp}; frame-ancestors 'self'`;
  }

  return rewritten;
}

export async function proxyHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  target: URL;
  pathname: string;
  search: string;
}) {
  const client = params.target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamReq = client(
    {
      protocol: params.target.protocol,
      hostname: params.target.hostname,
      port: params.target.port || (params.target.protocol === "https:" ? 443 : 80),
      method: params.req.method,
      path: rewriteControlUiProxyPath(params.pathname, params.search),
      headers: {
        ...params.req.headers,
        host: params.target.host,
      },
    },
    (upstreamRes) => {
      params.res.writeHead(
        upstreamRes.statusCode ?? 502,
        rewriteEmbeddedControlUiHeaders(upstreamRes.headers),
      );
      upstreamRes.pipe(params.res);
    },
  );

  upstreamReq.on("error", (error) => {
    if (!params.res.headersSent) {
      writeError(params.res, 502, error);
      return;
    }
    params.res.destroy(error);
  });

  if (params.req.method === "GET" || params.req.method === "HEAD") {
    upstreamReq.end();
    return;
  }
  params.req.pipe(upstreamReq);
}

export function proxyUpgradeRequest(params: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: URL;
}) {
  const requestUrl = new URL(params.req.url ?? "/", "http://127.0.0.1");
  const port = Number(params.target.port || (params.target.protocol === "https:" ? 443 : 80));
  const upstream =
    params.target.protocol === "https:"
      ? tls.connect({
          host: params.target.hostname,
          port,
          servername: params.target.hostname,
        })
      : net.connect({
          host: params.target.hostname,
          port,
        });

  const headerLines: string[] = [];
  for (let index = 0; index < params.req.rawHeaders.length; index += 2) {
    const name = params.req.rawHeaders[index];
    const value = params.req.rawHeaders[index + 1] ?? "";
    if (normalizeLowercaseStringOrEmpty(name) === "host") {
      continue;
    }
    headerLines.push(`${name}: ${value}`);
  }

  upstream.once("connect", () => {
    const requestText = [
      `${params.req.method ?? "GET"} ${rewriteControlUiProxyPath(requestUrl.pathname, requestUrl.search)} HTTP/${params.req.httpVersion}`,
      `Host: ${params.target.host}`,
      ...headerLines,
      "",
      "",
    ].join("\r\n");
    upstream.write(requestText);
    if (params.head.length > 0) {
      upstream.write(params.head);
    }
    upstream.pipe(params.socket);
    params.socket.pipe(upstream);
  });

  const closeBoth = () => {
    if (!params.socket.destroyed) {
      params.socket.destroy();
    }
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };

  upstream.on("error", () => {
    if (!params.socket.destroyed) {
      params.socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    closeBoth();
  });
  params.socket.on("error", closeBoth);
  params.socket.on("close", closeBoth);
}

export function tryResolveUiAsset(
  pathname: string,
  overrideDir?: string | null,
  repoRoot = process.cwd(),
): string | null {
  const distDir = resolveUiDistDir(overrideDir, repoRoot);
  if (!fs.existsSync(distDir)) {
    return null;
  }
  const safePath = pathname === "/" ? "/index.html" : pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(safePath);
  } catch {
    return null;
  }
  const candidate = path.resolve(distDir, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const relative = path.relative(distDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  const fallback = path.join(distDir, "index.html");
  return fs.existsSync(fallback) ? fallback : null;
}
