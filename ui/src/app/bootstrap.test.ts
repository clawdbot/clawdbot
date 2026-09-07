import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { routeIdFromPath, type RouteId } from "../app-routes.ts";
import {
  isDefaultChatLanding,
  startModelSetupFirstRunRedirectAfterLocation,
} from "../pages/model-setup/first-run.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import * as gatewayStore from "./gateway-store.ts";
import { autoPromptNotificationsOnSend } from "./notifications-auto-prompt.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import { normalizeLegacyTerminalViewLocation } from "./startup-settings.ts";

// Startup progress (dynamic imports, gateway subscribe, router start) is not a
// performance assertion, so these waits must not inherit vi.waitFor's 1s default:
// under a loaded CI runner that budget expires before startup reaches the step.
const STARTUP_STEP_WAIT = { timeout: 15_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("normalizeLegacyTerminalViewLocation", () => {
  it.each([
    {
      location: { pathname: "/", search: "?view=terminal&keep=yes", hash: "#pane" },
      basePath: "",
      expected: { pathname: "/focus/terminal", search: "?keep=yes", hash: "#pane" },
    },
    {
      location: {
        pathname: "/openclaw/",
        search: "?keep=yes&view=terminal",
        hash: "#pane",
      },
      basePath: "/openclaw",
      expected: {
        pathname: "/openclaw/focus/terminal",
        search: "?keep=yes",
        hash: "#pane",
      },
    },
  ])("normalizes the released terminal query at $basePath", ({ location, basePath, expected }) => {
    expect(normalizeLegacyTerminalViewLocation(location, basePath)).toEqual(expected);
  });

  it.each([
    { pathname: "/", search: "?view=desktop", hash: "" },
    { pathname: "/", search: "?view=dashboard", hash: "" },
    { pathname: "/settings/appearance", search: "?view=terminal", hash: "" },
  ])("does not normalize an unsupported legacy location $pathname$search", (location) => {
    expect(normalizeLegacyTerminalViewLocation(location, "")).toBe(location);
  });
});

describe("bootstrapApplication", () => {
  it("starts native notifications before Gateway use and preserves synchronous permission requests", async () => {
    const previousUrl = window.location.href;
    const previousSettings = loadSettings();
    const promptKey = "openclaw.control.notificationsAutoPrompt.v1";
    const previousPrompt = localStorage.getItem(promptKey);
    localStorage.removeItem(promptKey);
    window.history.replaceState({}, "", "/focus/terminal");
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
    vi.stubGlobal("__OPENCLAW_NATIVE_NOTIFICATIONS__", { permission: "notDetermined" });
    const runtime = bootstrapApplication();
    const startGateway = vi.spyOn(runtime.context.gateway, "start").mockImplementation(() => {
      expect(runtime.context.nativeNotifications?.snapshot.permission).toBe("notDetermined");
      expect(postMessage).toHaveBeenCalledWith({ type: "status" });
    });

    try {
      expect(postMessage).not.toHaveBeenCalled();
      await runtime.start();
      expect(startGateway).toHaveBeenCalledOnce();
      const button = document.createElement("button");
      button.addEventListener("click", () => {
        autoPromptNotificationsOnSend(runtime.context);
        expect(postMessage).toHaveBeenLastCalledWith({ type: "request-permission" });
      });
      button.click();
      const listener = vi.fn();
      runtime.context.nativeNotifications?.subscribe(listener);
      runtime.stop();
      postMessage.mockClear();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(
        new CustomEvent("openclaw:native-notifications-status", {
          detail: { permission: "denied", test: null },
        }),
      );
      expect(postMessage).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      startGateway.mockRestore();
      vi.unstubAllGlobals();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
      if (previousPrompt === null) {
        localStorage.removeItem(promptKey);
      } else {
        localStorage.setItem(promptKey, previousPrompt);
      }
    }
  });

  it("does not install native notification listeners when stop wins startup", async () => {
    const previousUrl = window.location.href;
    const previousSettings = loadSettings();
    window.history.replaceState({}, "", "/focus/terminal");
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
    const runtime = bootstrapApplication();
    try {
      const starting = runtime.start();
      runtime.stop();
      await starting;
      window.dispatchEvent(new Event("focus"));
      expect(postMessage).not.toHaveBeenCalled();
      expect(runtime.context.nativeNotifications).toBeNull();
    } finally {
      runtime.stop();
      vi.unstubAllGlobals();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it.each([
    { pathname: "/settings/model-providers", routeId: "model-providers", warmed: true },
    { pathname: "/operator/settings/model-providers", routeId: "model-providers", warmed: true },
    { pathname: "/chat/main/example-deadbeef", routeId: "chat", warmed: true },
    { pathname: "/", routeId: "chat", warmed: false },
    { pathname: "/chat", routeId: "chat", warmed: false },
    { pathname: "/focus/terminal", routeId: "chat", warmed: false },
    { pathname: "/approve/exec%3A1", routeId: "chat", warmed: false },
  ] as const)(
    "warms only explicit application routes at startup: $pathname",
    async ({ pathname, routeId, warmed }) => {
      const previousUrl = window.location.href;
      const previousSettings = loadSettings();
      window.history.replaceState({}, "", pathname);
      const runtime = bootstrapApplication();
      const route = runtime.router.getRoute(routeId);
      if (!route) {
        throw new Error(`Missing route ${routeId}`);
      }
      const component = vi.spyOn(route, "component").mockResolvedValue({ render: () => null });
      const loader = vi.spyOn(route, "loader");
      const startGateway = vi.spyOn(runtime.context.gateway, "start").mockImplementation(() => {});
      try {
        expect(component).not.toHaveBeenCalled();
        const starting = runtime.start();
        expect(component).toHaveBeenCalledTimes(warmed ? 1 : 0);
        expect(loader).not.toHaveBeenCalled();
        runtime.stop();
        await starting;
        component.mockClear();
        await runtime.start();
        expect(component).not.toHaveBeenCalled();
      } finally {
        runtime.stop();
        component.mockRestore();
        loader.mockRestore();
        startGateway.mockRestore();
        window.history.replaceState({}, "", previousUrl);
        saveSettings(previousSettings);
      }
    },
  );

  it("replaces a released dashboard query bookmark before router start", async () => {
    const initialLocation = {
      pathname: "/chat",
      search: "?session=agent%3Aresearch%3Arelease-deadbeef&face=dashboard&draft=ship",
      hash: "",
    };
    const gateway = {
      snapshot: {
        phase: "connected",
        client: {},
        hello: { snapshot: { sessionDefaults: { mainKey: "main" } } },
      },
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext<RouteId>["gateway"];
    const canonicalLocation = await resolveInitialApplicationLocation({
      location: initialLocation,
      basePath: "",
      sessionKey: "agent:main:main",
      gateway,
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
      signal: new AbortController().signal,
    });
    let currentLocation: RouteLocation = initialLocation;
    const replace = vi.fn((location: RouteLocation) => {
      currentLocation = location;
    });

    await startModelSetupFirstRunRedirectAfterLocation({
      context: { gateway } as unknown as ApplicationContext<RouteId>,
      enabled: false,
      history: { location: () => currentLocation, replace },
      initialLocationReady: Promise.resolve(canonicalLocation),
    });

    expect(replace).toHaveBeenCalledWith({
      pathname: "/dashboard/research/~key/release-deadbeef",
      search: "?draft=ship",
      hash: "",
    });
  });

  it("starts the first-run redirect after installing the persisted session location", async () => {
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
    const gateway = {
      snapshot: {
        phase: "connecting",
        client: null,
        hello: null,
      } as Parameters<GatewayListener>[0],
      subscribe,
    };
    const context = {
      gateway,
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      replace: replaceRoute,
    } as unknown as ApplicationContext<RouteId>;
    const canonicalLocation = await resolveInitialApplicationLocation({
      location: { pathname: "/", search: "", hash: "" },
      basePath: "",
      sessionKey: "agent:main:main",
      gateway,
      agentsList: () => null,
      signal: new AbortController().signal,
    });
    expect(canonicalLocation).toEqual({ pathname: "/chat/main", search: "", hash: "" });

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
    gateway.snapshot = {
      phase: "connected",
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", modelConfigured: false },
        },
      },
    } as Parameters<GatewayListener>[0];
    connectedListener(gateway.snapshot);
    expect(request).not.toHaveBeenCalled();
    expect(replaceRoute).toHaveBeenCalledOnce();
    expect(replaceRoute).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
  });

  it("does not replace a user route with the deferred default chat location", async () => {
    const currentLocation = { pathname: "/new", search: "", hash: "" };
    const installLocation = vi.fn();

    await startModelSetupFirstRunRedirectAfterLocation({
      context: {} as ApplicationContext<RouteId>,
      enabled: false,
      history: { location: () => currentLocation, replace: vi.fn() },
      initialLocationReady: Promise.resolve({ pathname: "/chat/main", search: "", hash: "" }),
      installLocation,
      shouldInstallLocation: () => isDefaultChatLanding(currentLocation, "", routeIdFromPath),
    });

    expect(installLocation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "bootstrap token on the deferred default landing",
      initialUrl: "/?keep=yes#bootstrapToken=boot-default&bootstrapProfile=owner&tab=keep",
      expectedUrl: "/?keep=yes#tab=keep",
      expectedBootstrapToken: "boot-default",
      expectedBootstrapProfile: "owner",
      expectedToken: "",
      expectedDocumentMode: null,
    },
    {
      name: "bootstrap token on a custom-base explicit route",
      initialUrl: "/operator/settings/appearance?keep=yes#tab=keep&bootstrapToken=boot-route",
      expectedUrl: "/operator/settings/appearance?keep=yes#tab=keep",
      expectedBootstrapToken: "boot-route",
      expectedBootstrapProfile: undefined,
      expectedToken: "",
      expectedDocumentMode: null,
    },
    {
      name: "bootstrap token on a standalone approval document",
      initialUrl: "/approve/exec%3A1?keep=yes#bootstrapToken=boot-approval&tab=keep",
      expectedUrl: "/approve/exec%3A1?keep=yes#tab=keep",
      expectedBootstrapToken: "boot-approval",
      expectedBootstrapProfile: undefined,
      expectedToken: "",
      expectedDocumentMode: { kind: "approval", approvalId: "exec:1" },
    },
    {
      name: "legacy fragment token and discarded query password",
      initialUrl: "/settings/appearance?keep=yes&password=discard#token=shared-fragment&tab=keep",
      expectedUrl: "/settings/appearance?keep=yes#tab=keep",
      expectedBootstrapToken: "",
      expectedBootstrapProfile: undefined,
      expectedToken: "shared-fragment",
      expectedDocumentMode: null,
    },
    {
      name: "legacy query token and discarded fragment password",
      initialUrl: "/settings/appearance?keep=yes&token=shared-query#password=discard&tab=keep",
      expectedUrl: "/settings/appearance?keep=yes#tab=keep",
      expectedBootstrapToken: "",
      expectedBootstrapProfile: undefined,
      expectedToken: "shared-query",
      expectedDocumentMode: null,
    },
  ])("synchronously removes $name while preserving Gateway authentication", (testCase) => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", testCase.initialUrl);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let runtime: ReturnType<typeof bootstrapApplication> | undefined;

    try {
      runtime = bootstrapApplication();

      expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
        testCase.expectedUrl,
      );
      expect(replaceState).toHaveBeenCalledExactlyOnceWith({}, "", testCase.expectedUrl);
      expect(runtime.context.gateway.connection.bootstrapToken).toBe(
        testCase.expectedBootstrapToken,
      );
      expect(runtime.context.gateway.connection.bootstrapProfile).toBe(
        testCase.expectedBootstrapProfile,
      );
      expect(runtime.context.gateway.connection.token).toBe(testCase.expectedToken);
      expect(runtime.documentMode).toEqual(testCase.expectedDocumentMode);
      expect(runtime.context.gateway.snapshot.phase).toBe("stopped");
    } finally {
      warn.mockRestore();
      replaceState.mockRestore();
      runtime?.stop();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it("does not rewrite browser history when startup contains no URL credentials", () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    window.history.replaceState({}, "", "/settings/appearance?keep=yes#tab=keep");
    const replaceState = vi.spyOn(window.history, "replaceState");
    let runtime: ReturnType<typeof bootstrapApplication> | undefined;

    try {
      runtime = bootstrapApplication();

      expect(replaceState).not.toHaveBeenCalled();
      expect(window.location.search).toBe("?keep=yes");
      expect(window.location.hash).toBe("#tab=keep");
    } finally {
      replaceState.mockRestore();
      runtime?.stop();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it("keeps an inferred route namespace separate from the root resource mount", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    const previousResourceBasePath = document.documentElement.getAttribute(
      CONTROL_UI_BASE_PATH_ATTRIBUTE,
    );
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "");
    window.history.replaceState({}, "", "/__openclaw__/new");
    const runtime = bootstrapApplication();

    try {
      await runtime.start();

      expect(runtime.context.basePath).toBe("/__openclaw__");
      expect(runtime.context.resourceBasePath).toBe("");
      expect(runtime.router.getState().matches[0]?.routeId).toBe("new-session");
      expect(window.location.pathname).toBe("/__openclaw__/new");
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
      if (previousResourceBasePath === null) {
        document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
      } else {
        document.documentElement.setAttribute(
          CONTROL_UI_BASE_PATH_ATTRIBUTE,
          previousResourceBasePath,
        );
      }
    }
  });

  it("keeps the focused terminal route outside the application router", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    window.history.replaceState({}, "", "/focus/terminal");
    const runtime = bootstrapApplication();
    const routerStart = vi.spyOn(runtime.router, "start");

    try {
      await runtime.start();

      expect(window.location.pathname).toBe("/focus/terminal");
      expect(runtime.focusLocation).toEqual({
        status: "valid",
        basePath: "",
        target: { kind: "terminal" },
      });
      expect(routerStart).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it.each([
    {
      initialUrl: "/?view=terminal&keep=yes#pane",
      expectedUrl: "/focus/terminal?keep=yes#pane",
      basePath: "",
    },
    {
      initialUrl: "/openclaw/?view=terminal&keep=yes#pane",
      expectedUrl: "/openclaw/focus/terminal?keep=yes#pane",
      basePath: "/openclaw",
    },
  ])(
    "rewrites the released terminal query at the $basePath application boundary",
    async ({ initialUrl, expectedUrl, basePath }) => {
      const previousSettings = loadSettings();
      const previousUrl = window.location.href;
      window.history.replaceState({}, "", initialUrl);
      const replaceState = vi.spyOn(window.history, "replaceState");
      const runtime = bootstrapApplication();
      const routerStart = vi.spyOn(runtime.router, "start");

      try {
        expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
          expectedUrl,
        );
        expect(runtime.focusLocation).toEqual({
          status: "valid",
          basePath,
          target: { kind: "terminal" },
        });

        await runtime.start();

        expect(routerStart).not.toHaveBeenCalled();
        expect(replaceState).toHaveBeenCalledTimes(1);
      } finally {
        runtime.stop();
        replaceState.mockRestore();
        window.history.replaceState({}, "", previousUrl);
        saveSettings(previousSettings);
      }
    },
  );

  it.each(["desktop", "dashboard"])(
    "does not recognize the removed %s query presentation",
    (view) => {
      const previousSettings = loadSettings();
      const previousUrl = window.location.href;
      const initialUrl = `/?view=${view}&keep=yes#pane`;
      window.history.replaceState({}, "", initialUrl);
      const replaceState = vi.spyOn(window.history, "replaceState");
      const runtime = bootstrapApplication();

      try {
        expect(runtime.focusLocation).toBeNull();
        expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
          initialUrl,
        );
        expect(replaceState).not.toHaveBeenCalled();
      } finally {
        runtime.stop();
        replaceState.mockRestore();
        window.history.replaceState({}, "", previousUrl);
        saveSettings(previousSettings);
      }
    },
  );

  it("strips startup credentials before rewriting the released terminal query", () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    window.history.replaceState({}, "", "/?view=terminal#token=startup-token&pane=1");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const runtime = bootstrapApplication();

    try {
      expect(replaceState.mock.calls.map((call) => call[2])).toEqual([
        "/?view=terminal#pane=1",
        "/focus/terminal#pane=1",
      ]);
      expect(runtime.focusLocation).toEqual({
        status: "valid",
        basePath: "",
        target: { kind: "terminal" },
      });
    } finally {
      runtime.stop();
      replaceState.mockRestore();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it("does not recognize the terminal query outside the application root", () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    const initialUrl = "/settings/appearance?view=terminal&keep=yes#pane";
    window.history.replaceState({}, "", initialUrl);
    const runtime = bootstrapApplication();

    try {
      expect(runtime.focusLocation).toBeNull();
      expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
        initialUrl,
      );
    } finally {
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it("keeps the latest navigation requested before router start", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    window.history.replaceState({}, "", "/chat");
    const runtime = bootstrapApplication();
    const pushState = vi.spyOn(window.history, "pushState");

    try {
      const start = runtime.start();
      runtime.context.replace("about");
      runtime.context.navigate("new-session");
      expect(window.location.pathname).toBe("/chat");

      await start;

      expect(runtime.router.getState().matches[0]?.routeId).toBe("new-session");
      expect(runtime.router.getState().resolvedLocation?.pathname).toBe("/new");
      expect(window.location.pathname).toBe("/new");
      expect(pushState).toHaveBeenCalledWith({}, "", "/new");
    } finally {
      pushState.mockRestore();
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("replaces instead of pushing when re-navigating to the active location", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", "/settings/appearance");
    const runtime = bootstrapApplication();
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");

    try {
      await runtime.start();
      await runtime.context.navigateAndWait("about");
      expect(pushState).toHaveBeenCalledWith({}, "", "/settings/about");
      pushState.mockClear();
      replaceState.mockClear();

      // Re-clicking the active nav item: no new history entry, Back stays live.
      await runtime.context.navigateAndWait("about");

      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).toHaveBeenCalledWith({}, "", "/settings/about");
    } finally {
      pushState.mockRestore();
      replaceState.mockRestore();
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("does not restart routing after stop wins early startup", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    window.history.replaceState({}, "", "/");
    const runtime = bootstrapApplication();
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
      await start;

      expect(routerStart).not.toHaveBeenCalled();
      expect(redirectSubscription).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("consumes an unscoped initial-location abort after stop wins early startup", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", "/");
    const runtime = bootstrapApplication();
    const unhandledRejection = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandledRejection);

    try {
      const start = runtime.start();
      runtime.stop();
      await expect(start).resolves.toBeUndefined();
      await Promise.resolve();

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandledRejection);
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("stops a cold released-link startup without leaking its readiness subscription", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    window.history.replaceState({}, "", "/chat?session=agent%3Aresearch%3Aworkspace");
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    const activeSubscriptions = new Set<GatewayListener>();
    const createGateway = gatewayStore.createApplicationGateway;
    const gatewayFactory = vi
      .spyOn(gatewayStore, "createApplicationGateway")
      .mockImplementation((...args) => {
        const gateway = createGateway(...args);
        const subscribe = gateway.subscribe;
        // The released-link resolver subscribes during construction. Keep the
        // real owner cold and track its subscriptions before bootstrap sees it.
        vi.spyOn(gateway, "start").mockImplementation(() => {});
        vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
          activeSubscriptions.add(listener);
          const unsubscribe = subscribe(listener);
          return () => {
            activeSubscriptions.delete(listener);
            unsubscribe();
          };
        });
        return gateway;
      });
    const runtime = bootstrapApplication();
    const constructionSubscriptions = new Set(activeSubscriptions);
    const readinessSubscriptions = new Set<GatewayListener>();
    const signal = runtime.context.lifecycleAbortSignal;
    if (!signal) {
      throw new Error("expected application lifecycle signal");
    }
    signal.addEventListener("abort", () => {
      // Readiness retires on abort, before the other application disposers run.
      for (const listener of constructionSubscriptions) {
        if (!activeSubscriptions.has(listener)) {
          readinessSubscriptions.add(listener);
        }
      }
    });
    const routerStart = vi.spyOn(runtime.router, "start");
    const configRefresh = vi.spyOn(runtime.context.config, "refresh");

    try {
      const start = runtime.start();
      await Promise.resolve();
      expect(runtime.context.gateway.snapshot.phase).toBe("stopped");
      runtime.stop();
      await start;

      expect(readinessSubscriptions.size).toBe(1);
      expect(
        [...readinessSubscriptions].filter((listener) => activeSubscriptions.has(listener)),
      ).toHaveLength(0);
      expect(configRefresh).not.toHaveBeenCalled();
      expect(routerStart).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      gatewayFactory.mockRestore();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("stops the router immediately and again after an in-flight start settles", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", "/settings/appearance");
    const runtime = bootstrapApplication();
    const routerStarted = deferred<void>();
    const routerStart = vi.spyOn(runtime.router, "start").mockReturnValue(routerStarted.promise);
    const routerStop = vi.spyOn(runtime.router, "stop");

    try {
      const start = runtime.start();
      await vi.waitFor(() => expect(routerStart).toHaveBeenCalledOnce(), STARTUP_STEP_WAIT);
      runtime.stop();
      expect(routerStop).toHaveBeenCalledOnce();

      routerStarted.resolve();
      await start;
      expect(routerStop).toHaveBeenCalledTimes(2);
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("resolves runtime startup when the initial route is not found", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", "/settings/about");
    const runtime = bootstrapApplication();
    const routerStart = vi
      .spyOn(runtime.router, "start")
      .mockRejectedValue({ type: "notFound", data: { routeId: "chat" } });

    try {
      await expect(runtime.start()).resolves.toBeUndefined();
      expect(routerStart).toHaveBeenCalledOnce();
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("applies and refreshes the saved accent before the gateway connects", () => {
    const previousSettings = loadSettings();
    saveSettings({ ...previousSettings, accent: "#48D6C2" });
    const runtime = bootstrapApplication();

    try {
      expect(runtime.context.gateway.snapshot.phase).toBe("stopped");
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#48d6c2");
      expect(runtime.context.theme.settings.accent).toBe("#48d6c2");

      saveSettings({ ...loadSettings(), accent: "#f4b740" });
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#f4b740");
      expect(runtime.context.theme.settings.accent).toBe("#f4b740");
    } finally {
      saveSettings(previousSettings);
      runtime.context.theme.refresh();
      runtime.stop();
    }
  });

  it("synchronizes every theme-color meta with the resolved theme background", () => {
    const previousSettings = loadSettings();
    const style = document.createElement("style");
    style.textContent = ':root[data-theme="light"] { --bg: #123456; }';
    const lightMeta = document.createElement("meta");
    lightMeta.name = "theme-color";
    lightMeta.media = "(prefers-color-scheme: light)";
    const darkMeta = document.createElement("meta");
    darkMeta.name = "theme-color";
    darkMeta.media = "(prefers-color-scheme: dark)";
    document.head.append(style, lightMeta, darkMeta);
    saveSettings({ ...previousSettings, theme: "claw", themeMode: "light" });
    const runtime = bootstrapApplication();

    try {
      expect(lightMeta.content).toBe("#123456");
      expect(darkMeta.content).toBe("#123456");
      expect(lightMeta.hasAttribute("media")).toBe(false);
      expect(darkMeta.hasAttribute("media")).toBe(false);
    } finally {
      runtime.stop();
      style.remove();
      lightMeta.remove();
      darkMeta.remove();
      saveSettings(previousSettings);
    }
  });

  it("refreshes chat browser chrome on route and breakpoint changes", () => {
    const previousSettings = loadSettings();
    const listeners = new Set<() => void>();
    let mobile = false;
    const removeEventListener = vi.fn((_: string, listener: () => void) => {
      listeners.delete(listener);
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.startsWith("(max-width: 768px)") ? mobile : false,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener,
      })),
    );
    const style = document.createElement("style");
    style.textContent = ':root[data-theme="light"] { --bg: #123456; --bg-content: #abcdef; }';
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(style, meta);
    saveSettings({ ...previousSettings, theme: "claw", themeMode: "light" });
    const runtime = bootstrapApplication();

    try {
      expect(meta.content).toBe("#123456");
      expect(
        document.documentElement.style.getPropertyValue("--control-ui-system-chrome-background"),
      ).toBe("#123456");

      document.body.innerHTML = '<div class="shell--chat"></div>';
      mobile = true;
      for (const listener of listeners) {
        listener();
      }
      expect(meta.content).toBe("#abcdef");
      expect(
        document.documentElement.style.getPropertyValue("--control-ui-system-chrome-background"),
      ).toBe("#abcdef");

      document.body.replaceChildren();
      for (const listener of listeners) {
        listener();
      }
      expect(meta.content).toBe("#123456");

      document.body.innerHTML = '<div class="shell--chat"></div>';
      for (const listener of listeners) {
        listener();
      }
      expect(meta.content).toBe("#abcdef");

      mobile = false;
      for (const listener of listeners) {
        listener();
      }
      expect(meta.content).toBe("#123456");
    } finally {
      runtime.stop();
      document.body.replaceChildren();
      expect(removeEventListener).toHaveBeenCalled();
      style.remove();
      meta.remove();
      saveSettings(previousSettings);
      vi.unstubAllGlobals();
    }
  });
});
