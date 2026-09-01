import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoardStore } from "../boards/board-store.js";
import { buildBoardWidgetContentSecurityPolicy } from "./board-sandbox.js";
import { boardStore } from "./board-store.js";
import { BoardGatewayUnavailableError, BOARD_HTTP_PATH_PREFIX } from "./board-view-ticket.js";
import { resolveAuthorizedBoardWidgetView } from "./board-widget-view.js";
import { isReadHttpMethod, respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import { sendMethodNotAllowed } from "./http-common.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";

const BOARD_WIDGET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type BoardHttpOptions = {
  resolveGatewayContext?: GatewayContextResolver;
  store?: BoardStore;
  nowMs?: number;
};

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
  if (!isReadHttpMethod(req.method)) {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const path = parseBoardWidgetPath(pathname);
  if (!path) {
    respondNotFound(res);
    return true;
  }
  const ticket = url.searchParams.get("bt");
  if (!ticket) {
    respondPlainText(res, 401, "Unauthorized");
    return true;
  }
  let authorized;
  try {
    authorized = resolveAuthorizedBoardWidgetView(opts.store ?? boardStore, ticket, {
      gatewayContext: opts.resolveGatewayContext?.(),
      nowMs: opts.nowMs,
    });
  } catch (error) {
    if (error instanceof BoardGatewayUnavailableError) {
      respondPlainText(res, 503, "Service Unavailable");
      return true;
    }
    respondPlainText(res, 401, "Unauthorized");
    return true;
  }
  // Ticket claims address stored rows; owned frame routes carry observer identity.
  const routeSessionKey = authorized.agentId
    ? sessionObserverScopeKey(authorized.sessionKey, authorized.agentId)
    : authorized.sessionKey;
  if (routeSessionKey !== path.sessionKey || authorized.name !== path.name) {
    respondPlainText(res, 401, "Unauthorized");
    return true;
  }
  const html = authorized.document.html;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.setHeader(
    "Content-Security-Policy",
    buildBoardWidgetContentSecurityPolicy(authorized.document),
  );
  res.setHeader("Cache-Control", "no-cache");
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}
