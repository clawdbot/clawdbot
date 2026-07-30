import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoardStore } from "../boards/board-store.js";
import { buildBoardWidgetContentSecurityPolicy } from "./board-sandbox.js";
import { boardStore } from "./board-store.js";
import { BOARD_HTTP_PATH_PREFIX } from "./board-view-ticket.js";
import { resolveAuthorizedBoardWidgetView } from "./board-widget-view.js";
import { sendMethodNotAllowed } from "./http-common.js";

const BOARD_WIDGET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type BoardHttpOptions = {
  store?: BoardStore;
  nowMs?: number;
};

function sendNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function sendUnauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Unauthorized");
}

function parseBoardWidgetPath(pathname: string): { sessionKey: string; name: string } | undefined {
  const match = /^\/__openclaw__\/board\/([^/]+)\/([^/]+)\/index\.html$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  try {
    const sessionKey = decodeURIComponent(match[1]!);
    const name = decodeURIComponent(match[2]!);
    if (!sessionKey || !BOARD_WIDGET_NAME_PATTERN.test(name)) {
      return undefined;
    }
    return { sessionKey, name };
  } catch {
    return undefined;
  }
}

export function handleBoardHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BoardHttpOptions = {},
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (!pathname.startsWith(BOARD_HTTP_PATH_PREFIX)) {
    return false;
  }
  // The ticket is the authorization boundary. CORS lets a Control UI hosted
  // away from the Gateway fetch the bytes and observe authorization failures.
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }
  const path = parseBoardWidgetPath(pathname);
  if (!path) {
    sendNotFound(res);
    return true;
  }
  const ticket = url.searchParams.get("bt");
  if (!ticket) {
    sendUnauthorized(res);
    return true;
  }
  let authorized;
  try {
    authorized = resolveAuthorizedBoardWidgetView(opts.store ?? boardStore, ticket, {
      nowMs: opts.nowMs,
    });
  } catch {
    sendUnauthorized(res);
    return true;
  }
  if (authorized.sessionKey !== path.sessionKey || authorized.name !== path.name) {
    sendUnauthorized(res);
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    buildBoardWidgetContentSecurityPolicy(authorized.document),
  );
  res.setHeader("Cache-Control", "no-cache");
  res.end(authorized.document.html);
  return true;
}
