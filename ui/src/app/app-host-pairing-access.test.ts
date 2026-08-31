/* @vitest-environment jsdom */

import { render, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../components/app-sidebar.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { loadSettings } from "./settings.ts";
import "./app-host.ts";

type PairingShell = HTMLElement & {
  runtime?: ApplicationRuntime;
  render: () => TemplateResult;
  routeState: {
    routeId?: string;
    location?: { pathname: string; search: string; hash: string };
  };
  devicePairSetupRenderer: unknown;
  devicePairSetupLoadFailed: boolean;
  loadDevicePairSetupRenderer: () => void;
  settingsSidebarRenderer: unknown;
  settingsSidebarLoadFailed: boolean;
  loadSettingsSidebarRenderer: () => void;
  retrySettingsSidebarRenderer: () => void;
};

type PairingSidebar = HTMLElement & {
  canPairDevice: boolean;
  onPairMobile?: () => void;
};

type PairingAuth = { role: string; scopes?: string[] };

function createPairingShell(params: {
  auth: PairingAuth | null;
  connected?: boolean;
  setupCode?: string;
  access?: "full" | "limited" | "node";
  expiresAtMs?: number;
}) {
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient,
    phase: params.connected === false ? "stopped" : "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: params.auth ? ({ auth: params.auth } as ApplicationGatewaySnapshot["hello"]) : null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const openDevicePairSetup = vi.fn(async () => undefined);
  const access = params.access ?? "full";
  const overlaySnapshot = {
    approvalQueue: [],
    approvalErrors: new Map(),
    approvalBusy: false,
    devicePairSetupOpen: Boolean(params.setupCode),
    devicePairSetupLifecycle: params.setupCode
      ? {
          phase: "waiting" as const,
          access,
          setup: {
            setupId: "setup-copy-test",
            expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000,
            setupCode: params.setupCode,
            gatewayUrl: "wss://gateway.example.test",
            auth: "token",
            urlSource: "test",
            access,
          },
        }
      : { phase: "selection" as const, access },
    devicePairPendingCount: 0,
    updateAvailable: null,
    updateRunning: false,
    updateStatusBanner: null,
    recordedUpdateAttempt: null,
    controlUiRefreshRequired: false,
  };
  const context = {
    basePath: "",
    gateway: {
      snapshot,
      connection: { gatewayUrl: "ws://gateway.test", token: "", password: "" },
    },
    navigation: {
      snapshot: { navCollapsed: false, navWidth: 258, sidebarEntries: [], pinnedAgentIds: [] },
    },
    overlays: {
      snapshot: overlaySnapshot,
      openDevicePairSetup,
    },
    config: { current: {} },
    runtimeConfig: {
      state: { configSnapshot: null, configForm: null, configSchema: null, configUiHints: {} },
    },
    agents: { state: { agentsList: null } },
    agentSelection: { state: { selectedId: "main", scopeId: "main" } },
    sessions: { state: { result: null } },
    theme: { mode: "system", settings: loadSettings() },
  } as unknown as ApplicationContext;
  const shell = document.createElement("openclaw-app-shell") as PairingShell;
  shell.runtime = { context, router: {} } as ApplicationRuntime;
  shell.routeState = {
    routeId: "chat",
    location: { pathname: "/chat", search: "", hash: "" },
  };
  const container = document.createElement("div");
  onTestFinished(() => {
    render(null, container);
  });

  const renderSidebar = () => {
    render(shell.render(), container);
    const sidebar = container.querySelector<PairingSidebar>("openclaw-app-sidebar");
    if (!sidebar) {
      throw new Error("Expected the application shell to render its navigation sidebar");
    }
    return sidebar;
  };

  // The pairing modal is a lazy chunk; re-render until the loaded renderer
  // replaces the eager loading shell with the full dialog.
  const renderPairingDialog = async () => {
    renderSidebar();
    await vi.dynamicImportSettled();
    return await waitForFast(() => {
      render(shell.render(), container);
      const dialog = container.querySelector<HTMLElement>(
        '.device-pair-setup:not([aria-busy="true"])',
      );
      if (!dialog) {
        throw new Error("Expected the application shell to render its mobile pairing dialog");
      }
      return dialog;
    });
  };

  return {
    shell,
    snapshot,
    overlaySnapshot,
    openDevicePairSetup,
    renderSidebar,
    renderPairingDialog,
    container,
  };
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
});

describe("application shell pairing access", () => {
  it.each([
    {
      name: "pairing-only",
      auth: { role: "operator", scopes: ["operator.pairing"] },
      canPair: true,
    },
    {
      name: "administrator",
      auth: { role: "operator", scopes: ["operator.admin"] },
      canPair: true,
    },
    { name: "legacy authenticated", auth: { role: "operator" }, canPair: true },
    { name: "legacy unadvertised", auth: null, canPair: true },
    { name: "read-only", auth: { role: "operator", scopes: ["operator.read"] }, canPair: false },
    { name: "write-only", auth: { role: "operator", scopes: ["operator.write"] }, canPair: false },
    { name: "explicitly ungranted", auth: { role: "operator", scopes: [] }, canPair: false },
  ])("gates the sidebar pairing entry for a $name operator", ({ auth, canPair }) => {
    const { renderSidebar } = createPairingShell({ auth });

    expect(renderSidebar().canPairDevice).toBe(canPair);
  });

  it("keeps the pairing entry accessible after admin becomes pairing-only", () => {
    const { snapshot, openDevicePairSetup, renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.admin"] },
    });
    expect(renderSidebar().canPairDevice).toBe(true);

    snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.pairing"] },
    } as ApplicationGatewaySnapshot["hello"];
    const sidebar = renderSidebar();

    expect(sidebar.canPairDevice).toBe(true);
    sidebar.onPairMobile?.();
    expect(openDevicePairSetup).toHaveBeenCalledOnce();
  });

  it("keeps the pairing entry disabled while the gateway is disconnected", () => {
    const { renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      connected: false,
    });

    expect(renderSidebar().canPairDevice).toBe(false);
  });

  it("keeps a failed pairing dialog load visible and retryable", () => {
    const { shell, renderSidebar, container } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-mobile-secret",
    });
    renderSidebar();

    // Force the rejected-chunk state the shell reaches when the lazy pairing
    // import fails while its overlay is already open.
    shell.devicePairSetupRenderer = null;
    shell.devicePairSetupLoadFailed = true;
    render(shell.render(), container);

    const dialog = container.querySelector<HTMLElement>(".device-pair-setup");
    expect(dialog?.textContent).toContain("Could not load the pairing dialog");
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>(".device-pair-setup__footer button"),
    ];
    expect(actions.map((button) => button.textContent?.trim())).toEqual(["Retry", "Close"]);

    actions[0]?.click();

    expect(shell.devicePairSetupLoadFailed).toBe(false);
  });

  it("keeps the pairing dialog visible while its lazy renderer is loading", () => {
    const { shell, renderSidebar, container } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-mobile-secret",
    });
    const loadRenderer = vi.fn();
    shell.devicePairSetupRenderer = null;
    shell.devicePairSetupLoadFailed = false;
    shell.loadDevicePairSetupRenderer = loadRenderer;

    renderSidebar();

    const dialog = container.querySelector<HTMLElement>(".device-pair-setup");
    expect(dialog?.getAttribute("aria-busy")).toBe("true");
    expect(dialog?.textContent).toContain("Loading…");
    expect(loadRenderer).toHaveBeenCalledOnce();
  });

  it("keeps settings navigation visibly loading while its renderer downloads", () => {
    const { shell, container } = createPairingShell({ auth: { role: "operator" } });
    const loadRenderer = vi.fn();
    shell.routeState = {
      routeId: "profile",
      location: { pathname: "/settings/profile", search: "", hash: "" },
    };
    shell.settingsSidebarRenderer = null;
    shell.settingsSidebarLoadFailed = false;
    shell.loadSettingsSidebarRenderer = loadRenderer;

    render(shell.render(), container);

    const sidebar = container.querySelector<HTMLElement>(".settings-sidebar");
    expect(sidebar?.getAttribute("aria-busy")).toBe("true");
    expect(sidebar?.textContent).toContain("Loading…");
    expect(loadRenderer).toHaveBeenCalledOnce();
  });

  it("keeps a failed settings navigation load visible and retryable", () => {
    const { shell, container } = createPairingShell({ auth: { role: "operator" } });
    const retryRenderer = vi.fn();
    shell.routeState = {
      routeId: "profile",
      location: { pathname: "/settings/profile", search: "", hash: "" },
    };
    shell.settingsSidebarRenderer = null;
    shell.settingsSidebarLoadFailed = true;
    shell.retrySettingsSidebarRenderer = retryRenderer;

    render(shell.render(), container);

    const sidebar = container.querySelector<HTMLElement>(".settings-sidebar");
    expect(sidebar?.getAttribute("aria-busy")).toBeNull();
    expect(sidebar?.textContent).toContain("Settings navigation could not load.");
    const retry = [...(sidebar?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    retry?.click();
    expect(retryRenderer).toHaveBeenCalledOnce();
  });

  it("shows a visible accessible error when a mobile setup code cannot be copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const schedule = vi.spyOn(window, "setTimeout");
    const { renderPairingDialog } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-mobile-secret",
    });
    const pairing = await renderPairingDialog();
    document.body.append(pairing);
    const button = pairing.querySelector<HTMLButtonElement>(".device-pair-setup__actions button");

    button?.click();

    await waitForFast(() => expect(button?.textContent?.trim()).toBe("Copy failed"));
    expect(button?.getAttribute("aria-label")).toBeNull();
    expect(button?.querySelector("svg")).not.toBeNull();
    expect(writeText).toHaveBeenCalledWith("pair-mobile-secret");
    expect(execCommand).toHaveBeenCalledWith("copy");

    const reset = schedule.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
    if (typeof reset !== "function") {
      throw new Error("Expected the failed copy feedback to schedule its reset");
    }
    reset();

    expect(button?.textContent?.trim()).toBe("Copy setup code");
    expect(button?.getAttribute("aria-label")).toBeNull();
  });

  it("expires a node setup link from the pairing clock", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const { shell, container, renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-node-secret",
      access: "node",
      expiresAtMs: 5_000,
    });

    renderSidebar();
    await vi.dynamicImportSettled();
    await waitForFast(() => {
      render(shell.render(), container);
      expect(container.querySelector('[role="timer"]')?.textContent).toContain("0:01");
    });
    expect(container.querySelector(".device-pair-setup__command code")).not.toBeNull();

    now.mockReturnValue(5_000);
    render(shell.render(), container);
    expect(container.querySelector('[role="timer"]')?.textContent?.toLowerCase()).toContain(
      "expired",
    );
    expect(container.querySelector(".device-pair-setup__command code")).toBeNull();
  });
});
