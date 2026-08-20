#!/usr/bin/env -S node --import tsx

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function rewriteTelegramBotApiPath(
  requestPath: string,
  aliasToken: string,
  upstreamToken: string,
): string | undefined {
  const alias = escapeRegExp(aliasToken);
  const methodMatch = new RegExp(`^/bot${alias}/([A-Za-z][A-Za-z0-9_]{0,63})(\\?.*)?$`, "u").exec(
    requestPath,
  );
  if (methodMatch) {
    return `/bot${upstreamToken}/${methodMatch[1]}${methodMatch[2] ?? ""}`;
  }
  const fileMatch = new RegExp(`^/file/bot${alias}/([^?#]+)(\\?.*)?$`, "u").exec(requestPath);
  const filePath = fileMatch?.[1];
  if (filePath && !filePath.split("/").includes("..")) {
    return `/file/bot${upstreamToken}/${filePath}${fileMatch[2] ?? ""}`;
  }
  return undefined;
}

function forwardedHeaders(headers: IncomingMessage["headers"]): http.OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value !== undefined && !hopByHopHeaders.has(name),
    ),
  );
}

export function createTelegramBotApiProxy(params: {
  aliasToken: string;
  upstreamOrigin?: URL;
  upstreamToken: string;
}): http.Server {
  const upstreamOrigin = params.upstreamOrigin ?? new URL("https://api.telegram.org");
  const transport = upstreamOrigin.protocol === "https:" ? https : http;
  return http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const upstreamPath = rewriteTelegramBotApiPath(
      request.url ?? "",
      params.aliasToken,
      params.upstreamToken,
    );
    if (!upstreamPath) {
      response.writeHead(404).end();
      return;
    }
    const upstream = transport.request(
      {
        headers: { ...forwardedHeaders(request.headers), host: upstreamOrigin.host },
        hostname: upstreamOrigin.hostname,
        method: request.method,
        path: upstreamPath,
        port: upstreamOrigin.port || undefined,
        protocol: upstreamOrigin.protocol,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          forwardedHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.setTimeout(90_000, () => upstream.destroy(new Error("Telegram Bot API timed out")));
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
    request.pipe(upstream);
  });
}

function main(): void {
  const server = createTelegramBotApiProxy({
    aliasToken: requiredEnv("TELEGRAM_PROXY_ALIAS_TOKEN"),
    upstreamToken: requiredEnv("TELEGRAM_PROXY_UPSTREAM_TOKEN"),
  });
  server.listen(8080, "0.0.0.0", () => console.log("Telegram Bot API proxy listening"));
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
