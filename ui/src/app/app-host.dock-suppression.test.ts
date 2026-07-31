/* @vitest-environment jsdom */

import { render as renderLit, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import "./app-host.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";

type ShellRenderState = {
  runtime: ApplicationRuntime;
  routeState: { routeId: RouteId };
  render: () => TemplateResult;
};

afterEach(() => {
  resetAppHostTestGlobals();
});

describe("OpenClaw shell dock suppression", () => {
  it("keeps Ask OpenClaw on settings pages and suppresses it only on its full page", () => {
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
            features: { methods: ["terminal.open", "browser.request", "openclaw.chat"] },
          },
          lastError: null,
          offlineStable: false,
          selfUser: null,
        },
        connection: { gatewayUrl: "ws://gateway.test", token: "", password: "" },
        connect: vi.fn(),
      },
      agents: { state: { agentsList: null } },
      agentSelection: { state: { selectedId: "main" } },
      config: {
        current: { terminalEnabled: true, serverVersion: null, devGitBranch: null },
      },
      runtimeConfig: {
        state: { configSchema: null, configForm: null, configSnapshot: null, configUiHints: null },
      },
      sessions: { state: { result: null } },
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
          controlUiRefreshRequired: false,
          approvalQueue: [],
          approvalBusy: false,
          approvalErrors: new Map(),
          approvalNowMs: 0,
          devicePairSetupOpen: false,
          devicePairSetupLoading: false,
          devicePairSetupError: null,
          devicePairSetup: null,
          devicePairSetupAccess: "full",
          devicePairPendingCount: 0,
          deviceAuthMigration: { error: null },
        },
        runUpdate: vi.fn(),
      },
      theme: { mode: "dark" },
      preload: vi.fn(),
    } as unknown as ApplicationContext;
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellRenderState;
    shell.runtime = { context, router: {} } as unknown as ApplicationRuntime;
    const container = document.createElement("div");

    shell.routeState = { routeId: "appearance" };
    renderLit(shell.render(), container);
    expect(
      (
        container.querySelector("openclaw-terminal-panel") as HTMLElement & {
          suppressed: boolean;
        }
      ).suppressed,
    ).toBe(true);
    expect(
      (
        container.querySelector("openclaw-custodian-panel") as HTMLElement & {
          suppressed: boolean;
        }
      ).suppressed,
    ).toBe(false);

    shell.routeState = { routeId: "custodian" };
    renderLit(shell.render(), container);
    expect(
      (
        container.querySelector("openclaw-custodian-panel") as HTMLElement & {
          suppressed: boolean;
        }
      ).suppressed,
    ).toBe(true);

    shell.routeState = { routeId: "chat" };
    renderLit(shell.render(), container);
    expect(
      (
        container.querySelector("openclaw-terminal-panel") as HTMLElement & {
          suppressed: boolean;
        }
      ).suppressed,
    ).toBe(false);
  });
});
