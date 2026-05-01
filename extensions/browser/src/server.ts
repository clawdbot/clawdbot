import type { Server } from "node:http";
import express from "express";
import {
  createBrowserControlContext,
  ensureBrowserControlRuntime,
  getBrowserControlState,
  stopBrowserControlRuntime,
} from "./browser-control-state.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./browser/bridge-auth-registry.js";
import { loadBrowserConfigForRuntimeRefresh } from "./browser/config-refresh-source.js";
import { resolveBrowserConfig } from "./browser/config.js";
import {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth,
} from "./browser/control-auth.js";
import { registerBrowserRoutes } from "./browser/routes/index.js";
import type { BrowserRouteRegistrar } from "./browser/routes/types.js";
import type { BrowserServerState } from "./browser/server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./browser/server-middleware.js";
import { getRuntimeConfig } from "./config/config.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { isDefaultBrowserPluginEnabled } from "./plugin-enabled.js";

const log = createSubsystemLogger("browser");
const logServer = log.child("server");

export async function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null> {
  const current = getBrowserControlState();
  if (current?.server) {
    return current;
  }

  const cfg = getRuntimeConfig();
  const browserCfg = loadBrowserConfigForRuntimeRefresh();
  if (!isDefaultBrowserPluginEnabled(browserCfg)) {
    return null;
  }
  const resolved = resolveBrowserConfig(browserCfg.browser, browserCfg);
  if (!resolved.enabled) {
    return null;
  }

  let browserAuth = resolveBrowserControlAuth(cfg);
  let browserAuthBootstrapFailed = false;
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    browserAuth = ensured.auth;
    if (ensured.generatedToken) {
      logServer.info(
        "No browser auth configured; generated browser control auth credential automatically.",
      );
    }
  } catch (err) {
    logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
    browserAuthBootstrapFailed = true;
  }

  const browserAuthRequired =
    browserAuthBootstrapFailed || shouldAutoGenerateBrowserAuth(process.env);
  if (browserAuthRequired && !browserAuth.token && !browserAuth.password) {
    if (browserAuthBootstrapFailed) {
      logServer.error(
        "browser control startup aborted: authentication bootstrap failed " +
          "and no fallback auth is configured.",
      );
    } else {
      logServer.error("browser control startup aborted: no authentication configured.");
    }
    return null;
  }

  const app = express();
  installBrowserCommonMiddleware(app);
  installBrowserAuthMiddleware(app, browserAuth);

  const ctx = createBrowserControlContext();
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  const port = resolved.controlPort;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
    return null;
  });

  if (!server) {
    return null;
  }

  const state = await ensureBrowserControlRuntime({
    server,
    port,
    resolved,
    owner: "server",
    onWarn: (message) => logServer.warn(message),
  });
  setBridgeAuthForPort(port, browserAuth);

  const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
  logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const current = getBrowserControlState();
  if (current?.port) {
    deleteBridgeAuthForPort(current.port);
  }
  await stopBrowserControlRuntime({
    requestedBy: "server",
    closeServer: true,
    onWarn: (message) => logServer.warn(message),
  });
}
