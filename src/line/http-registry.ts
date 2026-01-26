import type { IncomingMessage, ServerResponse } from "node:http";

export type LineHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type RegisterLineHttpHandlerArgs = {
  path?: string | null;
  handler: LineHttpRequestHandler;
  log?: (message: string) => void;
  accountId?: string;
};

const lineHttpRoutes = new Map<string, LineHttpRequestHandler>();

export function normalizeLineWebhookPath(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) return "/line/webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function registerLineHttpHandler(params: RegisterLineHttpHandlerArgs): () => void {
  const normalizedPath = normalizeLineWebhookPath(params.path);
  if (lineHttpRoutes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`line: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  lineHttpRoutes.set(normalizedPath, params.handler);
  return () => {
    lineHttpRoutes.delete(normalizedPath);
  };
}

export async function handleLineHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = lineHttpRoutes.get(url.pathname);
  if (!handler) return false;
  await handler(req, res);
  return true;
}
