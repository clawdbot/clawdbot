/**
 * Minimal browser route HTTP types.
 *
 * Keeps route modules decoupled from Express-specific request/response types so
 * the same handlers can run through HTTP and in-process dispatch.
 */
/** Request shape consumed by browser route handlers. */
export type BrowserRequest = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body?: unknown;
  /**
   * Optional abort signal for in-process dispatch. This lets callers enforce
   * timeouts and (where supported) cancel long-running operations.
   */
  signal?: AbortSignal;
};

/** Response shape used by browser route handlers. */
export type BrowserResponse = {
  status: (code: number) => BrowserResponse;
  json: (body: unknown) => void;
};

/** Async route handler signature shared by HTTP and in-process dispatch. */
export type BrowserRouteHandler = (
  req: BrowserRequest,
  res: BrowserResponse,
) => void | Promise<void>;

/** Minimal registrar interface implemented by HTTP and test dispatchers. */
export type BrowserRouteRegistrar = {
  get: (path: string, handler: BrowserRouteHandler) => void;
  post: (path: string, handler: BrowserRouteHandler) => void;
  delete: (path: string, handler: BrowserRouteHandler) => void;
};
