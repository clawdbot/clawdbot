import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { isLoopbackHost } from "../gateway/net.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./bridge-auth-registry.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { registerBrowserRoutes } from "./routes/index.js";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  type ProfileContext,
} from "./server-context.js";
import {
  hasVerifiedBrowserAuth,
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: BrowserServerState;
};

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

export async function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
  authToken?: string;
  authPassword?: string;
  onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
  resolveSandboxNoVncToken?: (token: string) => ResolvedNoVncObserver | null;
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
    server: null as unknown as Server,
    port,
    resolved: params.resolved,
    profiles: new Map(),
  };

  const ctx = createBrowserRouteContext({
    getState: () => state,
    onEnsureAttachTarget: params.onEnsureAttachTarget,
  });
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once("error", reject);
  });

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  state.server = server;
  state.port = resolvedPort;
  state.resolved.controlPort = resolvedPort;

  setBridgeAuthForPort(resolvedPort, { token: authToken, password: authPassword });

  const baseUrl = `http://${host}:${resolvedPort}`;
  return { server, port: resolvedPort, baseUrl, state };
}

export async function stopBrowserBridgeServer(server: Server): Promise<void> {
  try {
    const address = server.address() as AddressInfo | null;
    if (address?.port) {
      deleteBridgeAuthForPort(address.port);
    }
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
