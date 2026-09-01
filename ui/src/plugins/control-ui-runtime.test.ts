import { describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

describe("native plugin asset origin", () => {
  it.each([true, false])(
    "reports cross-origin native plugins without disrupting ordinary remote connections (native: %s)",
    async (native) => {
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
      const refresh = vi.fn();
      const context = {
        gateway: {
          snapshot: {
            phase: "connected",
            client: { gatewayUrl: "wss://remote.example/ws", request },
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
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith("plugins.controlUi.list", {}));
        if (native) {
          await vi.waitFor(() =>
            expect(runtime.errors).toEqual([
              {
                pluginId: "review",
                message:
                  "Native plugin UI requires the Control UI served by the connected Gateway. Open https://remote.example and reconnect there.",
              },
            ]),
          );
          expect(request).toHaveBeenCalledWith(
            "plugins.controlUi.report",
            expect.objectContaining({ pluginId: "review", revision: "one", status: "failed" }),
          );
        } else {
          expect(runtime.errors).toEqual([]);
          expect(request).toHaveBeenCalledOnce();
        }
        expect(refresh).not.toHaveBeenCalled();
        expect(runtime.registrations("pages")).toEqual([]);
      } finally {
        runtime.dispose();
      }
    },
  );
});
