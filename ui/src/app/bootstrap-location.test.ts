import { describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import type { ApplicationContext } from "./context.ts";

describe("resolveInitialApplicationLocation", () => {
  it.each([
    { sessionKey: "telegram:12345", search: "", pathname: "/chat/main/telegram/12345" },
    { sessionKey: "agent::broken", search: "?draft=hello", pathname: null },
  ])(
    "resolves persisted '$sessionKey' without aborting bootstrap",
    async ({ sessionKey, search, pathname }) => {
      const location = { pathname: "/", search, hash: "" };
      const resolved = await resolveInitialApplicationLocation({
        location,
        basePath: "",
        sessionKey,
        gateway: {
          snapshot: { phase: "connected", client: {}, hello: null },
          subscribe: vi.fn(() => () => undefined),
        } as unknown as ApplicationContext<RouteId>["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      });
      expect(resolved).toEqual({ ...location, pathname: pathname ?? location.pathname });
      expect(resolved === location).toBe(pathname === null);
    },
  );

  it.each([
    { persistedSessionKey: "main", connectedSessionKey: "main" },
    { persistedSessionKey: "", connectedSessionKey: "agent:research:workspace" },
  ])(
    "waits for gateway defaults before normalizing '$persistedSessionKey'",
    async ({ persistedSessionKey, connectedSessionKey }) => {
      type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
      let listener: GatewayListener | null = null;
      let snapshot = {
        phase: "connecting",
        client: null,
        hello: null,
      } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
      const gateway = {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      };
      const pending = resolveInitialApplicationLocation({
        location: { pathname: "/", search: "", hash: "" },
        basePath: "",
        sessionKey: persistedSessionKey,
        gateway,
        agentsList: () => null,
        signal: new AbortController().signal,
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      snapshot = {
        phase: "connected",
        client: {},
        sessionKey: connectedSessionKey,
        hello: {
          snapshot: {
            sessionDefaults: { defaultAgentId: "research", mainKey: "workspace" },
          },
        },
      } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
      const connectedListener = listener as GatewayListener | null;
      if (!connectedListener) {
        throw new Error("expected gateway readiness subscription");
      }
      connectedListener(snapshot);

      await expect(pending).resolves.toEqual({
        pathname: "/chat/research",
        search: "",
        hash: "",
      });
    },
  );

  it.each(["main", ""])(
    "does not wait for gateway defaults on an explicit startup route with '%s'",
    async (sessionKey) => {
      const subscribe = vi.fn(() => () => undefined);
      const location = { pathname: "/settings/appearance", search: "", hash: "" };

      await expect(
        resolveInitialApplicationLocation({
          location,
          basePath: "",
          sessionKey,
          gateway: {
            snapshot: { phase: "connecting", client: null, hello: null },
            subscribe,
          } as unknown as ApplicationContext<RouteId>["gateway"],
          agentsList: () => null,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(location);
      expect(subscribe).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes a scoped persisted main key when defaults are already known", async () => {
    const subscribe = vi.fn(() => () => undefined);

    await expect(
      resolveInitialApplicationLocation({
        location: { pathname: "/", search: "", hash: "" },
        basePath: "",
        sessionKey: "agent:research:workspace",
        gateway: {
          snapshot: {
            phase: "connected",
            client: {},
            hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
          },
          subscribe,
        } as unknown as ApplicationContext<RouteId>["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ pathname: "/chat/research", search: "", hash: "" });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each([
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345",
        hash: "",
      },
      expected: { pathname: "/chat/research/telegram/12345", search: "", hash: "" },
      namespace: "chat",
      sessionKey: "agent:research:telegram:12345",
    },
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345&face=dashboard",
        hash: "",
      },
      expected: { pathname: "/dashboard/research/telegram/12345", search: "", hash: "" },
      namespace: "dashboard",
      sessionKey: "agent:research:telegram:12345",
    },
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Arelease-deadbeef",
        hash: "",
      },
      expected: { pathname: "/chat/research/~key/release-deadbeef", search: "", hash: "" },
      namespace: "chat",
      sessionKey: "agent:research:release-deadbeef",
    },
  ] as const)("rewrites released query links to $expected.pathname", async (testCase) => {
    const subscribe = vi.fn(() => () => undefined);
    const resolved = await resolveInitialApplicationLocation({
      location: testCase.location,
      basePath: "",
      sessionKey: "agent:main:main",
      gateway: {
        snapshot: { phase: "connecting", client: null, hello: null },
        subscribe,
      } as unknown as ApplicationContext<RouteId>["gateway"],
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
      signal: new AbortController().signal,
    });

    expect(resolved).toEqual(testCase.expected);
    expect(sessionRefFromPath(resolved.pathname, "", "main")).toMatchObject({
      namespace: testCase.namespace,
      kind: "literal",
      sessionKey: testCase.sessionKey,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not consume Sessions list row-expansion state", async () => {
    const location = { pathname: "/sessions", search: "?session=agent%3Amain%3Amain", hash: "" };
    const subscribe = vi.fn(() => () => undefined);
    await expect(
      resolveInitialApplicationLocation({
        location,
        basePath: "",
        sessionKey: "agent:main:main",
        gateway: {
          snapshot: { phase: "connecting", client: null, hello: null },
          subscribe,
        } as unknown as ApplicationContext<RouteId>["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(location);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("waits for cold custom-main defaults before rewriting a released query link", async () => {
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
    const pending = resolveInitialApplicationLocation({
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Aworkspace",
        hash: "",
      },
      basePath: "",
      sessionKey: "agent:main:main",
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agentsList: () => null,
      signal: new AbortController().signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    snapshot = {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway readiness subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toEqual({
      pathname: "/chat/research",
      search: "",
      hash: "",
    });
  });
});
