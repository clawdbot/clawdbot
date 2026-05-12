import type { IncomingMessage, ServerResponse } from "node:http";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "../runtime-api.js";
import { registerSlackPluginHttpRoutes } from "./plugin-routes.js";
import { registerSlackHttpHandler } from "./registry.js";

function createApi(config: OpenClawConfig, registerHttpRoute = vi.fn()): OpenClawPluginApi {
  return createTestPluginApi({
    id: "slack",
    config,
    registerHttpRoute,
  });
}

function registeredRouteAt(registerHttpRoute: ReturnType<typeof vi.fn>, index: number) {
  const call = registerHttpRoute.mock.calls[index];
  if (!call) {
    throw new Error(`expected registered HTTP route ${index}`);
  }
  return call[0] as {
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  };
}

describe("registerSlackPluginHttpRoutes", () => {
  it("registers account webhook paths without resolving unresolved token refs", () => {
    const registerHttpRoute = vi.fn();
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          accounts: {
            default: {
              webhookPath: "/hooks/default",
              botToken: {
                source: "env",
                provider: "default",
                id: "SLACK_BOT_TOKEN",
              } as unknown as string,
            },
            ops: {
              webhookPath: "hooks/ops",
              botToken: {
                source: "env",
                provider: "default",
                id: "SLACK_OPS_BOT_TOKEN",
              } as unknown as string,
            },
          },
        },
      },
    };
    const api = createApi(cfg, registerHttpRoute);

    registerSlackPluginHttpRoutes(api);

    const paths = registerHttpRoute.mock.calls
      .map((call) => (call[0] as { path: string }).path)
      .toSorted();
    expect(paths).toEqual(["/hooks/default", "/hooks/ops"]);
  });

  it("falls back to the default slack webhook path", () => {
    const registerHttpRoute = vi.fn();
    const api = createApi({}, registerHttpRoute);

    registerSlackPluginHttpRoutes(api);

    const paths = registerHttpRoute.mock.calls
      .map((call) => (call[0] as { path: string }).path)
      .toSorted();
    expect(paths).toEqual(["/slack/events"]);
  });

  it("dispatches through the shared Slack HTTP handler registry", async () => {
    const routeHandler = vi.fn();
    const unregister = registerSlackHttpHandler({
      path: "/slack/events",
      handler: routeHandler,
    });
    const registerHttpRoute = vi.fn();

    try {
      registerSlackPluginHttpRoutes(createApi({}, registerHttpRoute));
      const route = registeredRouteAt(registerHttpRoute, 0);
      const req = { url: "/slack/events" } as IncomingMessage;
      const res = {} as ServerResponse;

      await expect(route.handler(req, res)).resolves.toBe(true);

      expect(routeHandler).toHaveBeenCalledWith(req, res);
    } finally {
      unregister();
    }
  });
});
