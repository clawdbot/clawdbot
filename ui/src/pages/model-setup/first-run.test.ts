import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { routeIdFromPath } from "../../app-routes.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { consumeCachedModelSetupDetection } from "./detect-cache.ts";
import { isDefaultChatLanding, startModelSetupFirstRunRedirectAfterLocation } from "./first-run.ts";

const defaultLanding = { pathname: "/chat/main", search: "", hash: "" };

async function startRedirect(
  context: ApplicationContext<RouteId>,
  currentLocation = defaultLanding,
): Promise<() => void> {
  return startModelSetupFirstRunRedirectAfterLocation({
    context,
    enabled: true,
    history: { location: () => currentLocation, replace: () => undefined },
    initialLocationReady: Promise.resolve(defaultLanding),
  });
}

describe("model setup first-run redirect", () => {
  it("recognizes only the implicit chat landing without a session deep link", () => {
    expect(isDefaultChatLanding({ pathname: "/", search: "", hash: "" }, "", routeIdFromPath)).toBe(
      true,
    );
    expect(
      isDefaultChatLanding({ pathname: "/chat", search: "", hash: "" }, "", routeIdFromPath),
    ).toBe(true);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat", search: "?session=agent%3Amain%3Amain", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat", search: "", hash: "#session=agent%3Amain%3Amain" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding({ pathname: "/chat/main", search: "", hash: "" }, "", routeIdFromPath),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/dashboard/main", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/settings/appearance", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
  });

  it("installs a released session deep link without registering first-run detection", async () => {
    const releasedLocation = {
      pathname: "/chat",
      search: "?session=agent%3Aresearch%3Atelegram%3A12345",
      hash: "",
    };
    const canonicalLocation = {
      pathname: "/chat/research/telegram/12345",
      search: "",
      hash: "",
    };
    let currentLocation = releasedLocation;
    const replaceLocation = vi.fn((location: typeof releasedLocation) => {
      currentLocation = location;
    });
    const subscribe = vi.fn(() => () => undefined);
    const replaceRoute = vi.fn();
    const context = {
      gateway: {
        snapshot: {
          phase: "connected",
          client: { request: vi.fn() },
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["openclaw.setup.detect"] },
          },
        },
        subscribe,
      },
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      replace: replaceRoute,
    } as unknown as ApplicationContext<RouteId>;

    await startModelSetupFirstRunRedirectAfterLocation({
      context,
      enabled: isDefaultChatLanding(releasedLocation, "", routeIdFromPath),
      history: { location: () => currentLocation, replace: replaceLocation },
      initialLocationReady: Promise.resolve(canonicalLocation),
    });

    expect(replaceLocation).toHaveBeenCalledWith(canonicalLocation);
    expect(subscribe).not.toHaveBeenCalled();
    expect(replaceRoute).not.toHaveBeenCalled();
  });

  it("detects once, caches the result, and redirects once", async () => {
    const result = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    };
    const request = vi.fn().mockResolvedValue(result);
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const snapshot = {
      phase: "connected",
      client,
      hello: {
        type: "hello-ok" as const,
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    };
    const replace = vi.fn();
    const context = {
      gateway: {
        snapshot,
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      replace,
    } as unknown as ApplicationContext<RouteId>;

    await startRedirect(context);
    expect(listener).not.toBeNull();
    listener!(snapshot as Parameters<GatewayListener>[0]);
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.detect",
      { agentId: "main" },
      expect.objectContaining({ timeoutMs: 40_000 }),
    );
    expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    expect(
      consumeCachedModelSetupDetection({ client, hello: snapshot.hello, agentId: "main" }),
    ).toEqual(result);
  });

  it("does not redirect after the operator leaves the default landing", async () => {
    const result = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    };
    const request = vi.fn().mockResolvedValue(result);
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const snapshot = {
      phase: "connected",
      client,
      hello: {
        type: "hello-ok" as const,
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    };
    const replace = vi.fn();
    const context = {
      gateway: {
        snapshot,
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      replace,
    } as unknown as ApplicationContext<RouteId>;

    await startRedirect(context, { pathname: "/chat/other", search: "", hash: "" });
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(replace).not.toHaveBeenCalled();
    expect(
      consumeCachedModelSetupDetection({ client, hello: snapshot.hello, agentId: "main" }),
    ).toEqual(result);
  });

  it("rejects stale detection and retries first-run guidance after a same-client reconnect", async () => {
    const stale = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/stale-workspace",
      setupComplete: false,
    };
    const current = {
      ...stale,
      workspace: "/tmp/current-workspace",
    };
    let resolveStale!: (result: typeof stale) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof stale>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce(current);
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const firstHello = {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["openclaw.setup.detect"] },
    };
    const gateway = {
      snapshot: { phase: "connected", client, hello: firstHello as typeof firstHello | null },
      subscribe: (next: GatewayListener) => {
        listener = next;
        return () => undefined;
      },
    };
    const replace = vi.fn();
    const context = {
      gateway,
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      replace,
    } as unknown as ApplicationContext<RouteId>;
    await startRedirect(context);
    expect(request).toHaveBeenCalledOnce();

    gateway.snapshot = { phase: "reconnecting", client, hello: null };
    listener!(gateway.snapshot as Parameters<GatewayListener>[0]);
    const nextHello = { ...firstHello };
    gateway.snapshot = { phase: "connected", client, hello: nextHello };
    listener!(gateway.snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    resolveStale(stale);
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    expect(consumeCachedModelSetupDetection({ client, hello: nextHello, agentId: "main" })).toEqual(
      current,
    );
    expect(
      consumeCachedModelSetupDetection({ client, hello: firstHello, agentId: "main" }),
    ).toBeNull();
    expect(replace).toHaveBeenCalledOnce();
  });

  it("does not detect without admin scope or an advertised setup method", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const context = {
      gateway: {
        snapshot: {},
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      replace: vi.fn(),
    } as unknown as ApplicationContext<RouteId>;

    await startRedirect(context);
    listener!({
      phase: "connected" as const,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    } as Parameters<GatewayListener>[0]);
    listener!({
      phase: "connected" as const,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: [] },
      },
    } as unknown as Parameters<GatewayListener>[0]);

    expect(request).not.toHaveBeenCalled();
  });
});
