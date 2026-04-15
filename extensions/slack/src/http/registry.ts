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

const slackHttpRoutes = new Map<string, SlackHttpRequestHandler>();

export function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void {
  const normalizedPath = normalizeSlackWebhookPath(params.path);
  if (slackHttpRoutes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  slackHttpRoutes.set(normalizedPath, params.handler);
  return () => {
    slackHttpRoutes.delete(normalizedPath);
  };
}

export async function handleSlackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = slackHttpRoutes.get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
