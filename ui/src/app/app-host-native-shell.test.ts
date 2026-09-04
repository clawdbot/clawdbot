/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../components/macos-titlebar-controls.runtime.ts";
import "../components/sidebar-update-card.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import "./app-host.ts";
import { resetAppHostTestGlobals, type ShellKeyboardState } from "./app-host.test-support.ts";
import type { ApplicationContext } from "./context.ts";
import { navigationSurfaceIsHidden, renderFloatingUpdateCard } from "./navigation-surface.ts";

type ShellNavigationState = {
  runtime: { context: ApplicationContext };
  handleNativeToggleSidebar: () => void;
  handleNativeOpenSearch: () => void;
  handleNativeToggleSearch: (event: Event) => void;
  handleNativeNewSession: () => void;
  handleNativeNavigate: (event: Event) => void;
  handleNativeHistoryState: (event: Event) => void;
  nativeHistoryState: { canGoBack: boolean; canGoForward: boolean };
  onboarding: boolean;
  updated: (changedProperties: Map<string, unknown>) => void;
};

type ShellSettingsEscapeState = ShellKeyboardState & {
  lastWorkspaceLocation: { routeId: "usage"; pathname: string; search: string; hash: string };
  navDrawerOpen: boolean;
  routeState: { routeId: "appearance" };
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
  newSessionDisabledReason?: string;
  onOpenPalette?: () => void;
  onOpenNewSession?: () => void;
  updateComplete: Promise<boolean>;
};

function nativeSessionContext(
  navigate: ReturnType<typeof vi.fn>,
  selectedId: string,
  options: { methods?: string[]; scopes?: string[] } = {},
): ApplicationContext {
  return {
    navigate,
    agentSelection: { state: { selectedId } },
    gateway: {
      snapshot: {
        client: {},
        phase: "connected",
        hello: {
          auth: { role: "operator", scopes: options.scopes ?? ["operator.write"] },
          features: { methods: options.methods ?? ["sessions.create"] },
        },
      },
    },
  } as unknown as ApplicationContext;
}

afterEach(() => {
  resetAppHostTestGlobals();
});

describe("OpenClaw native shell", () => {
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
    expect(navigate).toHaveBeenCalledWith("appearance", undefined);
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
    expect(navigate).toHaveBeenCalledWith("appearance", undefined);
  });

  it("restores the complete prior workspace URL when Escape leaves Settings", () => {
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsEscapeState;
    shell.runtime = {
      context: {
        navigate,
        overlays: { snapshot: { devicePairSetupOpen: false } },
      } as unknown as ApplicationContext,
    };
    shell.lastWorkspaceLocation = {
      routeId: "usage",
      pathname: "/usage",
      search: "?agent=main",
      hash: "#queue",
    };
    shell.navDrawerOpen = false;
    shell.routeState = { routeId: "appearance" };

    shell.handleDocumentKeydown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("usage", {
      pathname: "/usage",
      search: "?agent=main",
      hash: "#queue",
    });
  });

  it("keeps the raw config editor unchanged when Escape is pressed", () => {
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsEscapeState;
    shell.runtime = {
      context: {
        navigate,
        overlays: { snapshot: { devicePairSetupOpen: false } },
      } as unknown as ApplicationContext,
    };
    shell.lastWorkspaceLocation = { routeId: "usage", pathname: "/usage", search: "", hash: "" };
    shell.navDrawerOpen = false;
    shell.routeState = { routeId: "appearance" };
    const rawField = document.body.appendChild(document.createElement("label"));
    rawField.className = "config-raw-field";
    const rawEditor = rawField.appendChild(document.createElement("textarea"));
    rawEditor.value = '{ "gateway": { "port": 18789 } }';
    rawEditor.focus();
    const onInput = vi.fn();
    rawEditor.addEventListener("input", onInput);
    rawEditor.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));

    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      rawEditor.dispatchEvent(event);

      expect(rawEditor.value).toBe('{ "gateway": { "port": 18789 } }');
      expect(onInput).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      rawField.remove();
    }
  });

  it("lets a shadow-root confirmation own Escape without leaving Settings", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsEscapeState;
    shell.runtime = {
      context: {
        navigate,
        overlays: { snapshot: { devicePairSetupOpen: false } },
      } as unknown as ApplicationContext,
    };
    shell.lastWorkspaceLocation = { routeId: "usage", pathname: "/usage", search: "", hash: "" };
    shell.navDrawerOpen = false;
    shell.routeState = { routeId: "appearance" };
    const container = document.body.appendChild(document.createElement("div"));
    const modal = container.appendChild(document.createElement("openclaw-modal-dialog"));
    const cancel = modal.appendChild(document.createElement("button"));

    try {
      const { dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(true);
      expect(document.querySelector("dialog[open]")).toBeNull();
      cancel.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

      cancel.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      container.remove();
      restoreDialogPolyfill();
    }
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
      context: nativeSessionContext(navigate, "agent/a"),
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

  it("disables the native titlebar new-session control with its access reason", async () => {
    const onOpenNewSession = vi.fn();
    const controls = document.createElement(
      "openclaw-macos-titlebar-controls",
    ) as unknown as MacosTitlebarControlsState;
    controls.navCollapsed = true;
    controls.newSessionDisabledReason = "Operator write access is required.";
    controls.onOpenNewSession = onOpenNewSession;
    document.body.append(controls);
    await controls.updateComplete;

    const button = controls.querySelector<HTMLButtonElement>(
      ".macos-titlebar-controls__new-session",
    );
    expect(button?.disabled).toBe(true);
    button?.click();
    expect(onOpenNewSession).not.toHaveBeenCalled();
    controls.remove();
  });

  it("retains a native new-session request until a context exists", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;

    shell.handleNativeNewSession();

    shell.runtime = {
      context: nativeSessionContext(navigate, "main"),
    };
    shell.handleNativeNewSession();

    expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", { search: "?agent=main" });
  });

  it("does not start a native session without exact sessions.create access", () => {
    for (const options of [
      { methods: ["sessions.list"], scopes: ["operator.write"] },
      { methods: ["sessions.create"], scopes: ["operator.read"] },
    ]) {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: nativeSessionContext(navigate, "main", options),
      };

      shell.handleNativeNewSession();

      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it.each(
    [
      { path: "/settings/channels", routeId: "channels" },
      { path: "/custodian", routeId: "custodian", search: "?onboarding=1" },
      {
        path: "/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef",
        routeId: "chat",
        search: "?nav=collapsed",
      },
      { path: "/dashboard/main/tasks/review", routeId: "dashboard" },
      { path: "/settings/agents/main/overview", routeId: "agents" },
      { path: "/settings/memory/dreams", routeId: "memory" },
    ].flatMap(({ path, routeId, search }) =>
      ["", "/gateway"].map((basePath) => ({ path, routeId, search, basePath })),
    ),
  )(
    "preserves native destination $basePath$path and acknowledges it",
    ({ path, routeId, search, basePath }) => {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: { navigate, basePath } as unknown as ApplicationContext,
      };
      const event = new CustomEvent("openclaw:native-navigate", {
        cancelable: true,
        detail: { path, search },
      });

      shell.handleNativeNavigate(event);

      expect(event.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(routeId, {
        pathname: `${basePath}${path}`,
        ...(search ? { search } : {}),
      });
    },
  );

  it.each(["#frag-only", "onboarding=1", "?onboarding=1#x"])(
    "ignores malformed native search %s and keeps the plain route",
    (search) => {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: {
          navigate,
          basePath: "",
        } as unknown as ApplicationContext,
      };
      const event = new CustomEvent("openclaw:native-navigate", {
        cancelable: true,
        detail: { path: "/custodian", search },
      });

      shell.handleNativeNavigate(event);

      expect(event.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith("custodian", { pathname: "/custodian" });
    },
  );

  it.each(["https://example.com", "//example.com", "/https://example.com", "/unknown"])(
    "leaves invalid native Dashboard path %s unhandled",
    (path) => {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: {
          navigate,
        } as unknown as ApplicationContext,
      };
      const event = new CustomEvent("openclaw:native-navigate", {
        cancelable: true,
        detail: { path },
      });

      shell.handleNativeNavigate(event);

      expect(event.defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

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

    shell.updated(new Map());
    shell.updated(new Map());
    snapshot.navCollapsed = true;
    shell.updated(new Map());

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
  it("renders floating attention while keeping update actions in navigation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const shared = {
      mobileNavLayout: false,
      onboarding: false,
      updateAvailable: {
        currentVersion: "2026.7.1",
        latestVersion: "2026.7.2",
        channel: "stable" as const,
      },
      updateBusy: false,
      canUpdate: true,
      onUpdate: vi.fn(),
      refreshRequired: false,
      onRefresh: vi.fn(),
    };
    const collapsed = navigationSurfaceIsHidden({
      onboarding: false,
      navCollapsed: true,
      navDrawerOpen: false,
      mobileNavLayout: false,
    });
    render(renderFloatingUpdateCard({ ...shared, navigationSurfaceHidden: collapsed }), container);
    expect(
      container.querySelector("openclaw-sidebar-attention.sidebar-attention--floating"),
    ).not.toBeNull();
    expect(container.querySelector("openclaw-sidebar-update-card")).toBeNull();

    render(
      renderFloatingUpdateCard({
        ...shared,
        navigationSurfaceHidden: collapsed,
        updateAvailable: null,
        refreshRequired: true,
      }),
      container,
    );
    const refreshCard = container.querySelector<
      HTMLElement & { onRefresh: () => void; refreshRequired: boolean }
    >("openclaw-sidebar-update-card");
    expect(refreshCard?.refreshRequired).toBe(true);
    refreshCard?.onRefresh();
    expect(shared.onRefresh).toHaveBeenCalledOnce();
    expect(shared.onUpdate).not.toHaveBeenCalled();

    const visible = navigationSurfaceIsHidden({
      onboarding: false,
      navCollapsed: false,
      navDrawerOpen: false,
      mobileNavLayout: false,
    });
    render(
      renderFloatingUpdateCard({
        ...shared,
        navigationSurfaceHidden: visible,
        updateAvailable: null,
        refreshRequired: true,
      }),
      container,
    );
    expect(container.querySelector("openclaw-sidebar-update-card")).not.toBeNull();
    container.remove();
  });

  it("keeps attention in the closed mobile drawer while preserving stale-client refresh", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    try {
      const navigationSurfaceHidden = navigationSurfaceIsHidden({
        onboarding: false,
        navCollapsed: false,
        navDrawerOpen: false,
        mobileNavLayout: true,
      });
      expect(navigationSurfaceHidden).toBe(true);
      const shared = {
        navigationSurfaceHidden,
        mobileNavLayout: true,
        onboarding: false,
        updateAvailable: {
          currentVersion: "2026.7.1",
          latestVersion: "2026.7.2",
          channel: "stable" as const,
        },
        updateBusy: false,
        canUpdate: true,
        onUpdate: vi.fn(),
        refreshRequired: false,
        onRefresh: vi.fn(),
      };

      render(renderFloatingUpdateCard(shared), container);
      expect(
        container.querySelector("openclaw-sidebar-attention.sidebar-attention--floating"),
      ).toBeNull();

      render(
        renderFloatingUpdateCard({ ...shared, updateAvailable: null, refreshRequired: true }),
        container,
      );
      const refreshCard = container.querySelector<
        HTMLElement & { updateComplete: Promise<boolean> }
      >("openclaw-sidebar-update-card");
      await refreshCard?.updateComplete;
      expect(refreshCard?.querySelector(".sidebar-update-card")).not.toBeNull();
    } finally {
      container.remove();
    }
  });

  it("keeps the stale-client refresh visible during onboarding", () => {
    const container = document.createElement("div");
    const shared = {
      mobileNavLayout: false,
      onboarding: true,
      updateAvailable: null,
      updateBusy: false,
      onUpdate: vi.fn(),
      refreshRequired: true,
      onRefresh: vi.fn(),
    };
    expect(
      navigationSurfaceIsHidden({
        onboarding: true,
        navCollapsed: false,
        navDrawerOpen: false,
        mobileNavLayout: false,
      }),
    ).toBe(true);

    for (const navigationSurfaceHidden of [false, true]) {
      render(renderFloatingUpdateCard({ ...shared, navigationSurfaceHidden }), container);
      expect(
        container.querySelector("openclaw-sidebar-attention.sidebar-attention--floating"),
      ).toBeNull();
      const cards = container.querySelectorAll<HTMLElement & { refreshRequired: boolean }>(
        "openclaw-sidebar-update-card",
      );
      expect(cards).toHaveLength(1);
      expect(cards[0]?.refreshRequired).toBe(true);
    }

    render(
      renderFloatingUpdateCard({
        ...shared,
        navigationSurfaceHidden: true,
        updateAvailable: {
          currentVersion: "2026.7.1",
          latestVersion: "2026.7.2",
          channel: "stable",
        },
        refreshRequired: false,
      }),
      container,
    );
    expect(container.querySelector("openclaw-sidebar-update-card")).toBeNull();
  });
});
