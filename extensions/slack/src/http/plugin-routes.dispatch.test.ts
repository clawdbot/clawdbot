import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawConfig, OpenClawPluginApi } from "../runtime-api.js";

function createApi(config: OpenClawConfig, registerHttpRoute = vi.fn()): OpenClawPluginApi {
  return createTestPluginApi({
    id: "slack",
    config,
    registerHttpRoute,
  });
}

describe("registerSlackPluginHttpRoutes dispatch", () => {
  it("uses the shared Slack HTTP handler registry", async () => {
    vi.resetModules();
    const staleRuntimeHandler = vi.fn(async () => false);
    vi.doMock("./handler.runtime.js", () => ({
      handleSlackHttpRequest: staleRuntimeHandler,
    }));

    const [{ registerSlackPluginHttpRoutes }, { registerSlackHttpHandler }] = await Promise.all([
      import("./plugin-routes.js"),
      import("./registry.js"),
    ]);
    const routeHandler = vi.fn();
    const unregister = registerSlackHttpHandler({
      path: "/slack/events",
      handler: routeHandler,
    });
    const registerHttpRoute = vi.fn();

    try {
      registerSlackPluginHttpRoutes(createApi({}, registerHttpRoute));
      const route = registerHttpRoute.mock.calls[0]?.[0] as
        | {
            handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
          }
        | undefined;
      const req = { url: "/slack/events" } as IncomingMessage;
      const res = {} as ServerResponse;

      await expect(route?.handler(req, res)).resolves.toBe(true);

      expect(routeHandler).toHaveBeenCalledWith(req, res);
      expect(staleRuntimeHandler).not.toHaveBeenCalled();
    } finally {
      unregister();
      vi.doUnmock("./handler.runtime.js");
    }
  });
});
