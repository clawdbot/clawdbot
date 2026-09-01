import { describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

describe("native UI locale subscription", () => {
  it("publishes locale changes through the host and fences notifications after activation ends", async () => {
    const original = i18n.getLocale();
    const next = original === "de" ? "en" : "de";
    const subscribe = () => () => undefined;
    const context = {
      gateway: { subscribe },
      sessions: { subscribe },
      agents: { subscribe },
      agentSelection: { subscribe },
      theme: { subscribe },
    } as unknown as ApplicationContext<RouteId>;
    const abort = new AbortController();
    const owner = { abort, descriptor: { pluginId: "review" }, disposers: new Set() } as Omit<
      ControlUiPluginOwner,
      "host"
    >;
    const runtime = { isCurrent: () => !abort.signal.aborted } as ControlUiPluginRuntime;
    const host = createControlUiPluginHost(() => context, runtime, owner);
    const notified = vi.fn(() => host.locale);
    const stop = host.subscribe(notified);
    try {
      await i18n.setLocale(next);
      expect(notified).toHaveReturnedWith(next);
      expect(notified).toHaveBeenCalledOnce();
      abort.abort();
      await i18n.setLocale(original);
      expect(notified).toHaveBeenCalledOnce();
    } finally {
      stop();
      await i18n.setLocale(original);
    }
  });
});

describe("native UI page navigation", () => {
  it.each([true, false])(
    "preserves scoped filters during replacement navigation (native route: %s)",
    (native) => {
      const originalUrl = window.location.href;
      window.history.replaceState(null, "", "/?agent=main&p.filter=ready");
      const navigate = vi.fn();
      const replace = vi.fn();
      const context = {
        basePath: "/console",
        gateway: {
          snapshot: {
            hello: {
              controlUiTabs: native
                ? [{ pluginId: "review", id: "board", placement: "route:workboard" }]
                : [],
            },
          },
        },
        navigate,
        replace,
      } as unknown as ApplicationContext<RouteId>;
      const abort = new AbortController();
      const owner = { abort, descriptor: { pluginId: "review" }, disposers: new Set() } as Omit<
        ControlUiPluginOwner,
        "host"
      >;
      const runtime = { isCurrent: () => !abort.signal.aborted } as ControlUiPluginRuntime;
      const host = createControlUiPluginHost(() => context, runtime, owner);
      const target = { id: "board", path: ["Team / One"], params: { filter: "done" } };
      try {
        const location = new URL(
          host.navigation.pageHref(target, { preserveSearch: true }),
          window.location.origin,
        );
        expect(location.pathname).toBe(
          native ? "/console/workboard/Team%20%2F%20One" : "/console/plugin",
        );
        expect(location.searchParams.get("agent")).toBe("main");
        expect(location.searchParams.get("p.filter")).toBe("done");
        if (!native) {
          expect(location.searchParams.get("plugin")).toBe("review");
          expect(location.searchParams.get("id")).toBe("board");
        }
        host.navigation.openPage(target, { replace: true, preserveSearch: true });
        expect(replace).toHaveBeenCalledWith(
          native ? "workboard" : "plugin",
          expect.objectContaining({
            pathname: location.pathname,
            search: location.search,
          }),
        );
        expect(navigate).not.toHaveBeenCalled();
        expect(
          new URL(host.navigation.pageHref(target), window.location.origin).searchParams.has(
            "agent",
          ),
        ).toBe(false);
        abort.abort();
        expect(() => host.navigation.openPage(target)).toThrow("activation has ended");
      } finally {
        window.history.replaceState(null, "", originalUrl);
      }
    },
  );
});
