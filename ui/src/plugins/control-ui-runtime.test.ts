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
    {
      scenario: "authenticated native plugin on plain HTTP",
      native: true,
      remote: false,
      secure: false,
      granted: true,
      error:
        "Native plugin UI requires HTTPS or localhost to authenticate its assets. Open this Gateway through HTTPS/Tailscale Serve, or use its loopback dashboard.",
    },
    {
      scenario: "native plugin without asset authentication on plain HTTP",
      native: true,
      remote: false,
      secure: false,
      requiresAuth: false,
      loads: true,
      error: null,
    },
    {
      scenario: "native plugin under a resource base path",
      native: true,
      remote: false,
      granted: true,
      loads: true,
      resourceBasePath: "/console",
      error: null,
    },
  ])(
    "settles $scenario without loading protected modules",
    async ({
      native,
      remote,
      error,
      secure = true,
      granted = false,
      requiresAuth = true,
      loads = false,
      resourceBasePath = "",
    }) => {
      vi.stubGlobal("isSecureContext", secure);
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
                      entryUrl: `${resourceBasePath}/__openclaw__/plugins/control-ui/review/one/index.js`,
                      styles: [],
                    },
                  ]
                : [],
            }
          : { ok: true },
      );
      const refresh = vi.fn(async () => ({
        pluginAssetsRequireAuth: requiresAuth,
        pluginFrameGrants: granted
          ? [
              {
                pluginId: "review",
                match: "prefix",
                path: `${resourceBasePath}/__openclaw__/plugins/control-ui/review/`,
              },
            ]
          : [],
      }));
      const context = {
        basePath: "/navigation-only",
        resourceBasePath,
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
        expect(initializeControlUiPlugin).toHaveBeenCalledTimes(loads ? 1 : 0);
        expect(runtime.registrations("pages")).toEqual([]);
        expect(runtime.isLoading("review")).toBe(false);
      } finally {
        runtime.dispose();
        vi.unstubAllGlobals();
      }
    },
  );
});
