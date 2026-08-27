/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

function createProfileAppearanceGateway(profileId: string | null) {
  const request = vi.fn(async () => ({
    status: "ok",
    entries: { "ui.accent": "#336699" },
  }));
  const client = {
    gatewayUrl: "ws://profile.test",
    request,
  } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    sessionKey: "",
    selfUser: profileId ? { id: profileId } : null,
    hello: { auth: { role: "operator", scopes: ["operator.write"] } },
  } as ApplicationGatewaySnapshot;
  const refreshTheme = vi.fn();
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://profile.test" },
      snapshot,
    },
    runtimeConfig: {
      canPatch: false,
      ensureLoaded: vi.fn(async () => undefined),
      runExternalMutation: vi.fn(),
      state: {
        client,
        connected: true,
        configSnapshot: { config: { ui: { prefs: { accent: "#ff0000" } } } },
      },
    },
    theme: { refresh: refreshTheme, recordServerSelection: vi.fn() },
  } as unknown as ApplicationContext;
  const host = {
    context,
    activeSessionKey: "",
    agentRosterRefreshTimer: null,
    agentsListClient: null,
    agentsListSource: null,
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
  return {
    context,
    host,
    owner: new ShellGatewayOwner(host),
    refreshTheme,
    request,
    snapshot,
  };
}

describe("ShellGatewayOwner profile appearance integration", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("never requests durable profile preferences for an identity-free connection", () => {
    const { owner, request, snapshot } = createProfileAppearanceGateway(null);

    owner.synchronizeGateway(snapshot);
    owner.handleGatewayEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "someone-else", keys: ["ui.accent"] },
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("loads profile appearance when authenticated presence appears on an existing connection", async () => {
    const { owner, request, snapshot } = createProfileAppearanceGateway(null);
    owner.synchronizeGateway(snapshot);
    snapshot.selfUser = { id: "profile-owner" };

    owner.synchronizeGateway(snapshot);

    await vi.waitFor(() => expect(loadSettings().accent).toBe("#336699"));
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("users.prefs.get", {
      keys: ["ui.theme", "ui.themeMode", "ui.accent"],
    });
  });

  it("republishes profile provenance even when its appearance matches the browser mirror", async () => {
    patchSettings({ accent: "#336699" });
    const { owner, refreshTheme, snapshot } = createProfileAppearanceGateway("profile-owner");

    owner.synchronizeGateway(snapshot);

    await vi.waitFor(() => expect(refreshTheme).toHaveBeenCalledOnce());
    expect(loadSettings().accent).toBe("#336699");
  });

  it("reuses cached profile preferences across unrelated gateway config snapshots", async () => {
    const { context, owner, request, snapshot } = createProfileAppearanceGateway("profile-owner");
    owner.synchronizeGateway(snapshot);
    await vi.waitFor(() => expect(loadSettings().accent).toBe("#336699"));
    request.mockClear();
    const configState = context.runtimeConfig.state as {
      configSnapshot: { config: unknown };
    };
    configState.configSnapshot = {
      config: { ui: { prefs: { accent: "#884422" } }, agents: { defaults: {} } },
    };

    owner.reconcileServerUiPrefs(context.runtimeConfig);

    expect(request).not.toHaveBeenCalled();
    expect(loadSettings().accent).toBe("#336699");
  });

  it("refreshes only matching profile-change events and republishes the resolved appearance", async () => {
    const { owner, refreshTheme, request, snapshot } =
      createProfileAppearanceGateway("profile-owner");
    owner.synchronizeGateway(snapshot);
    await vi.waitFor(() => expect(loadSettings().accent).toBe("#336699"));
    request.mockClear();
    refreshTheme.mockClear();
    request.mockResolvedValueOnce({ status: "ok", entries: { "ui.accent": "#224466" } });

    owner.handleGatewayEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "other-profile", keys: ["ui.accent"] },
    });
    expect(request).not.toHaveBeenCalled();

    owner.handleGatewayEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "profile-owner", keys: ["ui.accent"] },
    });

    await vi.waitFor(() => expect(loadSettings().accent).toBe("#224466"));
    expect(request).toHaveBeenCalledOnce();
    expect(refreshTheme).toHaveBeenCalledOnce();
  });
});
