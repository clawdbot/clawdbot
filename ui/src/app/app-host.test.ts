/* @vitest-environment jsdom */

import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, GatewayAgentRow } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
} from "../components/command-palette-contract.ts";
import {
  TERMINAL_PANEL_TOGGLE_EVENT,
  UI_COMMAND_EVENT,
} from "../components/panel-toggle-contract.ts";
import { i18n } from "../i18n/index.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type ShellKeyboardState,
  type TestOptionalCustomElement,
  stubRenderedWhenDefined,
} from "./app-host.test-support.ts";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "./context.ts";
import type { LazyCustomElementRequestController } from "./lazy-custom-element.ts";
import "./app-host.ts";
import {
  persistLazyShellAction,
  readLazyShellAction,
  SHELL_APPROVALS_OPEN_EVENT,
} from "./lazy-shell-action.ts";
import { shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

vi.mock("./stale-chunk-reload.ts", async () => {
  const actual =
    await vi.importActual<typeof import("./stale-chunk-reload.ts")>("./stale-chunk-reload.ts");
  return {
    ...actual,
    scheduleStaleChunkReload: vi.fn(async () => true),
  };
});

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

type I18nRecoveryWiring = {
  localeLoadRecovery?: {
    isUnrecoverableError: (error: unknown) => boolean;
    onUnrecoverableLocaleLoad?: (locale: string) => void;
  };
};

type ShellServerPreferencesState = {
  runtime: { context: ApplicationContext };
  reconcileServerUiPrefs: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
};

type ShellLifecycle = Pick<ShellChromeEventState, "connectedCallback" | "disconnectedCallback">;

type ShellLazySurfaceState = ShellKeyboardState &
  ShellLifecycle & {
    commandPaletteElement: TestOptionalCustomElement;
    lazyCustomElements: LazyCustomElementRequestController;
    openPalette: () => void;
    restorePendingLazyAction: () => void;
  };

type ShellLazyLifecycleState = {
  resetForContextEpoch: () => void;
  resetForDocumentDisconnect: () => void;
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

type ShellChromeEventState = {
  runtime: { context: ApplicationContext };
  navDrawerOpen: boolean;
  handleShellNavDrawerToggle: (event: Event) => void;
  openPalette: () => void;
  connectedCallback: () => void;
  disconnectedCallback: () => void;
};

type ShellNavDrawerCloseState = HTMLElement &
  ShellChromeEventState & {
    desktopNavigationExpanded: boolean;
    navDrawerTrigger: HTMLElement | null;
    closeNavDrawer: (options?: { restoreFocus?: boolean }) => void;
    handleWindowResize: () => void;
    toggleNavigationSurface: () => void;
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

function configureLazyPaletteShell(
  element: TestOptionalCustomElement,
  openPalette: () => void,
): ShellLazySurfaceState {
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
        ? { isOpen: false, openPalette, togglePalette: vi.fn() }
        : undefined,
  });
  return shell;
}

async function withConnectedShell(shell: ShellLifecycle, run: () => void | Promise<void>) {
  shell.connectedCallback();
  try {
    await run();
  } finally {
    shell.disconnectedCallback();
  }
}

afterEach(() => {
  resetAppHostTestGlobals();
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

type ShellRouteCommitState = {
  runtime: { context: ApplicationContext };
  activeSessionKey: string;
  didConsiderNativeRouteRestore: boolean;
  updateRouteState: (state: ReturnType<typeof selectShellRouteState>) => void;
};

type ShellCustodianRouteState = {
  custodianMinimizeRequestId: number;
  updateRouteState: (state: { routeId?: RouteId }) => void;
};

type ShellSessionNavigationState = {
  runtime: { context: ApplicationContext };
  activeSessionKey: string;
  routeState: { routeId?: RouteId };
  navigate: (routeId: RouteId) => void;
  handleCommandPaletteSlashCommand: (command: string) => void;
  replaceChatWithCurrentSession: () => boolean;
};

function committedRouterState(
  routeId: RouteId,
  pathname: string,
  data?: unknown,
): RouterState<RouteId> {
  const location = { pathname, search: "", hash: "" } satisfies RouteLocation;
  return {
    location,
    resolvedLocation: location,
    status: "success",
    matches: [{ routeId, location, data }],
    pendingMatches: [],
    cachedMatches: [],
  } as unknown as RouterState<RouteId>;
}

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
  it("preserves reload intent on disconnect but clears it on context replacement", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    persistLazyShellAction({ eventType: COMMAND_PALETTE_OPEN_EVENT });
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellLazyLifecycleState;

    shell.resetForDocumentDisconnect();
    expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });

    shell.resetForContextEpoch();
    expect(readLazyShellAction()).toBeNull();
  });

  it("delegates repeated locale import failures to guarded stale-chunk recovery", () => {
    const scheduleReload = vi.mocked(scheduleStaleChunkReload);
    scheduleReload.mockClear();
    const recovery = (i18n as unknown as I18nRecoveryWiring).localeLoadRecovery;

    expect(
      recovery?.isUnrecoverableError(
        new Error("Failed to fetch dynamically imported module: /assets/fr-abc123.js"),
      ),
    ).toBe(true);
    recovery?.onUnrecoverableLocaleLoad?.("fr");

    expect(scheduleReload).toHaveBeenCalledOnce();
  });

  it("retries a pending locale once when the Gateway becomes connected", () => {
    const retryPendingLocale = vi.spyOn(i18n, "retryPendingLocale").mockImplementation(() => {});
    // Owner-direct: the shared jsdom lane can retain a sibling graph's
    // openclaw-app-shell class bound to a different i18n instance; constructing
    // the owner keeps the spy and the callee in the current module graph.
    const host = {
      activeSessionKey: "",
      agentRosterRefreshTimer: null,
      agentsListClient: null,
      agentsListSource: null,
      context: undefined,
      criticalNoticeRuntime: null,
      lastLocalePrefSignature: null,
      outboxStoreImport: { load: vi.fn(async () => undefined) },
      previousGatewayPhase: null,
      routeState: {},
      runtimeConfigClient: null,
      runtimeConfigSource: null,
      sessionKeyClient: null,
      sidebarWorkboardRuntime: null,
      syncSidebarWorkboard: vi.fn(),
    } as unknown as ShellGatewayHost;
    const owner = new ShellGatewayOwner(host);
    const reconnecting = {
      client: null,
      phase: "reconnecting",
      sessionKey: "",
    } as ApplicationGatewaySnapshot;
    const connected = {
      client: {} as GatewayBrowserClient,
      phase: "connected",
      sessionKey: "",
    } as ApplicationGatewaySnapshot;

    owner.synchronizeGateway(reconnecting);
    owner.synchronizeGateway(connected);
    owner.synchronizeGateway({ ...connected });
    owner.synchronizeGateway({ ...connected });

    expect(retryPendingLocale).toHaveBeenCalledOnce();
    retryPendingLocale.mockRestore();
  });

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
    const createAgents = () =>
      ({
        state: { agentsList: null },
        ensureList: vi.fn(() => Promise.resolve(null)),
      }) as unknown as ApplicationContext["agents"];
    const createRuntimeConfig = () =>
      ({
        state: { client, connected: true },
        ensureLoaded: vi.fn(() => Promise.resolve()),
      }) as unknown as ApplicationContext["runtimeConfig"];
    const firstAgents = createAgents();
    const secondAgents = createAgents();
    const firstRuntimeConfig = createRuntimeConfig();
    const secondRuntimeConfig = createRuntimeConfig();

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

describe("OpenClaw shell route session commits", () => {
  it("builds session paths from the requested destination face", () => {
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSessionNavigationState;
    shell.runtime = {
      context: {
        basePath: "",
        agents: { state: { agentsList: { mainKey: "main" } } },
        agentSelection: { state: { selectedId: "main" } },
        gateway: { snapshot: { hello: null } },
        sessions: { state: { result: null } },
        navigate,
      } as unknown as ApplicationContext,
    };
    shell.activeSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";

    shell.routeState = { routeId: "chat" };
    shell.navigate("dashboard");
    expect(navigate).toHaveBeenLastCalledWith("dashboard", {
      pathname: "/dashboard/main/12345678",
    });

    shell.routeState = { routeId: "dashboard" };
    shell.navigate("chat");
    expect(navigate).toHaveBeenLastCalledWith("chat", { pathname: "/chat/main/12345678" });
  });

  it("preserves catalog identity when routing a slash-command draft", () => {
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSessionNavigationState;
    shell.runtime = {
      context: {
        basePath: "",
        agents: { state: { agentsList: { defaultId: "research", mainKey: "main" } } },
        agentSelection: { state: { selectedId: "research" } },
        gateway: { snapshot: { hello: null } },
        sessions: { state: { result: null } },
        navigate,
      } as unknown as ApplicationContext,
    };
    shell.activeSessionKey = "catalog:claude:gateway%3Alocal:thread-1";
    shell.routeState = { routeId: "chat" };

    shell.handleCommandPaletteSlashCommand("/review");

    expect(navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/research",
      search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1&draft=%2Freview+",
    });
  });

  it("defers an unscoped not-found fallback until agent defaults are connected", () => {
    const replace = vi.fn();
    const snapshot = { phase: "connecting", hello: null };
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSessionNavigationState;
    shell.runtime = {
      context: {
        basePath: "",
        agents: {
          state: { agentsList: { defaultId: "research", mainKey: "workspace" } },
        },
        agentSelection: { set: vi.fn(), state: { selectedId: null } },
        gateway: { setSessionKey: vi.fn(), snapshot },
        sessions: { state: { result: null } },
        replace,
      } as unknown as ApplicationContext,
    };
    shell.activeSessionKey = "main";
    shell.routeState = { routeId: "chat" };

    expect(shell.replaceChatWithCurrentSession()).toBe(false);
    expect(replace).not.toHaveBeenCalled();

    snapshot.phase = "connected";
    expect(shell.replaceChatWithCurrentSession()).toBe(true);
    expect(replace).toHaveBeenCalledWith("chat", { pathname: "/chat/research" });
  });

  it("adopts a resolved chat session after path navigation from Tasks", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const calls: string[] = [];
    const setAgent = vi.fn((agentId: string | null) => calls.push(`agent:${agentId}`));
    const setSessionKey = vi.fn((sessionKey: string) => calls.push(`session:${sessionKey}`));
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellRouteCommitState;
    shell.runtime = {
      context: {
        gateway: {
          snapshot: { phase: "stopped", client: null, sessionKey: "agent:main:session-a" },
          setSessionKey,
        },
        agentSelection: { set: setAgent },
      } as unknown as ApplicationContext,
    };
    shell.activeSessionKey = "agent:main:session-a";
    shell.didConsiderNativeRouteRestore = true;

    shell.updateRouteState(selectShellRouteState(committedRouterState("tasks", "/tasks")));
    shell.updateRouteState(
      selectShellRouteState(
        committedRouterState("chat", "/chat/main/session-b-12345678", {
          kind: "session",
          sessionKey: "agent:main:session-b",
        }),
      ),
    );

    expect(shell.activeSessionKey).toBe("agent:main:session-b");
    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith("agent:main:session-b");
    expect(calls).toEqual(["agent:main", "session:agent:main:session-b"]);
  });

  it("retains the custodian leave transition through an unresolved route state", () => {
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellCustodianRouteState;

    shell.updateRouteState({ routeId: "custodian" });
    shell.updateRouteState({});
    expect(shell.custodianMinimizeRequestId).toBe(0);

    shell.updateRouteState({ routeId: "appearance" });
    expect(shell.custodianMinimizeRequestId).toBe(1);
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
      // reconcileServerUiPrefs only accepts the current context's capability.
      runtimeConfig,
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

  it("suppresses modal focus restoration when the navigation drawer closes without restoring focus", () => {
    const shell = document.createElement("openclaw-app-shell") as ShellNavDrawerCloseState;
    const modal = document.createElement("openclaw-modal-dialog");
    const setReturnFocusTarget = vi.fn();
    modal.className = "drawer nav-drawer";
    Object.defineProperty(modal, "setReturnFocusTarget", { value: setReturnFocusTarget });
    shell.append(modal);
    shell.navDrawerOpen = true;
    shell.navDrawerTrigger = document.createElement("button");

    shell.closeNavDrawer();

    expect(setReturnFocusTarget).toHaveBeenCalledExactlyOnceWith(null);
    expect(shell.navDrawerOpen).toBe(false);
    expect(shell.navDrawerTrigger).toBeNull();
  });

  it("closes an open navigation drawer before moving its sidebar into desktop layout", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const shell = document.createElement("openclaw-app-shell") as ShellNavDrawerCloseState;
    const updateNavigation = vi.fn();
    shell.runtime = {
      context: {
        navigation: {
          snapshot: { navCollapsed: true },
          update: updateNavigation,
        },
      } as unknown as ApplicationContext,
    };
    const sidebar = document.createElement("openclaw-app-sidebar");
    const dismissTransientMenus = vi.fn(() => true);
    Object.defineProperty(sidebar, "dismissTransientMenus", { value: dismissTransientMenus });
    const modal = document.createElement("openclaw-modal-dialog");
    const setReturnFocusTarget = vi.fn();
    modal.className = "drawer nav-drawer";
    Object.defineProperty(modal, "setReturnFocusTarget", { value: setReturnFocusTarget });
    shell.append(sidebar, modal);
    const trigger = document.body.appendChild(document.createElement("button"));
    const restoreTriggerFocus = vi.spyOn(trigger, "focus");
    const closeNavDrawer = vi.spyOn(shell, "closeNavDrawer");
    shell.navDrawerOpen = true;
    shell.navDrawerTrigger = trigger;

    shell.handleWindowResize();

    expect(closeNavDrawer).toHaveBeenCalledExactlyOnceWith({ restoreFocus: false });
    expect(dismissTransientMenus).toHaveBeenCalledOnce();
    expect(setReturnFocusTarget).toHaveBeenCalledExactlyOnceWith(null);
    expect(restoreTriggerFocus).not.toHaveBeenCalled();
    expect(shell.navDrawerOpen).toBe(false);
    expect(shell.navDrawerTrigger).toBeNull();
    expect(updateNavigation).not.toHaveBeenCalled();
    expect(shell.desktopNavigationExpanded).toBe(true);
    shell.toggleNavigationSurface();
    expect(updateNavigation).toHaveBeenCalledExactlyOnceWith({ navCollapsed: true });
    expect(shell.desktopNavigationExpanded).toBe(false);
    trigger.remove();
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

    const handlePaletteOpen = () => openPalette();
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handlePaletteOpen);
    try {
      shell.handleShellNavDrawerToggle(
        new CustomEvent(SHELL_NAV_DRAWER_TOGGLE_EVENT, { detail: { trigger } }),
      );
      shell.openPalette();

      expect(shell.navDrawerOpen).toBe(true);
      expect(openPalette).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handlePaletteOpen);
    }
  });

  it("normalizes an unloaded palette toggle shortcut to open", async () => {
    const element = createLazyElementSpec("command palette");
    const openPalette = vi.fn();
    const shell = configureLazyPaletteShell(element, openPalette);
    stubRenderedWhenDefined(shell);
    const event = new KeyboardEvent("keydown", {
      key: "л",
      code: "KeyK",
      ctrlKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(openPalette).toHaveBeenCalledOnce());
  });

  it("clears a rejected command palette action on Close", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const element = createLazyElementSpec("cancelled command palette", {
      firstError: new Error("command palette chunk unavailable"),
    });
    const openPalette = vi.fn();
    const shell = configureLazyPaletteShell(element, openPalette);

    await withConnectedShell(shell, async () => {
      shell.openPalette();
      await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
      shell.lazyCustomElements.close();

      expect(readLazyShellAction()).toBeNull();
      const replacement = configureLazyPaletteShell(element, openPalette);
      replacement.restorePendingLazyAction();
      await Promise.resolve();
      expect(openPalette).not.toHaveBeenCalled();
    });
  });

  it("does not clear an unrelated pending action from an already-loaded palette", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    persistLazyShellAction({ eventType: SHELL_APPROVALS_OPEN_EVENT });
    const element = createLazyElementSpec("loaded command palette");
    customElements.define(element.tagName, class extends HTMLElement {});
    const openPalette = vi.fn();
    const shell = configureLazyPaletteShell(element, openPalette);

    await withConnectedShell(shell, () => {
      shell.openPalette();

      expect(openPalette).toHaveBeenCalledOnce();
      expect(readLazyShellAction()).toEqual({ eventType: SHELL_APPROVALS_OPEN_EVENT });
    });
  });

  it("routes UI commands to navigation, panels, and chat fallback", () => {
    const update = vi.fn();
    const setSessionKey = vi.fn();
    const setAgent = vi.fn();
    const navigate = vi.fn();
    const panelEvent = vi.fn();
    const uiCommandEvent = vi.fn();
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, panelEvent);
    window.addEventListener(UI_COMMAND_EVENT, uiCommandEvent);
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellUiCommandState;
    shell.runtime = {
      context: {
        basePath: "",
        navigation: { update },
        gateway: { setSessionKey, snapshot: { hello: null } },
        agents: { state: { agentsList: { mainKey: "main" } } },
        agentSelection: { state: { selectedId: "main" }, set: setAgent },
        sessions: { state: { result: null } },
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
        command: {
          kind: "split",
          direction: "right",
          sessionKey: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
        },
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
    expect(setSessionKey).toHaveBeenCalledWith(
      "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
    );
    // The pushed command names a session the UI has not cached, so its face is a guess
    // and the navigation is marked for the chat loader to re-derive from the gateway.
    expect(setAgent).toHaveBeenCalledWith("main");
    expect(navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/12345678",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
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
});
