// Browser tests cover dispatcher path normalization.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";

let createBrowserRouteDispatcher: typeof import("./dispatcher.js").createBrowserRouteDispatcher;

describe("browser route dispatcher path normalization", () => {
  beforeAll(async () => {
    vi.doMock("./index.js", () => {
      return {
        registerBrowserRoutes(app: { get: (path: string, handler: unknown) => void }) {
          app.get("/snapshot", (_: unknown, res: { json: (body: unknown) => void }) => {
            res.json({ route: "snapshot" });
          });
        },
      };
    });
    ({ createBrowserRouteDispatcher } = await import("./dispatcher.js"));
  });

  it.each(["snapshot", "/snapshot/", "/snapshot///", "  snapshot///  "])(
    "normalizes dispatch path %j like browser proxy requests",
    async (path) => {
      const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);

      const result = await dispatcher.dispatch({
        method: "GET",
        path,
      });

      expect(result).toEqual({ status: 200, body: { route: "snapshot" } });
    },
  );
});
