import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { routeIdFromPath } from "../../app-routes.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { areUiSessionKeysEquivalentForHost } from "../../lib/sessions/session-key.ts";
import { consumeCachedModelSetupDetection } from "./detect-cache.ts";
import {
  isDefaultChatLanding,
  locationsMatch,
  startModelSetupFirstRunRedirect,
} from "./first-run.ts";

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
        { pathname: "/chat", search: "?session=main", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat", search: "", hash: "#session=main" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/settings/general", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
  });

  it("keeps the default landing eligible when the gateway canonicalizes its session key", () => {
    const expected = { pathname: "/chat", search: "?session=main", hash: "" };
    const host = {
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      },
    };

    expect(
      locationsMatch(
        { pathname: "/chat", search: "?session=agent%3Amain%3Amain", hash: "" },
        expected,
        (left, right) => areUiSessionKeysEquivalentForHost(host, left, right),
      ),
    ).toBe(true);
    expect(
      locationsMatch(
        { pathname: "/chat", search: "?session=agent%3Aother%3Amain", hash: "" },
        expected,
        (left, right) => areUiSessionKeysEquivalentForHost(host, left, right),
      ),
    ).toBe(false);
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
      connected: true,
      client,
      hello: {
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
      replace,
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => true });
    expect(listener).not.toBeNull();
    listener!(snapshot as Parameters<GatewayListener>[0]);
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.detect",
      {},
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    expect(consumeCachedModelSetupDetection(client)).toEqual(result);
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
      connected: true,
      client,
      hello: {
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
      replace,
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => false });
    listener!(snapshot as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(replace).not.toHaveBeenCalled();
    expect(consumeCachedModelSetupDetection(client)).toEqual(result);
  });

  it("does not detect without admin scope or an advertised setup method", () => {
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
      replace: vi.fn(),
    } as unknown as ApplicationContext<RouteId>;

    startModelSetupFirstRunRedirect({ context, isStillDefaultLanding: () => true });
    listener!({
      connected: true,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    } as Parameters<GatewayListener>[0]);
    listener!({
      connected: true,
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: [] },
      },
    } as unknown as Parameters<GatewayListener>[0]);

    expect(request).not.toHaveBeenCalled();
  });
});
