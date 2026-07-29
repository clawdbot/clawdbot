/* @vitest-environment jsdom */

import { render, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
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

function createPairingShell(params: { auth: PairingAuth | null; connected?: boolean }) {
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
      snapshot: {
        approvalQueue: [],
        approvalErrors: new Map(),
        approvalNowMs: 0,
        approvalBusy: false,
        devicePairSetupOpen: false,
        devicePairSetupLoading: false,
        devicePairSetupError: null,
        devicePairSetup: null,
        devicePairSetupAccess: "full",
        devicePairPendingCount: 0,
        updateAvailable: null,
        updateRunning: false,
        updateStatusBanner: null,
        controlUiRefreshRequired: false,
      },
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
  shell.runtime = { context, router: {} } as ApplicationRuntime;
  const container = document.createElement("div");

  const renderSidebar = () => {
    render(shell.render(), container);
    const sidebar = container.querySelector<PairingSidebar>("openclaw-app-sidebar");
    if (!sidebar) {
      throw new Error("Expected the application shell to render its navigation sidebar");
    }
    return sidebar;
  };

  return { snapshot, openDevicePairSetup, renderSidebar };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
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
});
