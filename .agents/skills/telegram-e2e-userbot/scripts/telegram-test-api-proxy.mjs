#!/usr/bin/env node

import http from "node:http";
import { Readable } from "node:stream";

// grammY supports client.environment="test", but OpenClaw does not expose it
// through Telegram config. Keep this adapter until that runtime seam exists.

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function telegramTestApiPath(pathname) {
  const match = pathname.match(/^((?:\/file)?\/bot[^/]+)(\/.*)$/u);
  if (!match) throw new Error("Telegram Test Server proxy received an invalid Bot API path.");
  return `${match[1]}/test${match[2]}`;
}

function requestHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && key !== "host" && !HOP_BY_HOP_HEADERS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function responseHeaders(headers) {
  const filtered = {};
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key) && key !== "content-encoding" && key !== "content-length") {
      filtered[key] = value;
    }
  }
  return filtered;
}

function telegramApiMethod(pathname) {
  return pathname.match(/^\/bot[^/]+\/([^/?]+)/u)?.[1];
}

export async function startTelegramTestApiProxy({
  host = "127.0.0.1",
  port = 0,
  upstream = "https://api.telegram.org",
  fetchImpl = fetch,
} = {}) {
  let responseHold;
  let heldResponse;
  const upstreamControllers = new Set();
  const holdEvents = [];
  const methodOrdinals = new Map();
  const heldWaiters = new Set();

  const claimResponseHold = (method) => {
    const ordinal = (methodOrdinals.get(method) ?? 0) + 1;
    methodOrdinals.set(method, ordinal);
    if (!responseHold || responseHold.method !== method) return undefined;
    if (responseHold.skip > 0) {
      responseHold.skip -= 1;
      return undefined;
    }
    const event = { method, ordinal, upstreamAcceptedAt: Date.now(), heldAt: Date.now() };
    const release = Promise.withResolvers();
    heldResponse = { event, release };
    responseHold = undefined;
    holdEvents.push(event);
    for (const waiter of heldWaiters) waiter(event);
    heldWaiters.clear();
    return release.promise;
  };

  const server = http.createServer(async (request, response) => {
    const upstreamController = new AbortController();
    upstreamControllers.add(upstreamController);
    const abortUpstream = () => upstreamController.abort();
    request.once("aborted", abortUpstream);
    response.once("close", abortUpstream);
    try {
      const incoming = new URL(request.url || "/", `http://${host}`);
      const upstreamUrl = new URL(upstream);
      upstreamUrl.pathname = telegramTestApiPath(incoming.pathname);
      upstreamUrl.search = incoming.search;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const result = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers: requestHeaders(request.headers),
        ...(hasBody ? { body: request, duplex: "half" } : {}),
        signal: upstreamController.signal,
      });
      const method = telegramApiMethod(incoming.pathname);
      const hold = method ? claimResponseHold(method) : undefined;
      if (hold) {
        const body = result.body ? Buffer.from(await result.arrayBuffer()) : undefined;
        response.writeHead(result.status, responseHeaders(result.headers));
        response.write(" ");
        const heartbeat = setInterval(() => response.write(" "), 30_000);
        heartbeat.unref?.();
        response.once("close", () => {
          if (heldResponse && !heldResponse.event.releasedAt) {
            heldResponse.event.clientClosedAt = Date.now();
          }
        });
        try {
          await hold;
        } finally {
          clearInterval(heartbeat);
        }
        heldResponse.event.releasedAt = Date.now();
        heldResponse = undefined;
        response.end(body);
        return;
      }
      response.writeHead(result.status, responseHeaders(result.headers));
      if (!result.body) {
        response.end();
        return;
      }
      await new Promise((resolve, reject) => {
        const readable = Readable.fromWeb(result.body);
        const cleanup = () => {
          readable.off("error", failed);
          response.off("finish", finished);
          response.off("close", finished);
        };
        const failed = (error) => {
          cleanup();
          reject(error);
        };
        const finished = () => {
          cleanup();
          resolve();
        };
        readable.once("error", failed);
        response.once("finish", finished);
        response.once("close", finished);
        readable.pipe(response);
      });
    } catch {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(
        JSON.stringify({ ok: false, description: "Telegram Test Server proxy failed." }),
      );
    } finally {
      request.off("aborted", abortUpstream);
      response.off("close", abortUpstream);
      upstreamControllers.delete(upstreamController);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Telegram Test Server proxy did not bind a TCP port.");
  }
  return {
    apiRoot: `http://${host}:${address.port}`,
    holdNextResponse({ method, skip = 0 }) {
      if (responseHold || heldResponse) throw new Error("A Telegram API response hold is active.");
      responseHold = { method, skip };
    },
    waitForHeldResponse(method, timeoutMs) {
      if (heldResponse?.event.method === method) return Promise.resolve(heldResponse.event);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          heldWaiters.delete(onHeld);
          reject(new Error(`Timed out waiting for held Telegram ${method} response.`));
        }, timeoutMs);
        const onHeld = (event) => {
          if (event.method !== method) return;
          clearTimeout(timer);
          heldWaiters.delete(onHeld);
          resolve(event);
        };
        heldWaiters.add(onHeld);
      });
    },
    releaseHeldResponse() {
      if (!heldResponse) throw new Error("No Telegram API response is held.");
      const event = heldResponse.event;
      heldResponse.release.resolve();
      return event;
    },
    getResponseHoldEvents: () => holdEvents.map((event) => ({ ...event })),
    close: () => {
      heldResponse?.release.resolve();
      for (const controller of upstreamControllers) controller.abort();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
