import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import { startModelSetupFirstRunRedirectAfterLocation } from "../pages/model-setup/first-run.ts";
import {
  normalizeInitialApplicationLocation,
  resolveInitialApplicationLocation,
} from "./bootstrap-location.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { loadSettings, saveSettings } from "./settings.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("normalizeInitialApplicationLocation", () => {
  it("routes an opaque persisted key without aborting bootstrap", () => {
    expect(
      normalizeInitialApplicationLocation(
        { pathname: "/", search: "", hash: "" },
        "",
        "telegram:12345",
        "main",
      ),
    ).toEqual({ pathname: "/chat/main/telegram/12345", search: "", hash: "" });
  });

  it("leaves the initial location unchanged when a malformed key has no path", () => {
    const location = { pathname: "/", search: "?draft=hello", hash: "" };
    expect(normalizeInitialApplicationLocation(location, "", "agent::broken", "main")).toBe(
      location,
    );
  });

  it("waits for the configured default agent before normalizing a persisted alias", async () => {
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
      sessionKey: "main",
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

    await expect(pending).resolves.toEqual({ pathname: "/chat/research", search: "", hash: "" });
  });

  it("does not wait for gateway defaults on an explicit startup route", async () => {
    const subscribe = vi.fn(() => () => undefined);
    const location = { pathname: "/settings/general", search: "", hash: "" };

    await expect(
      resolveInitialApplicationLocation({
        location,
        basePath: "",
        sessionKey: "main",
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

  it("starts the first-run redirect after installing the persisted session location", async () => {
    const canonicalLocation = normalizeInitialApplicationLocation(
      { pathname: "/", search: "", hash: "" },
      "",
      "agent:main:main",
      "main",
    );
    expect(canonicalLocation).toEqual({ pathname: "/chat/main", search: "", hash: "" });

    let resolveInitialLocation: (location: RouteLocation) => void = () => undefined;
    const initialLocationReady = new Promise<RouteLocation>((resolve) => {
      resolveInitialLocation = resolve;
    });
    let currentLocation: RouteLocation = { pathname: "/", search: "", hash: "" };
    const replaceLocation = vi.fn((location: RouteLocation) => {
      currentLocation = location;
    });
    const request = vi.fn().mockResolvedValue({
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const subscribe = vi.fn((next: GatewayListener) => {
      listener = next;
      return () => undefined;
    });
    const replaceRoute = vi.fn();
    const context = {
      gateway: {
        snapshot: { phase: "connecting", client: null, hello: null },
        subscribe,
      },
      replace: replaceRoute,
    } as unknown as ApplicationContext<RouteId>;

    const redirectReady = startModelSetupFirstRunRedirectAfterLocation({
      context,
      enabled: true,
      history: { location: () => currentLocation, replace: replaceLocation },
      initialLocationReady,
    });
    expect(subscribe).not.toHaveBeenCalled();

    resolveInitialLocation(canonicalLocation);
    await redirectReady;
    expect(replaceLocation).toHaveBeenCalledWith(canonicalLocation);
    expect(subscribe).toHaveBeenCalledOnce();

    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected first-run gateway listener");
    }
    connectedListener({
      phase: "connected",
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    } as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(replaceRoute).toHaveBeenCalledOnce());
    expect(replaceRoute).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
  });

  it("does not restart routing after stop wins the session-path loader race", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    window.history.replaceState({}, "", "/");
    const sessionPathBuilder = deferred<void>();
    const runtime = bootstrapApplication({ sessionPathBuilderReady: sessionPathBuilder.promise });
    const routerStart = vi.spyOn(runtime.router, "start");
    const redirectSubscription = vi.spyOn(runtime.context.gateway, "subscribe");

    try {
      const start = runtime.start();
      let settled = false;
      void start.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      runtime.stop();
      sessionPathBuilder.resolve();
      await start;

      expect(routerStart).not.toHaveBeenCalled();
      expect(redirectSubscription).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });
});
