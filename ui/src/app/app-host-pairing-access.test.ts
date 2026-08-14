/* @vitest-environment jsdom */

import { render, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { OpenClawDevicePairSetup } from "../pages/devices/view-pairing.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import "./app-host.ts";

type PairingShell = HTMLElement & {
  runtime?: ApplicationRuntime;
  render: () => TemplateResult;
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
  expiresAtMs?: number;
  approvalNowMs?: number;
}) {
  if (!customElements.get("openclaw-device-pair-setup")) {
    customElements.define("openclaw-device-pair-setup", OpenClawDevicePairSetup);
  }
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
  const overlaySnapshot = {
    approvalQueue: [],
    approvalErrors: new Map(),
    approvalNowMs: params.approvalNowMs ?? 0,
    approvalBusy: false,
    devicePairSetupOpen: Boolean(params.setupCode),
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: params.setupCode
      ? {
          setupCode: params.setupCode,
          gatewayUrl: "wss://gateway.example.test",
          auth: "token",
          urlSource: "test",
          ...(params.expiresAtMs === undefined ? {} : { expiresAtMs: params.expiresAtMs }),
        }
      : null,
    devicePairSetupAccess: "full",
    devicePairPendingCount: 0,
    updateAvailable: null,
    updateRunning: false,
    updateStatusBanner: null,
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
    theme: { mode: "system" },
  } as unknown as ApplicationContext;
  const shell = document.createElement("openclaw-app-shell") as PairingShell;
  shell.runtime = {
    context,
    router: {
      getState: () => ({ status: "idle", matches: [], pendingMatches: [] }),
      subscribeSelector: () => () => undefined,
    },
  } as unknown as ApplicationRuntime;
  const container = document.createElement("div");

  const renderSidebar = () => {
    render(shell.render(), container);
    const sidebar = container.querySelector<PairingSidebar>("openclaw-app-sidebar");
    if (!sidebar) {
      throw new Error("Expected the application shell to render its navigation sidebar");
    }
    return sidebar;
  };

  return { snapshot, overlaySnapshot, openDevicePairSetup, renderSidebar, container };
}

afterEach(async () => {
  vi.useRealTimers();
  document.body.replaceChildren();
  await Promise.resolve();
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

  it("shows a visible accessible error when a mobile setup code cannot be copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const schedule = vi.spyOn(window, "setTimeout");
    const { container, renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-mobile-secret",
    });
    document.body.append(container);
    renderSidebar();
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>(".device-pair-setup")).not.toBeNull(),
    );
    const pairing = container.querySelector<HTMLElement>(".device-pair-setup")!;
    const button = pairing.querySelector<HTMLButtonElement>(".device-pair-setup__actions button");

    button?.click();

    await vi.waitFor(() => expect(button?.textContent?.trim()).toBe("Copy failed"));
    expect(button?.getAttribute("aria-label")).toBe("Copy failed");
    expect(button?.querySelector("svg")).not.toBeNull();
    expect(writeText).toHaveBeenCalledWith("pair-mobile-secret");
    expect(execCommand).toHaveBeenCalledWith("copy");

    const reset = schedule.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
    if (typeof reset !== "function") {
      throw new Error("Expected the failed copy feedback to schedule its reset");
    }
    reset();

    expect(button?.textContent?.trim()).toBe("Copy setup code");
    expect(button?.getAttribute("aria-label")).toBe("Copy setup code");
  });

  it("expires a node setup link from the pairing clock, independently of approvals", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const { overlaySnapshot, container, renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-node-secret",
      expiresAtMs: 5_000,
      approvalNowMs: 50_000,
    });
    document.body.append(container);
    overlaySnapshot.devicePairSetupAccess = "node";

    renderSidebar();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="timer"]')?.textContent).toContain("0:01"),
    );
    expect(container.querySelector(".device-pair-setup__command code")).not.toBeNull();

    now.mockReturnValue(5_000);
    renderSidebar();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="timer"]')?.textContent?.toLowerCase()).toContain(
        "expired",
      ),
    );
    expect(container.querySelector(".device-pair-setup__command code")).toBeNull();
  });
});
