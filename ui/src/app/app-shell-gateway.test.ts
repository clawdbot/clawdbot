/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

function createProfileAppearanceGateway(profileId: string | null) {
  const pendingResponses: Array<(accent: string) => void> = [];
  const request = vi.fn(
    () =>
      new Promise<{ status: string; entries: { "ui.accent": string } }>((resolve) => {
        pendingResponses.push((accent) =>
          resolve({ status: "ok", entries: { "ui.accent": accent } }),
        );
      }),
  );
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
  const connectionBootstrap = {
    reset: vi.fn(),
    run: (_key: string, task: () => Promise<unknown>) => task(),
    synchronize: vi.fn(),
  };
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://profile.test" },
      snapshot,
    },
    connectionBootstrap,
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
    async completeProfileAppearance(this: void, accent = "#336699") {
      await vi.waitFor(() => {
        expect(pendingResponses).toHaveLength(1);
      });
      const respond = pendingResponses.shift();
      expect(respond, "pending users.prefs.get response").toBeDefined();
      // Config reconciliation can also refresh the theme. Arm this only when
      // releasing this request, after any synchronous reconciliation has finished.
      const refreshed = new Promise<void>((resolve) => {
        refreshTheme.mockImplementationOnce(resolve);
      });
      respond!(accent);
      return refreshed;
    },
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
    const { completeProfileAppearance, context, owner, refreshTheme, request, snapshot } =
      createProfileAppearanceGateway(null);
    owner.synchronizeGateway(snapshot);
    snapshot.selfUser = { id: "profile-owner" };

    owner.synchronizeGateway(snapshot);

    owner.reconcileServerUiPrefs(context.runtimeConfig);
    expect(refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().accent).toBe("#ff0000");
    await completeProfileAppearance();
    expect(refreshTheme).toHaveBeenCalledTimes(2);
    expect(loadSettings().accent).toBe("#336699");
    expect(request).toHaveBeenCalledOnce();
    // Derived from the wire contract so new appearance keys extend the
    // request without silently invalidating this expectation.
    expect(request).toHaveBeenCalledWith("users.prefs.get", {
      keys: Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
    });
  });

  it("republishes profile provenance even when its appearance matches the browser mirror", async () => {
    patchSettings({ accent: "#336699" });
    const { completeProfileAppearance, owner, refreshTheme, snapshot } =
      createProfileAppearanceGateway("profile-owner");

    owner.synchronizeGateway(snapshot);

    await completeProfileAppearance();
    expect(refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().accent).toBe("#336699");
  });

  it("reuses cached profile preferences across unrelated gateway config snapshots", async () => {
    const { completeProfileAppearance, context, owner, request, snapshot } =
      createProfileAppearanceGateway("profile-owner");
    owner.synchronizeGateway(snapshot);
    await completeProfileAppearance();
    expect(loadSettings().accent).toBe("#336699");
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
    const { completeProfileAppearance, owner, refreshTheme, request, snapshot } =
      createProfileAppearanceGateway("profile-owner");
    owner.synchronizeGateway(snapshot);
    await completeProfileAppearance();
    expect(loadSettings().accent).toBe("#336699");
    request.mockClear();
    refreshTheme.mockClear();

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

    await completeProfileAppearance("#224466");
    expect(loadSettings().accent).toBe("#224466");
    expect(request).toHaveBeenCalledOnce();
    expect(refreshTheme).toHaveBeenCalledOnce();
  });
});
