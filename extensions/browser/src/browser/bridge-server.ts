/**
 * Loopback browser bridge server.
 *
 * Hosts the browser control routes on an authenticated local port for sandbox,
 * host, and node browser integrations that need HTTP access to browser control.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isLoopbackHost } from "../gateway/net.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./bridge-auth-registry.js";
import type { ResolvedBrowserConfig } from "./config.js";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { stopBrowserBridgeRuntime } from "./runtime-lifecycle.js";
import type { BrowserServerState, ProfileContext } from "./server-context.js";
import {
  hasVerifiedBrowserAuth,
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

/** Running bridge server details returned to callers that manage its lifecycle. */
export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: BrowserServerState;
};

const bridgeStates = new WeakMap<Server, BrowserServerState>();
const bridgeStopPromises = new WeakMap<Server, Promise<void>>();

async function closeBridgeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

type ResolvedNoVncObserver = {
  noVncPort: number;
  password?: string;
};

function buildNoVncBootstrapHtml(params: ResolvedNoVncObserver): string {
  const hash = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
  });
  const password = normalizeOptionalString(params.password);
  if (password) {
    hash.set("password", password);
  }
  const targetUrl = `http://127.0.0.1:${params.noVncPort}/vnc.html#${hash.toString()}`;
  const encodedTarget = JSON.stringify(targetUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>OpenClaw noVNC Observer</title>
</head>
<body>
  <p>Opening sandbox observer...</p>
  <script>
    const target = ${encodedTarget};
    window.location.replace(target);
  </script>
</body>
</html>`;
}

/** Start an authenticated loopback browser bridge and register browser routes. */
export async function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
  authToken?: string;
  authPassword?: string;
  onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
  resolveSandboxNoVncToken?: (token: string) => ResolvedNoVncObserver | null;
  skipRouteRegistrationForTest?: boolean;
}): Promise<BrowserBridge> {
  const host = params.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`bridge server must bind to loopback host (got ${host})`);
  }
  const port = params.port ?? 0;

  const app = express();
  installBrowserCommonMiddleware(app);

  const authToken = normalizeOptionalString(params.authToken);
  const authPassword = normalizeOptionalString(params.authPassword);
  if (!authToken && !authPassword) {
    throw new Error("bridge server requires auth (authToken/authPassword missing)");
  }
  installBrowserAuthMiddleware(app, { token: authToken, password: authPassword });

  if (params.resolveSandboxNoVncToken) {
    app.get("/sandbox/novnc", (req, res) => {
      if (!hasVerifiedBrowserAuth(req)) {
        res.status(401).send("Unauthorized");
        return;
      }
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Referrer-Policy", "no-referrer");
      const rawToken = normalizeOptionalString(req.query?.token);
      if (!rawToken) {
        res.status(400).send("Missing token");
        return;
      }
      const resolved = params.resolveSandboxNoVncToken?.(rawToken);
      if (!resolved) {
        res.status(404).send("Invalid or expired token");
        return;
      }
      res.type("html").status(200).send(buildNoVncBootstrapHtml(resolved));
    });
  }

  const state: BrowserServerState = {
    server: null,
    port,
    resolved: params.resolved,
    profiles: new Map(),
  };

  if (params.skipRouteRegistrationForTest) {
    app.get("/", (_req, res) => {
      res.status(200).send("OK");
    });
  } else {
    const [{ createBrowserRouteContext }, { registerBrowserRoutes }] = await Promise.all([
      import("./server-context.js"),
      import("./routes/index.js"),
    ]);
    const ctx = createBrowserRouteContext({
      getState: () => state,
      onEnsureAttachTarget: params.onEnsureAttachTarget,
    });
    registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once("error", reject);
  });

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  state.server = server;
  state.port = resolvedPort;
  state.resolved.controlPort = resolvedPort;
  bridgeStates.set(server, state);

  setBridgeAuthForPort(resolvedPort, { token: authToken, password: authPassword });

  const baseUrl = `http://${host}:${resolvedPort}`;
  return { server, port: resolvedPort, baseUrl, state };
}

async function stopBrowserBridgeServerOnce(server: Server): Promise<void> {
  let port: number | undefined;
  try {
    const address = server.address() as AddressInfo | null;
    if (address?.port) {
      port = address.port;
    }
  } catch {
    // ignore
  }
  const state = bridgeStates.get(server);
  // Calling close stops new accepts synchronously; its callback waits for
  // already-admitted requests, which runtime invalidation below will abort.
  const httpClose = closeBridgeHttpServer(server);
  if (state) {
    deleteBridgeAuthForPort(state.port);
  } else if (port) {
    deleteBridgeAuthForPort(port);
  }
  if (!state) {
    await httpClose;
    return;
  }
  const runtimeClose = stopBrowserBridgeRuntime({
    current: state,
    getState: () => bridgeStates.get(server) ?? null,
    // Retain the exact state until ingress and resource cleanup both succeed.
    clearState: () => {},
    onWarn: () => {},
  });
  const settled = await Promise.allSettled([httpClose, runtimeClose]);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
  bridgeStates.delete(server);
}

/** Stop a browser bridge server and clear its ephemeral port auth. */
export function stopBrowserBridgeServer(server: Server): Promise<void> {
  const current = bridgeStopPromises.get(server);
  if (current) {
    return current;
  }
  let resolveStop!: () => void;
  let rejectStop!: (reason: unknown) => void;
  const stopping = new Promise<void>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  bridgeStopPromises.set(server, stopping);
  void stopBrowserBridgeServerOnce(server).then(resolveStop, rejectStop);
  void stopping
    .finally(() => {
      if (bridgeStopPromises.get(server) === stopping) {
        bridgeStopPromises.delete(server);
      }
    })
    .catch(() => {});
  return stopping;
}
