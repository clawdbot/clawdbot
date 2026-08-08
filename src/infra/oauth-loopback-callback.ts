import type { LookupAddress } from "node:dns";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

type OAuthLoopbackCallbackResult =
  | { type: "authorization_code"; code: string; state: string }
  | { type: "oauth_error"; error: string; errorDescription?: string };

export type OAuthLoopbackCallbackServer = {
  waitForCallback: () => Promise<OAuthLoopbackCallbackResult>;
  close: () => Promise<void>;
};

type RenderedResponse = { body: string; contentType: string };
type CorsOriginResolver = (originHeader: string | string[] | undefined) => string | undefined;
type LoopbackLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") {
    return true;
  }
  const octets = address.split(".").map(Number);
  return (
    octets.length === 4 && octets[0] === 127 && octets.every((octet) => octet >= 0 && octet <= 255)
  );
}

function resolveLoopbackHostname(
  hostname: string,
  lookupOverride?: LoopbackLookup,
): string[] | Promise<string[]> {
  if (hostname === "127.0.0.1" || hostname === "::1") {
    return [hostname];
  }
  if (hostname !== "localhost") {
    throw new Error("OAuth callback redirect must use localhost, 127.0.0.1, or ::1");
  }
  const loadLookup: Promise<LoopbackLookup> = lookupOverride
    ? Promise.resolve(lookupOverride)
    : import("node:dns/promises").then(({ lookup }) => lookup as LoopbackLookup);
  return loadLookup.then(async (lookup) => {
    const addresses = [
      ...new Set(
        (await lookup("localhost", { all: true, verbatim: true })).map(({ address }) => address),
      ),
    ];
    if (addresses.length === 0 || addresses.some((address) => !isLoopbackAddress(address))) {
      throw new Error("localhost did not resolve exclusively to loopback addresses");
    }
    return addresses;
  });
}

function resolveBindAddresses(
  redirectUrl: URL,
  bindHostname?: string,
  lookup?: LoopbackLookup,
): string[] | Promise<string[]> {
  const redirectHostname = unbracket(redirectUrl.hostname);
  const redirectAddresses = resolveLoopbackHostname(redirectHostname, lookup);
  const requestedHostname = bindHostname ? unbracket(bindHostname) : redirectHostname;
  if (requestedHostname === redirectHostname) {
    return redirectAddresses;
  }
  const requestedAddresses = resolveLoopbackHostname(requestedHostname, lookup);
  return Promise.all([redirectAddresses, requestedAddresses]).then(([redirect, requested]) => [
    ...new Set([...requested, ...redirect]),
  ]);
}

async function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await promise;
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("OAuth callback cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) {
      abort();
    }
  });
}

function resolveOAuthLoopbackPort(redirectUrl: URL): number {
  const port = redirectUrl.port ? Number(redirectUrl.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("OAuth callback redirect must use a valid TCP port");
  }
  return port;
}

function prepareResponse(
  request: IncomingMessage,
  response: ServerResponse,
  resolveCorsOrigin?: CorsOriginResolver,
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const origin = resolveCorsOrigin?.(request.headers.origin);
  if (!origin) {
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader(
    "Vary",
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    typeof request.headers["access-control-request-headers"] === "string"
      ? request.headers["access-control-request-headers"]
      : "content-type",
  );
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Access-Control-Max-Age", "600");
}

async function closeServers(servers: readonly Server[]): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
    ),
  );
}

/** Binds the authoritative loopback redirect before returning, then waits separately. */
export async function startOAuthLoopbackCallbackServer(params: {
  redirectUrl: string | URL;
  expectedState: string;
  timeoutMs: number;
  signal?: AbortSignal;
  bindHostname?: string;
  lookup?: LoopbackLookup;
  createServer?: typeof import("node:http").createServer;
  resolveCorsOrigin?: CorsOriginResolver;
  renderSuccess?: () => RenderedResponse;
  renderError?: (message: string) => RenderedResponse;
}): Promise<OAuthLoopbackCallbackServer> {
  const redirectUrl = new URL(params.redirectUrl);
  const redirectHostname = unbracket(redirectUrl.hostname);
  if (
    redirectUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(redirectHostname)
  ) {
    throw new Error("OAuth callback redirect must use HTTP on a loopback address");
  }
  if (!params.expectedState || !Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error("OAuth callback requires state and a positive timeout");
  }
  if (params.signal?.aborted) {
    throw new Error("OAuth callback cancelled");
  }

  const resolvedAddresses = resolveBindAddresses(redirectUrl, params.bindHostname, params.lookup);
  const addresses = Array.isArray(resolvedAddresses)
    ? resolvedAddresses
    : await waitForAbortable(resolvedAddresses, params.signal);
  const port = resolveOAuthLoopbackPort(redirectUrl);
  const callbackPath = redirectUrl.pathname || "/";
  const createServer = params.createServer ?? (await import("node:http")).createServer;
  const servers: Server[] = [];
  let settled = false;
  let binding = true;
  const timeoutRef: { current?: NodeJS.Timeout } = {};
  let closePromise: Promise<void> | undefined;
  let resolveWait!: (result: OAuthLoopbackCallbackResult) => void;
  let rejectWait!: (error: Error) => void;
  const waitPromise = new Promise<OAuthLoopbackCallbackResult>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  void waitPromise.catch(() => undefined);
  const close = () => (binding ? Promise.resolve() : (closePromise ??= closeServers(servers)));
  const cleanup = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    params.signal?.removeEventListener("abort", onAbort);
  };
  const settleError = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    rejectWait(error instanceof Error ? error : new Error("OAuth callback failed"));
    void close();
  };
  const onAbort = () => settleError(new Error("OAuth callback cancelled"));
  const settleResult = (result: OAuthLoopbackCallbackResult, response: ServerResponse) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolveWait(result);
      void close();
    };
    response.once("finish", finish);
    response.once("close", finish);
  };
  const renderSuccess =
    params.renderSuccess ??
    (() => ({
      body: "Authorization received; return to the terminal while OpenClaw finishes.",
      contentType: "text/plain; charset=utf-8",
    }));
  const renderError =
    params.renderError ??
    ((message: string) => ({
      body: message,
      contentType: "text/plain; charset=utf-8",
    }));
  const respond = (response: ServerResponse, status: number, rendered: RenderedResponse) => {
    response.writeHead(status, { "Content-Type": rendered.contentType });
    response.end(rendered.body);
  };
  const handleRequest = (request: IncomingMessage, response: ServerResponse) => {
    try {
      prepareResponse(request, response, params.resolveCorsOrigin);
      if (settled) {
        respond(response, 409, renderError("OAuth callback was already received."));
      } else if (request.method === "OPTIONS") {
        response.writeHead(204).end();
      } else {
        const url = new URL(request.url ?? "/", redirectUrl.origin);
        if (url.pathname !== callbackPath) {
          respond(response, 404, renderError("Callback route not found."));
        } else if (request.method !== "GET") {
          response.setHeader("Allow", "GET, OPTIONS");
          respond(response, 405, renderError("Method not allowed."));
        } else if (url.searchParams.get("state") !== params.expectedState) {
          respond(response, 400, renderError("Invalid OAuth state."));
        } else if (url.searchParams.has("error")) {
          const error = url.searchParams.get("error")!;
          const errorDescription = url.searchParams.get("error_description") ?? undefined;
          settleResult(
            { type: "oauth_error", error, ...(errorDescription ? { errorDescription } : {}) },
            response,
          );
          respond(response, 400, renderError("Authorization was not completed."));
        } else {
          const code = url.searchParams.get("code")?.trim();
          if (!code) {
            respond(response, 400, renderError("Missing OAuth authorization code."));
          } else {
            settleResult(
              { type: "authorization_code", code, state: params.expectedState },
              response,
            );
            respond(response, 200, renderSuccess());
          }
        }
      }
    } catch (error) {
      if (!response.headersSent) {
        respond(response, 500, renderError("OAuth callback failed."));
      }
      settleError(error);
    }
  };

  params.signal?.addEventListener("abort", onAbort, { once: true });
  if (params.signal?.aborted) {
    onAbort();
    throw new Error("OAuth callback cancelled");
  }
  try {
    // A partial localhost bind lets browsers choose an unserved family, so fail as one unit.
    for (const address of addresses) {
      const server = createServer(handleRequest);
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, address, resolve);
      });
      server.removeAllListeners("error");
      server.on("error", settleError);
      if (settled) {
        throw new Error("OAuth callback cancelled");
      }
    }
  } catch (error) {
    binding = false;
    cleanup();
    await closeServers(servers);
    throw error;
  }
  binding = false;
  timeoutRef.current = setTimeout(
    () => settleError(new Error("OAuth callback timeout")),
    params.timeoutMs,
  );
  return {
    waitForCallback: () => waitPromise,
    close: async () => {
      if (!settled) {
        settleError(new Error("OAuth callback cancelled"));
      }
      await close();
    },
  };
}
