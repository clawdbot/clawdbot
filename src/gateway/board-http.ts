import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoardStore } from "../boards/board-store.js";
import { boardStore } from "./board-store.js";
import { BOARD_HTTP_PATH_PREFIX, verifyBoardViewTicket } from "./board-view-ticket.js";
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
  const claims = ticket ? verifyBoardViewTicket(ticket, { nowMs: opts.nowMs }) : undefined;
  if (!claims || claims.sessionKey !== path.sessionKey || claims.name !== path.name) {
    sendUnauthorized(res);
    return true;
  }
  const document = (opts.store ?? boardStore).readWidgetHtml(path.sessionKey, path.name);
  if (
    !document ||
    !("html" in document) ||
    (document.grantState !== "none" && document.grantState !== "granted") ||
    document.revision !== claims.revision ||
    document.viewGeneration !== claims.viewGeneration
  ) {
    sendUnauthorized(res);
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
  res.setHeader("Cache-Control", "no-cache");
  res.end(document.html);
  return true;
}
