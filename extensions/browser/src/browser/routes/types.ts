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

export type BrowserResponse = {
  status: (code: number) => BrowserResponse;
  json: (body: unknown) => void;
};

export type BrowserRouteHandler = (
  req: BrowserRequest,
  res: BrowserResponse,
) => void | Promise<void>;

export type BrowserRouteRegistrar = {
  get: (path: string, handler: BrowserRouteHandler) => void;
  post: (path: string, handler: BrowserRouteHandler) => void;
  delete: (path: string, handler: BrowserRouteHandler) => void;
};
