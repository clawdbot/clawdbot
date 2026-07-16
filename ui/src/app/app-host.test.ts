/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import "./app-host.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "./context.ts";
import { navigationSurfaceIsHidden, renderFloatingUpdateCard } from "./navigation-surface.ts";

type AppLifecycleState = {
  loginToken: string;
  loginPassword: string;
  loginShowGatewayToken: boolean;
  loginShowGatewayPassword: boolean;
  disconnectedCallback: () => void;
  synchronizeGateway: (gateway: ApplicationGateway) => void;
};

type ShellInitializationState = {
  routeState: { routeId?: string };
  ensureAgentsList: (
    snapshot: { client: GatewayBrowserClient | null; connected: boolean },
    agents: ApplicationContext["agents"],
  ) => void;
  ensureRuntimeConfig: (
    snapshot: { client: GatewayBrowserClient | null; connected: boolean },
    runtimeConfig: ApplicationContext["runtimeConfig"],
  ) => void;
};

type ShellKeyboardState = {
  runtime: {
    context: ApplicationContext;
  };
  handleDocumentKeydown: (event: KeyboardEvent) => void;
};

type TestOptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: () => Promise<unknown>;
};

type ShellLazySurfaceState = ShellKeyboardState & {
  browserPanelElement: TestOptionalCustomElement;
  commandPaletteElement: TestOptionalCustomElement;
  handleDeferredBrowserToggle: (event: Event) => void;
  handleDeferredTerminalToggle: (event: Event) => void;
  terminalPanelElement: TestOptionalCustomElement;
};

let lazyElementSequence = 0;

function createLazyElementSpec(label: string): TestOptionalCustomElement {
  lazyElementSequence += 1;
  const tagName = `openclaw-app-host-lazy-${lazyElementSequence}`;
  return {
    tagName,
    label,
    loadModule: async () => {
      customElements.define(tagName, class extends HTMLElement {});
    },
  };
}

type ShellNavigationState = {
  runtime: {
    context: ApplicationContext;
  };
  handleNativeToggleSidebar: () => void;
  handleNativeOpenSearch: () => void;
  handleNativeToggleSearch: (event: Event) => void;
  handleNativeNewSession: () => void;
  handleNativeHistoryState: (event: Event) => void;
  nativeHistoryState: { canGoBack: boolean; canGoForward: boolean };
  onboarding: boolean;
  updated: () => void;
};

type ShellSettingsSearchLoadState = {
  runtime: {
    context: ApplicationContext;
  };
  handleSettingsSearchQueryChange: (query: string) => Promise<void>;
};

type TestWebKitWindow = Window & {
  webkit?: {
    messageHandlers: {
      openclawNav: { postMessage: (message: unknown) => void };
    };
  };
};

afterEach(() => {
  Reflect.deleteProperty(window, "webkit");
});

type ShellEpochState = {
  navDrawerOpen: boolean;
  navDrawerTrigger: HTMLElement | null;
  lastWorkspaceLocation: { routeId: string; search: string } | null;
  activeSessionKey: string;
  commandPaletteTarget: unknown;
  agentsListClient: GatewayBrowserClient | null;
  agentsListSource: ApplicationContext["agents"] | null;
  sessionKeyClient: GatewayBrowserClient | null;
  runtimeConfigClient: GatewayBrowserClient | null;
  runtimeConfigSource: ApplicationContext["runtimeConfig"] | null;
  settingsPreloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
  disconnectedCallback: () => void;
};

describe("OpenClaw app lifecycle", () => {
  it("hides revealed login credentials when the app connection epoch ends", () => {
    const app = document.createElement("openclaw-app") as unknown as AppLifecycleState;
    app.loginShowGatewayToken = true;
    app.loginShowGatewayPassword = true;

    app.disconnectedCallback();

    expect(app.loginShowGatewayToken).toBe(false);
    expect(app.loginShowGatewayPassword).toBe(false);
  });

  it("hides revealed login credentials when the Gateway source changes", () => {
    const app = document.createElement("openclaw-app") as unknown as AppLifecycleState;
    const snapshot = {
      client: null,
      connected: false,
      reconnecting: false,
      lastError: null,
      lastErrorCode: null,
    } as ApplicationGatewaySnapshot;
    const firstGateway = {
      snapshot,
      connection: { gatewayUrl: "ws://first.test", token: "first", password: "first-password" },
    } as ApplicationGateway;
    const secondGateway = {
      snapshot,
      connection: {
        gatewayUrl: "ws://second.test",
        token: "second",
        password: "second-password",
      },
    } as ApplicationGateway;
    app.synchronizeGateway(firstGateway);
    app.loginShowGatewayToken = true;
    app.loginShowGatewayPassword = true;

    app.synchronizeGateway(secondGateway);

    expect(app.loginShowGatewayToken).toBe(false);
    expect(app.loginShowGatewayPassword).toBe(false);
    expect(app.loginToken).toBe("second");
    expect(app.loginPassword).toBe("second-password");
  });
});

describe("OpenClaw shell source initialization", () => {
  it("clears retained presentation and source ownership when its context epoch ends", () => {
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellEpochState;
    const client = {} as GatewayBrowserClient;
    const agents = {} as ApplicationContext["agents"];
    const runtimeConfig = {} as ApplicationContext["runtimeConfig"];
    const trigger = document.createElement("button");
    shell.navDrawerOpen = true;
    shell.navDrawerTrigger = trigger;
    shell.lastWorkspaceLocation = { routeId: "usage", search: "?agent=old" };
    shell.activeSessionKey = "agent:old:main";
    shell.commandPaletteTarget = {};
    shell.agentsListClient = client;
    shell.agentsListSource = agents;
    shell.sessionKeyClient = client;
    shell.runtimeConfigClient = client;
    shell.runtimeConfigSource = runtimeConfig;
    shell.settingsPreloadTimers.set(
      trigger,
      globalThis.setTimeout(() => undefined, 60_000),
    );

    shell.disconnectedCallback();

    expect(shell.navDrawerOpen).toBe(false);
    expect(shell.navDrawerTrigger).toBeNull();
    expect(shell.lastWorkspaceLocation).toBeNull();
    expect(shell.activeSessionKey).toBe("");
    expect(shell.commandPaletteTarget).toBeUndefined();
    expect(shell.agentsListClient).toBeNull();
    expect(shell.agentsListSource).toBeNull();
    expect(shell.sessionKeyClient).toBeNull();
    expect(shell.runtimeConfigClient).toBeNull();
    expect(shell.runtimeConfigSource).toBeNull();
    expect(shell.settingsPreloadTimers.size).toBe(0);
  });

  it("initializes replacement capabilities even when the Gateway client is unchanged", () => {
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellInitializationState;
    shell.routeState = { routeId: "usage" };
    const client = {} as GatewayBrowserClient;
    const snapshot = { client, connected: true };
    const firstAgents = {
      state: { agentsList: null },
      ensureList: vi.fn(() => Promise.resolve(null)),
    } as unknown as ApplicationContext["agents"];
    const secondAgents = {
      state: { agentsList: null },
      ensureList: vi.fn(() => Promise.resolve(null)),
    } as unknown as ApplicationContext["agents"];
    const firstRuntimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];
    const secondRuntimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];

    shell.ensureAgentsList(snapshot, firstAgents);
    shell.ensureAgentsList(snapshot, firstAgents);
    shell.ensureAgentsList(snapshot, secondAgents);
    shell.ensureRuntimeConfig(snapshot, firstRuntimeConfig);
    shell.ensureRuntimeConfig(snapshot, firstRuntimeConfig);
    shell.ensureRuntimeConfig(snapshot, secondRuntimeConfig);

    expect(firstAgents.ensureList).toHaveBeenCalledOnce();
    expect(secondAgents.ensureList).toHaveBeenCalledOnce();
    expect(firstRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(secondRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();
  });
});

describe("OpenClaw shell settings search", () => {
  it("loads config and schema for a non-empty query", async () => {
    const runtimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
      ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsSearchLoadState;
    shell.runtime = {
      context: { runtimeConfig } as unknown as ApplicationContext,
    };

    await shell.handleSettingsSearchQueryChange("browser");

    expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(runtimeConfig.ensureSchemaLoaded).toHaveBeenCalledOnce();
  });

  it("does not load schema through a replaced runtime config capability", async () => {
    let finishLoad: (() => void) | undefined;
    const firstRuntimeConfig = {
      ensureLoaded: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishLoad = resolve;
          }),
      ),
      ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];
    const secondRuntimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
      ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsSearchLoadState;
    shell.runtime = {
      context: { runtimeConfig: firstRuntimeConfig } as unknown as ApplicationContext,
    };

    const load = shell.handleSettingsSearchQueryChange("browser");
    shell.runtime = {
      context: { runtimeConfig: secondRuntimeConfig } as unknown as ApplicationContext,
    };
    finishLoad?.();
    await load;

    expect(firstRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(firstRuntimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
    expect(secondRuntimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
  });

  it.each(["config", "schema"] as const)(
    "contains rejected %s loads within settings search",
    async (failureStage) => {
      const runtimeConfig = {
        ensureLoaded: vi.fn(() =>
          failureStage === "config"
            ? Promise.reject(new Error("config unavailable"))
            : Promise.resolve(),
        ),
        ensureSchemaLoaded: vi.fn(() =>
          failureStage === "schema"
            ? Promise.reject(new Error("schema unavailable"))
            : Promise.resolve(),
        ),
      } as unknown as ApplicationContext["runtimeConfig"];
      const shell = document.createElement(
        "openclaw-app-shell",
      ) as unknown as ShellSettingsSearchLoadState;
      shell.runtime = {
        context: { runtimeConfig } as unknown as ApplicationContext,
      };

      await expect(shell.handleSettingsSearchQueryChange("browser")).resolves.toBeUndefined();

      expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
      expect(runtimeConfig.ensureSchemaLoaded).toHaveBeenCalledTimes(
        failureStage === "schema" ? 1 : 0,
      );
    },
  );
});

describe("OpenClaw shell keyboard shortcuts", () => {
  it("loads and toggles the command palette on its first shortcut", async () => {
    const element = createLazyElementSpec("command palette");
    const togglePalette = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellLazySurfaceState;
    shell.commandPaletteElement = element;
    Object.defineProperty(shell, "updateComplete", {
      configurable: true,
      get: () => Promise.resolve(true),
    });
    Object.defineProperty(shell, "commandPalette", {
      configurable: true,
      get: () =>
        customElements.get(element.tagName)
          ? { isOpen: false, openPalette: vi.fn(), togglePalette }
          : undefined,
    });
    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(togglePalette).toHaveBeenCalledOnce());
  });

  it("delivers first panel toggles after their lazy modules load", async () => {
    const terminalElement = createLazyElementSpec("terminal panel");
    const browserElement = createLazyElementSpec("browser panel");
    const terminalToggle = vi.fn();
    const browserToggle = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellLazySurfaceState;
    shell.terminalPanelElement = terminalElement;
    shell.browserPanelElement = browserElement;
    shell.runtime = {
      context: {
        gateway: {
          snapshot: {
            connected: true,
            hello: {
              auth: { role: "operator", scopes: ["operator.admin"] },
              features: { methods: ["terminal.open", "browser.request"] },
            },
          },
        },
        config: { current: { terminalEnabled: true } },
      } as unknown as ApplicationContext,
    };
    Object.defineProperty(shell, "updateComplete", {
      configurable: true,
      get: () => Promise.resolve(true),
    });
    Object.defineProperty(shell, "querySelector", {
      configurable: true,
      value: (selector: string) => {
        if (selector === terminalElement.tagName) {
          return { handleToggleRequest: terminalToggle };
        }
        if (selector === browserElement.tagName) {
          return { handleToggleRequest: browserToggle };
        }
        return null;
      },
    });
    const terminalEvent = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
      detail: { dock: "right", open: true },
    });
    const browserEvent = new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT);

    shell.handleDeferredTerminalToggle(terminalEvent);
    shell.handleDeferredBrowserToggle(browserEvent);

    await vi.waitFor(() => {
      expect(terminalToggle).toHaveBeenCalledWith(terminalEvent);
      expect(browserToggle).toHaveBeenCalledWith(browserEvent);
    });
  });

  it("opens Settings with Shift-Command-Comma", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
    shell.runtime = {
      context: {
        navigate,
      } as unknown as ApplicationContext,
    };
    const event = new KeyboardEvent("keydown", {
      key: "<",
      code: "Comma",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("config", undefined);
  });

  it("toggles the navigation sidebar when the native macOS titlebar button fires", () => {
    const snapshot = { navCollapsed: false };
    const update = vi.fn((next: { navCollapsed: boolean }) => {
      snapshot.navCollapsed = next.navCollapsed;
    });
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
    shell.runtime = {
      context: {
        navigation: { snapshot, update },
      } as unknown as ApplicationContext,
    };

    shell.handleNativeToggleSidebar();
    expect(update).toHaveBeenLastCalledWith({ navCollapsed: true });

    shell.handleNativeToggleSidebar();
    expect(update).toHaveBeenLastCalledWith({ navCollapsed: false });
  });

  it("opens search and starts a session from native titlebar events", () => {
    const navigate = vi.fn();
    const openPalette = vi.fn();
    const togglePalette = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
    Object.defineProperty(shell, "commandPalette", {
      configurable: true,
      value: { openPalette, togglePalette },
    });
    shell.runtime = {
      context: {
        navigate,
        agentSelection: { state: { selectedId: "agent/a" } },
      } as unknown as ApplicationContext,
    };
    shell.handleNativeOpenSearch();
    const toggleEvent = new CustomEvent("openclaw:native-toggle-search", { cancelable: true });
    shell.handleNativeToggleSearch(toggleEvent);
    shell.handleNativeNewSession();

    expect(openPalette).toHaveBeenCalledOnce();
    expect(togglePalette).toHaveBeenCalledOnce();
    // preventDefault is the handled signal for the native legacy fallback.
    expect(toggleEvent.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("new-session", { search: "?agent=agent%2Fa" });
  });

  it("retains a native new-session request until a context exists", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;

    shell.handleNativeNewSession();

    shell.runtime = {
      context: {
        navigate,
        agentSelection: { state: { selectedId: "main" } },
      } as unknown as ApplicationContext,
    };
    shell.handleNativeNewSession();

    expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", { search: "?agent=main" });
  });

  it("does not start a native session during onboarding", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
    shell.runtime = {
      context: {
        navigate,
        agentSelection: { state: { selectedId: "main" } },
      } as unknown as ApplicationContext,
    };
    shell.onboarding = true;

    shell.handleNativeNewSession();

    expect(navigate).not.toHaveBeenCalled();
  });

  it("updates native history state from the host event", () => {
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
    shell.handleNativeHistoryState(
      new CustomEvent("openclaw:native-history-state", {
        detail: { canGoBack: true, canGoForward: false },
      }),
    );

    expect(shell.nativeHistoryState).toEqual({ canGoBack: true, canGoForward: false });
  });

  it("deduplicates native nav state reports", () => {
    const postMessage = vi.fn();
    (window as TestWebKitWindow).webkit = {
      messageHandlers: { openclawNav: { postMessage } },
    };
    const snapshot = { navCollapsed: false, navWidth: 280 };
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
    shell.runtime = {
      context: {
        navigation: { snapshot },
      } as unknown as ApplicationContext,
    };

    shell.updated();
    shell.updated();
    snapshot.navCollapsed = true;
    shell.updated();

    expect(postMessage.mock.calls).toEqual([
      [{ type: "nav-state", collapsed: false, width: 280 }],
      [{ type: "nav-state", collapsed: true, width: 280 }],
    ]);
  });

  it("leaves plain Command-Comma to the browser", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
    shell.runtime = {
      context: {
        navigate,
      } as unknown as ApplicationContext,
    };
    const event = new KeyboardEvent("keydown", {
      key: ",",
      code: "Comma",
      metaKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("OpenClaw shell update affordance", () => {
  it("renders a floating card only while desktop navigation is collapsed", () => {
    const container = document.createElement("div");
    const shared = {
      onboarding: false,
      updateAvailable: {
        currentVersion: "2026.7.1",
        latestVersion: "2026.7.2",
        channel: "stable" as const,
      },
      updateRunning: false,
      onUpdate: vi.fn(),
    };
    const collapsed = navigationSurfaceIsHidden({
      navCollapsed: true,
      navDrawerOpen: false,
      mobileNavLayout: false,
    });
    render(renderFloatingUpdateCard({ ...shared, navigationSurfaceHidden: collapsed }), container);
    expect(container.querySelector("openclaw-sidebar-update-card")).not.toBeNull();

    const visible = navigationSurfaceIsHidden({
      navCollapsed: false,
      navDrawerOpen: false,
      mobileNavLayout: false,
    });
    render(renderFloatingUpdateCard({ ...shared, navigationSurfaceHidden: visible }), container);
    expect(container.querySelector("openclaw-sidebar-update-card")).toBeNull();
  });

  it("treats a closed mobile drawer as hidden navigation", () => {
    expect(
      navigationSurfaceIsHidden({
        navCollapsed: false,
        navDrawerOpen: false,
        mobileNavLayout: true,
      }),
    ).toBe(true);
    expect(
      navigationSurfaceIsHidden({
        navCollapsed: false,
        navDrawerOpen: true,
        mobileNavLayout: true,
      }),
    ).toBe(false);
  });
});
