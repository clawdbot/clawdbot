/* @vitest-environment jsdom */

import { render as renderLit, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
// Settle sidebar so collapsed chrome can render without lazy-load races.
import "../components/app-sidebar.ts";
import "./app-host.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { loadSettings } from "./settings.ts";

type ShellRenderState = {
  runtime: ApplicationRuntime;
  activeSessionKey: string;
  routeState: ShellRouteState;
  render: () => TemplateResult;
};

afterEach(() => {
  resetAppHostTestGlobals();
});

function renderCollapsedChrome(options: {
  environment: { label: string; color: "amber" } | null;
  assistantName: string;
}) {
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
            methods: ["openclaw.chat", "chat.history", "chat.send", "sessions.create"],
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
          agents: [{ id: "main" }],
        },
      },
    },
    agentSelection: { state: { selectedId: "main" } },
    config: {
      current: {
        terminalEnabled: true,
        serverVersion: null,
        devGitBranch: null,
        environment: options.environment,
        assistantIdentity: { name: options.assistantName, avatar: null },
      },
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
        navCollapsed: true,
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
  shell.routeState = { routeId: "chat" };

  const container = document.createElement("div");
  renderLit(shell.render(), container);
  return container.querySelector<HTMLElement>(".shell-chrome-controls__nav-toggle");
}

describe("OpenClaw shell collapsed chrome avatar", () => {
  it("sets data-env-avatar to a complete emoji grapheme when environment is set", () => {
    const toggle = renderCollapsedChrome({
      environment: { label: "edge", color: "amber" },
      assistantName: "😀Alice",
    });

    expect(toggle?.getAttribute("data-env-avatar")).toBe("😀");
    expect(toggle?.getAttribute("data-env-avatar")).not.toBe("😀Alice".charAt(0));
  });

  it("omits data-env-avatar when environment is set but the assistant name is empty", () => {
    const toggle = renderCollapsedChrome({
      environment: { label: "edge", color: "amber" },
      assistantName: "",
    });

    expect(toggle?.hasAttribute("data-env-avatar")).toBe(false);
  });
});
