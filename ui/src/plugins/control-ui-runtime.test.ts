import { describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { initializeControlUiPlugin } from "./control-ui-loader.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

vi.mock("./control-ui-loader.ts", () => ({ initializeControlUiPlugin: vi.fn() }));

describe("native plugin asset admission", () => {
  it.each([
    {
      scenario: "cross-origin native plugin",
      native: true,
      remote: true,
      error:
        "Native plugin UI requires the Control UI served by the connected Gateway. Open https://remote.example and reconnect there.",
    },
    { scenario: "ordinary remote connection", native: false, remote: true, error: null },
    {
      scenario: "missing native asset grant",
      native: true,
      remote: false,
      error: "Native plugin asset grant unavailable: review",
    },
  ])("settles $scenario without loading protected modules", async ({ native, remote, error }) => {
    vi.mocked(initializeControlUiPlugin).mockClear();
    const request = vi.fn(async (method: string) =>
      method === "plugins.controlUi.list"
        ? {
            revision: "catalog-one",
            diagnostics: [],
            plugins: native
              ? [
                  {
                    pluginId: "review",
                    name: "Review",
                    revision: "one",
                    entryUrl: "/__openclaw__/plugins/control-ui/review/one/index.js",
                    styles: [],
                  },
                ]
              : [],
          }
        : { ok: true },
    );
    const refresh = vi.fn(async () => ({
      pluginAssetsRequireAuth: true,
      pluginFrameGrants: [],
    }));
    const context = {
      gateway: {
        snapshot: {
          phase: "connected",
          client: {
            gatewayUrl: remote
              ? "wss://remote.example/ws"
              : window.location.origin.replace(/^http/u, "ws"),
            request,
          },
          hello: {
            features: { methods: ["plugins.controlUi.list", "plugins.controlUi.report"] },
          },
        },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
      config: { refresh },
    } as unknown as ApplicationContext<RouteId>;
    const runtime = new ControlUiPluginRuntime(() => context);
    try {
      runtime.start();
      await runtime.refresh();
      expect(runtime.errors).toEqual(error ? [{ pluginId: "review", message: error }] : []);
      expect(
        request.mock.calls.filter(([method]) => method === "plugins.controlUi.report"),
      ).toEqual(
        error
          ? [
              [
                "plugins.controlUi.report",
                { pluginId: "review", revision: "one", status: "failed", error },
              ],
            ]
          : [],
      );
      expect(refresh).toHaveBeenCalledTimes(remote ? 0 : 1);
      expect(initializeControlUiPlugin).not.toHaveBeenCalled();
      expect(runtime.registrations("pages")).toEqual([]);
      expect(runtime.isLoading("review")).toBe(false);
    } finally {
      runtime.dispose();
    }
  });
});
