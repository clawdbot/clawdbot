/* @vitest-environment jsdom */

import { render as renderLit, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
// This test owns shell panel routing, not lazy sidebar loading; settle that module at setup.
import "../components/app-sidebar.ts";
import "./app-host.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { loadSettings } from "./settings.ts";

type ShellRenderState = {
  runtime: ApplicationRuntime;
  activeSessionKey: string;
  routeState: {
    routeId: RouteId;
    location?: { hash: string; pathname: string; search: string };
  };
  render: () => TemplateResult;
};

afterEach(() => {
  resetAppHostTestGlobals();
});

describe("OpenClaw shell dock suppression", () => {
  it("applies route ownership to shell panels without session-gating desktop", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const client = {} as GatewayBrowserClient;
    const context = {
      basePath: "",
      gateway: {
        snapshot: {
          phase: "connected",
          client,
          sessionKey: "agent:main:main",
          assistantAgentId: "main",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: {
              methods: [
                "terminal.open",
                "browser.request",
                "openclaw.chat",
                "desktop.observe",
                "chat.history",
                "chat.send",
              ],
            },
          },
          lastError: null,
          offlineStable: false,
          selfUser: null,
        },
        connection: { gatewayUrl: "ws://gateway.test", token: "", password: "" },
        connect: vi.fn(),
      },
      agents: {
        state: {
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main" }, { id: "research" }],
          },
        },
      },
      agentSelection: { state: { selectedId: "research" } },
      config: {
        current: { terminalEnabled: true, serverVersion: null, devGitBranch: null },
      },
      runtimeConfig: {
        state: { configSchema: null, configForm: null, configSnapshot: null, configUiHints: null },
      },
      sessions: {
        state: {
          agentId: "main",
          result: {
            count: 1,
            defaults: {},
            path: "",
            sessions: [
              { key: "agent:main:main", kind: "direct", updatedAt: 0 } satisfies GatewaySessionRow,
            ],
            ts: 0,
          },
        },
      },
      navigation: {
        snapshot: {
          navCollapsed: false,
          navWidth: 280,
          sidebarEntries: [],
          pinnedAgentIds: [],
        },
        update: vi.fn(),
      },
      overlays: {
        snapshot: {
          updateAvailable: null,
          updateRunning: false,
          updateStatusBanner: null,
          recordedUpdateAttempt: null,
          controlUiRefreshRequired: false,
          approvalQueue: [],
          approvalBusy: false,
          approvalErrors: new Map(),
          devicePairSetupOpen: false,
          devicePairSetupLifecycle: { phase: "selection", access: "full" },
          devicePairPendingCount: 0,
        },
        runUpdate: vi.fn(),
      },
      theme: { mode: "dark", settings: loadSettings() },
      preload: vi.fn(),
    } as unknown as ApplicationContext;
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellRenderState;
    shell.runtime = { context, router: {} } as unknown as ApplicationRuntime;
    shell.activeSessionKey = "agent:main:main";
    const container = document.createElement("div");
    const desktopAvailable = () =>
      (
        container.querySelector("openclaw-desktop-panel") as
          | (HTMLElement & {
              available: boolean;
            })
          | null
      )?.available ?? false;

    shell.routeState = { routeId: "appearance" };
    renderLit(shell.render(), container);
    expect(
      container.querySelector<HTMLElement & { pageRouteId: RouteId }>("openclaw-assistant-panel")
        ?.pageRouteId,
    ).toBe("appearance");
    expect(
      (
        container.querySelector("openclaw-terminal-panel") as HTMLElement & {
          agentId: string | null;
        }
      ).agentId,
    ).toBe("research");
    expect(
      (
        container.querySelector("openclaw-terminal-panel") as HTMLElement & {
          suppressed: boolean;
        }
      ).suppressed,
    ).toBe(true);
    expect(
      (
        container.querySelector("openclaw-assistant-panel") as HTMLElement & {
          custodianSuppressed: boolean;
        }
      ).custodianSuppressed,
    ).toBe(false);

    shell.routeState = { routeId: "custodian" };
    renderLit(shell.render(), container);
    expect(
      (
        container.querySelector("openclaw-assistant-panel") as HTMLElement & {
          custodianSuppressed: boolean;
        }
      ).custodianSuppressed,
    ).toBe(true);

    shell.routeState = { routeId: "chat" };
    renderLit(shell.render(), container);
    expect(
      container.querySelector<HTMLElement & { pageRouteId: RouteId }>("openclaw-assistant-panel")
        ?.pageRouteId,
    ).toBe("chat");
    expect(
      (
        container.querySelector("openclaw-terminal-panel") as HTMLElement & {
          sessionKey: string | null;
        }
      ).sessionKey,
    ).toBe("agent:main:main");
    expect(container.querySelector("openclaw-browser-panel")).toBeNull();
    expect(container.querySelector("openclaw-desktop-panel")).toBeNull();

    shell.routeState = {
      routeId: "new-session",
      location: { pathname: "/new-session", search: "?agent=missing", hash: "" },
    };
    renderLit(shell.render(), container);
    expect(
      (
        container.querySelector("openclaw-terminal-panel") as HTMLElement & {
          agentId: string | null;
        }
      ).agentId,
    ).toBe("research");

    shell.routeState = {
      routeId: "new-session",
      location: { pathname: "/new-session", search: "?agent=main", hash: "" },
    };
    renderLit(shell.render(), container);
    expect(
      (
        container.querySelector("openclaw-terminal-panel") as HTMLElement & {
          agentId: string | null;
        }
      ).agentId,
    ).toBe("main");

    context.sessions.state.result!.sessions = [
      {
        key: "agent:main:main",
        kind: "direct",
        placement: { state: "active" } as GatewaySessionRow["placement"],
        updatedAt: 0,
      },
    ];
    renderLit(shell.render(), container);
    expect(desktopAvailable()).toBe(true);

    context.sessions.state.result!.sessions = [
      { key: "agent:main:main", kind: "direct", updatedAt: 0 },
    ];
    renderLit(shell.render(), container);
    expect(desktopAvailable()).toBe(true);

    context.sessions.state.result = null;
    renderLit(shell.render(), container);
    expect(desktopAvailable()).toBe(true);

    // Collapsed-nav fallback: the Ask OpenClaw toggle joins the chrome strip
    // only while the sidebar (its footer home) is hidden, and stays admin-gated.
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    context.navigation.snapshot.navCollapsed = true;
    renderLit(shell.render(), container);
    expect(container.querySelector(".shell-chrome-controls__custodian")).not.toBeNull();
    expect(container.querySelector(".shell-chrome-controls__home")).not.toBeNull();
    context.gateway.snapshot.hello!.auth = {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    };
    renderLit(shell.render(), container);
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    expect(container.querySelector(".shell-chrome-controls__home")).not.toBeNull();
    context.gateway.snapshot.phase = "offline";
    renderLit(shell.render(), container);
    expect(container.querySelector(".shell-chrome-controls__home")).not.toBeNull();
    context.gateway.connection.gatewayUrl = "ws://another-gateway.test";
    renderLit(shell.render(), container);
    expect(container.querySelector(".shell-chrome-controls__home")).toBeNull();
    context.gateway.snapshot.phase = "connected";
    renderLit(shell.render(), container);
    expect(container.querySelector(".shell-chrome-controls__home")).not.toBeNull();
    context.gateway.snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
    renderLit(shell.render(), container);
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    expect(container.querySelector(".shell-chrome-controls__home")).toBeNull();
    context.gateway.snapshot.phase = "offline";
    renderLit(shell.render(), container);
    expect(container.querySelector(".shell-chrome-controls__home")).toBeNull();
  });
});
