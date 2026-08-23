import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { routeIdFromPath, type RouteId } from "../app-routes.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import {
  isDefaultChatLanding,
  startModelSetupFirstRunRedirectAfterLocation,
} from "../pages/model-setup/first-run.ts";
import {
  normalizeInitialApplicationLocation,
  resolveInitialApplicationLocation,
} from "./bootstrap-location.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
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
      agentsList: () => ({ defaultId: "main", mainKey: "main", agents: [] }),
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
      agentsList: () => ({ defaultId: "main", mainKey: "main", agents: [] }),
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
      runtime = bootstrapApplication({ sessionPathBuilderReady: deferred<void>().promise });

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
      runtime = bootstrapApplication({ sessionPathBuilderReady: deferred<void>().promise });

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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });

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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
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
      const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
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
      const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });

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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });

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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });

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
    const sessionPathBuilder = deferred<void>();
    const runtime = bootstrapApplication({ sessionPathBuilderReady: sessionPathBuilder.promise });
    const pushState = vi.spyOn(window.history, "pushState");

    try {
      const start = runtime.start();
      runtime.context.replace("about");
      runtime.context.navigate("new-session");
      expect(window.location.pathname).toBe("/chat");

      sessionPathBuilder.resolve();
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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
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

  it("consumes an unscoped initial-location abort after stop wins the loader race", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", "/");
    const sessionPathBuilder = deferred<void>();
    const runtime = bootstrapApplication({ sessionPathBuilderReady: sessionPathBuilder.promise });
    const unhandledRejection = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandledRejection);

    try {
      const start = runtime.start();
      runtime.stop();
      sessionPathBuilder.resolve();
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

  it("stops a cold released-link startup without leaking its late subscription", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    window.history.replaceState({}, "", "/chat?session=agent%3Aresearch%3Aworkspace");
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    const gateway = runtime.context.gateway as ApplicationContext<RouteId>["gateway"] & {
      subscribe: (listener: GatewayListener) => () => void;
    };
    const activeSubscriptions = new Set<GatewayListener>();
    gateway.subscribe = (listener) => {
      // Keep the released-link resolver genuinely cold. Forwarding to the live
      // gateway lets a fast connection remove this transient subscription before
      // stop() can prove its abort cleanup.
      activeSubscriptions.add(listener);
      return () => {
        activeSubscriptions.delete(listener);
      };
    };
    const routerStart = vi.spyOn(runtime.router, "start");
    const configRefresh = vi.spyOn(runtime.context.config, "refresh");

    try {
      const start = runtime.start();
      await vi.waitFor(() => expect(activeSubscriptions.size).toBe(1), STARTUP_STEP_WAIT);
      runtime.stop();
      await start;

      expect(activeSubscriptions.size).toBe(0);
      expect(configRefresh).not.toHaveBeenCalled();
      expect(routerStart).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
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
    const runtime = bootstrapApplication({ sessionPathBuilderReady: deferred<void>().promise });

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
});
