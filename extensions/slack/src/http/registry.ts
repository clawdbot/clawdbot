import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeSlackWebhookPath } from "./paths.js";

export { normalizeSlackWebhookPath } from "./paths.js";

export type SlackHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type RegisterSlackHttpHandlerArgs = {
  path?: string | null;
  handler: SlackHttpRequestHandler;
  log?: (message: string) => void;
  accountId?: string;
};

const SLACK_HTTP_ROUTES_GLOBAL_KEY = Symbol.for("openclaw.slack.httpRoutes.v1");

function getSlackHttpRoutes(): Map<string, SlackHttpRequestHandler> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[SLACK_HTTP_ROUTES_GLOBAL_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, SlackHttpRequestHandler>;
  }
  const routes = new Map<string, SlackHttpRequestHandler>();
  globalStore[SLACK_HTTP_ROUTES_GLOBAL_KEY] = routes;
  return routes;
}

export function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void {
  const normalizedPath = normalizeSlackWebhookPath(params.path);
  const routes = getSlackHttpRoutes();
  if (routes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  routes.set(normalizedPath, params.handler);
  return () => {
    getSlackHttpRoutes().delete(normalizedPath);
  };
}

export async function handleSlackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = getSlackHttpRoutes().get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
