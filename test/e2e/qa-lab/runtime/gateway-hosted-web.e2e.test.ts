// Gateway hosted web tests cover Control UI and public plugin routes on one real listener.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import adminHttpRpcPlugin from "../../../../extensions/admin-http-rpc/index.js";
import canvasPlugin from "../../../../extensions/canvas/index.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import {
  registerPluginHttpRoute,
  withPluginHttpRouteRegistry,
} from "../../../../src/plugins/http-registry.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../../../src/plugins/runtime.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const TOKEN = "qa-hosted-web-token";
const OPERATOR_SCOPES = ["operator.read", "operator.write", "operator.admin"];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.useRealTimers();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("canvas websocket open timed out")), 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForWebSocketMessage(ws: WebSocket, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`canvas websocket message timed out: ${expected}`)),
      5_000,
    );
    ws.on("message", (data) => {
      if (data.toString() !== expected) {
        return;
      }
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function triggerCanvasReload(ws: WebSocket, indexPath: string): Promise<void> {
  const reload = waitForWebSocketMessage(ws, "reload");
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await fs.writeFile(
      indexPath,
      `<!doctype html><html><body>Gateway hosted Canvas update ${attempt}</body></html>`,
      "utf8",
    );
    const observed = await Promise.race([reload.then(() => true), delay(250).then(() => false)]);
    if (observed) {
      return;
    }
  }
  await reload;
}

function replaceCapability(scopedUrl: string, capability: string): string {
  const url = new URL(scopedUrl);
  const segments = url.pathname.split("/");
  const capabilityIndex = segments.findIndex((segment) => segment === "cap") + 1;
  if (capabilityIndex <= 0 || capabilityIndex >= segments.length) {
    throw new Error(`expected capability-scoped URL, received ${url.pathname}`);
  }
  segments[capabilityIndex] = encodeURIComponent(capability);
  url.pathname = segments.join("/");
  return url.toString().replace(/\/$/, "");
}

describe("Gateway hosted web surfaces", () => {
  it(
    "serves the Control UI, admin RPC, and capability-scoped Canvas/A2UI routes",
    { timeout: 90_000 },
    async () => {
      const root = tempDirs.make("openclaw-qa-hosted-web-");
      const stateDir = path.join(root, "state");
      const controlUiRoot = path.join(root, "control-ui");
      const canvasRoot = path.join(root, "canvas");
      const configPath = path.join(root, "openclaw.json");
      await Promise.all([
        fs.mkdir(stateDir, { recursive: true }),
        fs.mkdir(controlUiRoot, { recursive: true }),
        fs.mkdir(canvasRoot, { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(
          path.join(controlUiRoot, "index.html"),
          "<!doctype html><html><body>Gateway hosted Control UI</body></html>",
          "utf8",
        ),
        fs.writeFile(
          path.join(canvasRoot, "index.html"),
          "<!doctype html><html><body>Gateway hosted Canvas</body></html>",
          "utf8",
        ),
      ]);

      const config: OpenClawConfig = {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token: TOKEN },
          controlUi: { enabled: true, root: controlUiRoot },
        },
      };
      await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

      await withEnvAsync(
        {
          ...snapshotGatewayStartupEnv(),
          HOME: root,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_HOME: root,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          clearConfigCache();
          clearRuntimeConfigSnapshot();
          const port = await getFreeGatewayPort();
          const server = await startGatewayServer(port, {
            auth: { mode: "token", token: TOKEN },
            bind: "loopback",
            controlUiEnabled: true,
            sidecarStartup: "defer",
          });
          const registry = getActivePluginRegistry();
          if (!registry) {
            throw new Error("gateway did not publish an active plugin registry");
          }
          const routeCleanups: Array<() => void> = [];
          const services: Array<{ stop?: (context: never) => void | Promise<void> }> = [];
          let operator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
          let canvasWs: WebSocket | undefined;

          const registerEntry = (
            pluginId: string,
            entry: typeof adminHttpRpcPlugin | typeof canvasPlugin,
            pluginConfig: Record<string, unknown> = {},
          ) => {
            entry.register(
              createTestPluginApi({
                id: pluginId,
                name: pluginId,
                config,
                pluginConfig,
                registerHttpRoute: (route) => {
                  const routeCount = registry.httpRoutes.length;
                  routeCleanups.push(
                    registerPluginHttpRoute({
                      ...route,
                      pluginId,
                      registry,
                      source: `extensions/${pluginId}/index.ts`,
                    }),
                  );
                  if (pluginId === "admin-http-rpc") {
                    const registeredRoute = registry.httpRoutes[routeCount];
                    if (registeredRoute) {
                      registeredRoute.gatewayMethodDispatchAllowed = true;
                    }
                  }
                  const registeredRoute = registry.httpRoutes[routeCount];
                  if (registeredRoute && route.handleUpgrade) {
                    registeredRoute.handleUpgrade = route.handleUpgrade;
                  }
                  if (registeredRoute && route.nodeCapability) {
                    registeredRoute.nodeCapability = { ...route.nodeCapability };
                  }
                },
                registerService: (service) => services.push(service),
              }),
            );
          };

          try {
            registerEntry("admin-http-rpc", adminHttpRpcPlugin);
            registerEntry("canvas", canvasPlugin, {
              host: { enabled: true, liveReload: true, root: canvasRoot },
            });
            expect(registry.httpRoutes.map((route) => route.path)).toEqual(
              expect.arrayContaining([
                "/api/v1/admin/rpc",
                "/__openclaw__/a2ui",
                "/__openclaw__/canvas",
                "/__openclaw__/ws",
              ]),
            );

            const origin = `http://127.0.0.1:${port}`;
            const controlUi = await fetch(`${origin}/`, {
              headers: { authorization: `Bearer ${TOKEN}` },
            });
            expect(controlUi.status).toBe(200);
            expect(controlUi.headers.get("content-type")).toContain("text/html");
            expect(controlUi.headers.get("x-content-type-options")).toBe("nosniff");
            expect(controlUi.headers.get("x-frame-options")).toBe("DENY");
            expect(controlUi.headers.get("referrer-policy")).toBe("no-referrer");
            expect(controlUi.headers.get("content-security-policy")).toContain(
              "frame-ancestors 'none'",
            );
            expect(await controlUi.text()).toContain("Gateway hosted Control UI");

            const unauthorizedAdmin = await fetch(`${origin}/api/v1/admin/rpc`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: "unauthorized", method: "health", params: {} }),
            });
            expect(unauthorizedAdmin.status).toBe(401);

            const admin = await fetch(`${origin}/api/v1/admin/rpc`, {
              method: "POST",
              headers: {
                accept: "text/html",
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ id: "health", method: "health", params: {} }),
            });
            expect(admin.status).toBe(200);
            expect(admin.headers.get("content-type")).toContain("application/json");
            expect(await admin.json()).toMatchObject({
              id: "health",
              ok: true,
              payload: { ok: true },
            });

            const capabilityIssuedAtMs = Date.now();
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(capabilityIssuedAtMs);
            let helloCanvasUrl: string | undefined;
            operator = await connectGatewayClient({
              url: `ws://127.0.0.1:${port}`,
              token: TOKEN,
              role: "operator",
              scopes: OPERATOR_SCOPES,
              onHelloOk: (hello) => {
                helloCanvasUrl = hello.pluginSurfaceUrls?.canvas;
              },
            });
            expect(helloCanvasUrl).toMatch(
              /^http:\/\/127\.0\.0\.1:\d+\/__openclaw__\/cap\/[^/]+$/u,
            );
            vi.useRealTimers();
            const scopedCanvasUrl = helloCanvasUrl ?? "";
            const wrongCapabilityUrl = replaceCapability(scopedCanvasUrl, "wrong-capability");

            await withEnvAsync({ NODE_ENV: undefined, VITEST: undefined }, async () => {
              const canvas = await fetch(`${scopedCanvasUrl}/__openclaw__/canvas/`);
              expect(canvas.status).toBe(200);
              expect(canvas.headers.get("content-type")).toContain("text/html");
              expect(await canvas.text()).toContain("Gateway hosted Canvas");

              const a2ui = await fetch(`${scopedCanvasUrl}/__openclaw__/a2ui/`);
              expect(a2ui.status).toBe(200);
              expect(a2ui.headers.get("content-type")).toContain("text/html");
              expect(await a2ui.text()).toContain("<title>OpenClaw Canvas</title>");

              const a2uiBundle = await fetch(`${scopedCanvasUrl}/__openclaw__/a2ui/a2ui.bundle.js`);
              expect(a2uiBundle.status).toBe(200);
              expect(a2uiBundle.headers.get("content-type")).toContain("javascript");
              expect((await a2uiBundle.text()).length).toBeGreaterThan(100);

              const wrongCapability = await fetch(`${wrongCapabilityUrl}/__openclaw__/canvas/`);
              expect(wrongCapability.status).toBe(401);

              const wsUrl = `${scopedCanvasUrl.replace(/^http/u, "ws")}/__openclaw__/ws`;
              canvasWs = new WebSocket(wsUrl);
              await waitForWebSocketOpen(canvasWs);
              await triggerCanvasReload(canvasWs, path.join(canvasRoot, "index.html"));
              canvasWs.close();
              canvasWs = undefined;

              vi.useFakeTimers({ toFake: ["Date"] });
              vi.setSystemTime(capabilityIssuedAtMs + 24 * 60 * 60_000);
              const expiredCapability = await fetch(`${scopedCanvasUrl}/__openclaw__/canvas/`);
              expect(expiredCapability.status).toBe(401);
            });
          } finally {
            canvasWs?.terminate();
            if (operator) {
              await disconnectGatewayClient(operator).catch(() => undefined);
            }
            for (const service of services.toReversed()) {
              await withPluginHttpRouteRegistry(registry, async () => {
                await service.stop?.({} as never);
              });
            }
            for (const cleanup of routeCleanups.toReversed()) {
              cleanup();
            }
            await server.close();
          }
        },
      );
    },
  );
});
