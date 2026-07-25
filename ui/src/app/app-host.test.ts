/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, GatewayAgentRow } from "../api/types.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
} from "../components/command-palette-contract.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  UI_COMMAND_EVENT,
} from "../components/panel-toggle-contract.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "./context.ts";
import { shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import { navigationSurfaceIsHidden, renderFloatingUpdateCard } from "./navigation-surface.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";

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
    snapshot: ApplicationGatewaySnapshot,
    agents: ApplicationContext["agents"],
  ) => void;
  ensureRuntimeConfig: (
    snapshot: ApplicationGatewaySnapshot,
    runtimeConfig: ApplicationContext["runtimeConfig"],
  ) => void;
};

type ShellServerPreferencesState = {
  runtime: { context: ApplicationContext };
  reconcileServerUiPrefs: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
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

type ShellApprovalLazyState = {
  approvalOverlay?: { show: () => void };
  execApprovalElement: TestOptionalCustomElement;
  openApprovals: () => void;
};

type ShellUiCommandState = ShellKeyboardState & {
  handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
};

function roster(defaultId: string, agents: GatewayAgentRow[]): AgentsListResult {
  return { defaultId, mainKey: "main", scope: "per-sender", agents };
}

function createRosterRefreshContext(params: {
  previous: AgentsListResult;
  next: AgentsListResult;
  selectedId: string;
}) {
  const agentsState = { agentsList: params.previous };
  const selectionState = { selectedId: params.selectedId, scopeId: params.selectedId };
  const refreshList = vi.fn(async () => {
    agentsState.agentsList = params.next;
    return params.next;
  });
  const invalidateFiles = vi.fn();
  const invalidateIdentity = vi.fn();
  const ensureIdentity = vi.fn(async () => undefined);
  const setSelection = vi.fn((agentId: string) => {
    selectionState.selectedId = agentId;
    selectionState.scopeId = agentId;
  });
  const refreshConfig = vi.fn(async () => null);
  const context = {
    agents: {
      state: agentsState,
      refreshList,
      invalidateFiles,
    },
    agentIdentity: {
      invalidate: invalidateIdentity,
      ensure: ensureIdentity,
    },
    agentSelection: {
      state: selectionState,
      set: setSelection,
    },
    runtimeConfig: {
      state: { configFormDirty: false },
      refresh: refreshConfig,
    },
  } as unknown as ApplicationContext;
  return {
    context,
    refreshList,
    invalidateFiles,
    invalidateIdentity,
    ensureIdentity,
    setSelection,
    refreshConfig,
  };
}

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

type ShellChromeEventState = {
  runtime: { context: ApplicationContext };
  navDrawerOpen: boolean;
  handleShellNavDrawerToggle: (event: Event) => void;
  openPalette: () => void;
  connectedCallback: () => void;
  disconnectedCallback: () => void;
};

function createDragEvent(type: "dragover" | "drop", types: string[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dataTransfer = { dropEffect: "copy", types };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return { dataTransfer, event };
}

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

type MacosTitlebarControlsState = HTMLElement & {
  navCollapsed: boolean;
  historyOnly: boolean;
  onOpenPalette?: () => void;
  onOpenNewSession?: () => void;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "webkit");
  document.documentElement.classList.remove(
    "openclaw-native-macos",
    "openclaw-native-nav",
    "openclaw-native-web-chrome",
  );
  vi.unstubAllGlobals();
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
      phase: "stopped",
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
    const snapshot = { client, phase: "connected" } as ApplicationGatewaySnapshot;
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

describe("OpenClaw shell server preferences", () => {
  it("refreshes live navigation when a sidebar preference arrives from the gateway", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];
    const updateNavigation = vi.fn();
    const refreshTheme = vi.fn();
    const runtimeConfig = {
      state: {
        configSnapshot: {
          config: { ui: { prefs: { sidebarEntries } } },
          hash: "sidebar-config-hash",
        },
      },
    } as unknown as ApplicationContext["runtimeConfig"];
    const context = {
      gateway: { connection: { gatewayUrl: "ws://sidebar.test" } },
      navigation: { update: updateNavigation },
      theme: { refresh: refreshTheme },
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    shell.reconcileServerUiPrefs(runtimeConfig);

    expect(updateNavigation).toHaveBeenCalledWith({ sidebarEntries });
    expect(refreshTheme).toHaveBeenCalledOnce();
    resetServerUiPrefsSync();
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
  it("resolves onboarding mode from the active route search", () => {
    expect(resolveOnboardingMode("?onboarding=1")).toBe(true);
    expect(resolveOnboardingMode("?onboarding=true")).toBe(true);
    expect(resolveOnboardingMode("?onboarding=0")).toBe(false);
    expect(resolveOnboardingMode("")).toBe(false);
  });

  it("merges shell chrome only for plain-browser mobile chat", () => {
    expect(
      shouldMergeChatChrome({ mobileNavLayout: true, routeId: "chat", onboarding: false }),
    ).toBe(true);
    expect(
      shouldMergeChatChrome({ mobileNavLayout: false, routeId: "chat", onboarding: false }),
    ).toBe(false);
    expect(
      shouldMergeChatChrome({ mobileNavLayout: true, routeId: "sessions", onboarding: false }),
    ).toBe(false);
    expect(
      shouldMergeChatChrome({ mobileNavLayout: true, routeId: "chat", onboarding: true }),
    ).toBe(false);

    document.documentElement.classList.add("openclaw-native-nav");
    expect(
      shouldMergeChatChrome({ mobileNavLayout: true, routeId: "chat", onboarding: false }),
    ).toBe(false);
  });

  it("wires merged header window events for the shell lifecycle", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellChromeEventState;

    shell.connectedCallback();

    expect(addEventListener).toHaveBeenCalledWith(COMMAND_PALETTE_OPEN_EVENT, expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith(
      SHELL_NAV_DRAWER_TOGGLE_EVENT,
      expect.any(Function),
    );
    shell.disconnectedCallback();
    addEventListener.mockRestore();
  });

  it("prevents unhandled window file drops without overriding accepted targets", () => {
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellChromeEventState;
    const acceptedDropTarget = document.createElement("div");
    const nativeFileInput = document.createElement("input");
    nativeFileInput.type = "file";
    document.body.append(acceptedDropTarget, nativeFileInput);
    shell.connectedCallback();

    try {
      for (const type of ["dragover", "drop"] as const) {
        const unhandled = createDragEvent(type, ["Files"]);
        window.dispatchEvent(unhandled.event);
        expect(unhandled.event.defaultPrevented).toBe(true);
        expect(unhandled.dataTransfer.dropEffect).toBe("none");

        const accepted = createDragEvent(type, ["Files"]);
        acceptedDropTarget.addEventListener(type, (event) => event.preventDefault(), {
          once: true,
        });
        acceptedDropTarget.dispatchEvent(accepted.event);
        expect(accepted.event.defaultPrevented).toBe(true);
        expect(accepted.dataTransfer.dropEffect).toBe("copy");

        const nativeAccepted = createDragEvent(type, ["Files"]);
        nativeFileInput.dispatchEvent(nativeAccepted.event);
        expect(nativeAccepted.event.defaultPrevented).toBe(false);
        expect(nativeAccepted.dataTransfer.dropEffect).toBe("copy");

        const nonFile = createDragEvent(type, ["text/plain"]);
        window.dispatchEvent(nonFile.event);
        expect(nonFile.event.defaultPrevented).toBe(false);
        expect(nonFile.dataTransfer.dropEffect).toBe("copy");
      }
    } finally {
      shell.disconnectedCallback();
      acceptedDropTarget.remove();
      nativeFileInput.remove();
    }
  });

  it("handles merged header drawer and palette requests", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const openPalette = vi.fn();
    const trigger = document.createElement("button");
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellChromeEventState;
    shell.runtime = {
      context: {
        navigation: { snapshot: { navCollapsed: false }, update: vi.fn() },
      } as unknown as ApplicationContext,
    };
    Object.defineProperty(shell, "commandPalette", {
      configurable: true,
      value: { isOpen: false, openPalette, togglePalette: vi.fn() },
    });

    shell.handleShellNavDrawerToggle(
      new CustomEvent(SHELL_NAV_DRAWER_TOGGLE_EVENT, { detail: { trigger } }),
    );
    shell.openPalette();

    expect(shell.navDrawerOpen).toBe(true);
    expect(openPalette).toHaveBeenCalledOnce();
  });

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
            phase: "connected",
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

  it("opens approvals after the modal module loads on demand", async () => {
    const element = createLazyElementSpec("exec approval modal");
    const show = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellApprovalLazyState;
    shell.execApprovalElement = element;
    Object.defineProperty(shell, "updateComplete", {
      configurable: true,
      get: () => Promise.resolve(true),
    });
    Object.defineProperty(shell, "approvalOverlay", {
      configurable: true,
      get: () => (customElements.get(element.tagName) ? { show } : undefined),
    });

    shell.openApprovals();

    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
  });

  it("routes UI commands to navigation, panels, and chat fallback", () => {
    const update = vi.fn();
    const setSessionKey = vi.fn();
    const navigate = vi.fn();
    const panelEvent = vi.fn();
    const uiCommandEvent = vi.fn();
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, panelEvent);
    window.addEventListener(UI_COMMAND_EVENT, uiCommandEvent);
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellUiCommandState;
    shell.runtime = {
      context: {
        navigation: { update },
        gateway: { setSessionKey },
        navigate,
      } as unknown as ApplicationContext,
    };

    shell.handleGatewayEvent({
      event: "ui.command",
      payload: { command: { kind: "sidebar", visible: false } },
    });
    shell.handleGatewayEvent({
      event: "ui.command",
      payload: {
        command: {
          kind: "panel",
          panel: "terminal",
          open: true,
          dock: "right",
          terminalSessionId: "terminal-agent-1",
        },
      },
    });
    shell.handleGatewayEvent({
      event: "ui.command",
      payload: {
        command: { kind: "split", direction: "right", sessionKey: "agent:main:other" },
      },
    });
    shell.handleGatewayEvent({
      event: "ui.command",
      payload: {
        command: { kind: "focus", sessionKey: "agent:main:other" },
        sessionKey: "agent:main:source",
      },
    });

    expect(update).toHaveBeenCalledWith({ navCollapsed: true });
    expect(panelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { open: true, dock: "right", terminalSessionId: "terminal-agent-1" },
      }),
    );
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:other");
    expect(navigate).toHaveBeenCalledWith("chat", { search: "?session=agent%3Amain%3Aother" });
    expect(uiCommandEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: {
          command: { kind: "focus", sessionKey: "agent:main:other" },
          sessionKey: "agent:main:source",
        },
      }),
    );
    window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, panelEvent);
    window.removeEventListener(UI_COMMAND_EVENT, uiCommandEvent);
  });

  it("refreshes the roster on config.changed and invalidates removed or changed agents", async () => {
    vi.useFakeTimers();
    const harness = createRosterRefreshContext({
      previous: roster("main", [
        { id: "main", name: "Main" },
        { id: "writer", name: "Writer" },
        { id: "retired", name: "Retired" },
      ]),
      next: roster("main", [
        { id: "main", name: "Main" },
        { id: "writer", name: "Editor" },
        { id: "new-agent", name: "New" },
      ]),
      selectedId: "main",
    });
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellUiCommandState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.refreshConfig).toHaveBeenCalledOnce();
    expect(harness.refreshList).toHaveBeenCalledOnce();
    expect(harness.invalidateFiles).toHaveBeenCalledWith(["writer", "retired"]);
    expect(harness.invalidateIdentity).toHaveBeenCalledWith(["writer", "retired"]);
    expect(harness.ensureIdentity).toHaveBeenCalledWith(["writer"]);
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it("moves a deleted active agent to the refreshed roster default", async () => {
    vi.useFakeTimers();
    const harness = createRosterRefreshContext({
      previous: roster("writer", [{ id: "fallback" }, { id: "main" }, { id: "writer" }]),
      next: roster("main", [{ id: "fallback" }, { id: "main" }]),
      selectedId: "writer",
    });
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellUiCommandState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.setSelection).toHaveBeenCalledExactlyOnceWith("main");
  });

  it("keeps caches intact when a config.changed refresh returns the same roster", async () => {
    vi.useFakeTimers();
    const unchanged = roster("main", [{ id: "main", name: "Main" }, { id: "writer" }]);
    const harness = createRosterRefreshContext({
      previous: unchanged,
      next: structuredClone(unchanged),
      selectedId: "main",
    });
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellUiCommandState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.refreshList).toHaveBeenCalledOnce();
    expect(harness.invalidateFiles).not.toHaveBeenCalled();
    expect(harness.invalidateIdentity).not.toHaveBeenCalled();
    expect(harness.ensureIdentity).not.toHaveBeenCalled();
  });

  it("coalesces config.changed bursts into one roster refresh", async () => {
    vi.useFakeTimers();
    const unchanged = roster("main", [{ id: "main" }]);
    const harness = createRosterRefreshContext({
      previous: unchanged,
      next: unchanged,
      selectedId: "main",
    });
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellUiCommandState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(99);
    expect(harness.refreshList).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.refreshList).toHaveBeenCalledOnce();
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

  it("opens Settings with Ctrl-Shift-Comma", () => {
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
      ctrlKey: true,
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

  it("keeps the new-thread control in the native titlebar only while collapsed", async () => {
    const onOpenPalette = vi.fn();
    const onOpenNewSession = vi.fn();
    const controls = document.createElement(
      "openclaw-macos-titlebar-controls",
    ) as unknown as MacosTitlebarControlsState;
    controls.navCollapsed = false;
    controls.historyOnly = false;
    controls.onOpenPalette = onOpenPalette;
    controls.onOpenNewSession = onOpenNewSession;
    document.body.append(controls);
    await controls.updateComplete;

    controls.querySelector<HTMLButtonElement>(".macos-titlebar-controls__search")?.click();
    expect(controls.querySelector(".macos-titlebar-controls__new-session")).toBeNull();

    controls.navCollapsed = true;
    await controls.updateComplete;
    controls.querySelector<HTMLButtonElement>(".macos-titlebar-controls__new-session")?.click();

    expect(onOpenPalette).toHaveBeenCalledOnce();
    expect(onOpenNewSession).toHaveBeenCalledOnce();
    controls.remove();
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
