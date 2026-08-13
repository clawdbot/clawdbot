/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { decodeResumeHandoff } from "../../../../src/shared/resume-handoff.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
  type DesktopPanelToggleDetail,
  type TerminalPanelToggleDetail,
} from "../../components/panel-toggle-contract.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";

function desktopHello(methods: string[], scopes: string[]): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 3,
    auth: { role: "operator", scopes },
    features: { methods },
  };
}

describe("chat pane terminal action", () => {
  it.each(["session", "owner", "target", "client", "reconnect"] as const)(
    "closes terminal continuation after a %s ownership change",
    async (change) => {
      const client = { gatewayUrl: "wss://gateway.example/control" } as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
      const row = {
        key: "bare-session",
        agentId: "row-agent",
        kind: "direct",
        updatedAt: 0,
      } satisfies GatewaySessionRow;
      const replacementRow = { ...row, key: "other-session" };
      const container = document.createElement("div");
      const paint = (selected: GatewaySessionRow) =>
        render(
          pane.renderPaneHeader(
            createSessionWorkspaceProps(state),
            createBackgroundTasksProps(state),
            selected,
            false,
            undefined,
            false,
          ),
          container,
        );

      await pane.handleHeaderSessionAction({ kind: "continue-in-terminal" }, row);
      paint(row);
      const command =
        container.querySelector(".continue-in-terminal-dialog .login-gate__command code")
          ?.textContent ?? "";
      expect(command).toMatch(/^openclaw resume --handoff [A-Za-z0-9_-]+$/u);
      expect(decodeResumeHandoff(command.slice("openclaw resume --handoff ".length))).toEqual({
        version: 1,
        sessionKey: "agent:row-agent:bare-session",
        gatewayUrl: "wss://gateway.example/control",
      });

      if (change === "owner") {
        paint({ ...row, agentId: "other-agent" });
      } else if (change === "target") {
        pane.context.gateway.connection.gatewayUrl = "wss://other.example/control";
        paint(row);
        pane.context.gateway.connection.gatewayUrl = "ws://example.test";
      } else if (change === "client") {
        pane.context.gateway.snapshot.client = {
          gatewayUrl: "wss://replacement.example/control",
        } as GatewayBrowserClient;
        paint(row);
        pane.context.gateway.snapshot.client = client;
      } else if (change === "reconnect") {
        pane.connectionGeneration += 1;
        paint(row);
        pane.connectionGeneration -= 1;
      } else {
        paint(replacementRow);
      }

      expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
      paint(row);
      expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it("disables terminal continuation with query-specific guidance", () => {
    const client = {
      gatewayUrl: "wss://gateway.example/control?route=alpha",
    } as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const row = {
      key: "main",
      agentId: "alpha",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");

    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        row,
        false,
        undefined,
        false,
      ),
      container,
    );

    const menu = container.querySelector<
      HTMLElement & {
        actionDisabledReasons: Record<string, string>;
      }
    >("openclaw-chat-header-session-menu");
    expect(menu?.actionDisabledReasons["continue-in-terminal"]).toBe(
      "Query-routed Gateway URLs cannot create credential-free continuation commands because authentication and stored device scope are not query-aware. Use a manually authenticated CLI target or a queryless configured Gateway URL.",
    );
  });

  it("renders only when available and opens the terminal dock", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const session = {
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    state.terminalAvailable = true;
    const container = document.createElement("div");
    const renderHeader = () =>
      render(
        pane.renderPaneHeader(
          createSessionWorkspaceProps(state),
          createBackgroundTasksProps(state),
          session,
          false,
          undefined,
          false,
        ),
        container,
      );
    const events: CustomEvent<TerminalPanelToggleDetail>[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent<TerminalPanelToggleDetail>);
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
    try {
      renderHeader();
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Toggle terminal"]');
      expect(button).not.toBeNull();
      button?.click();
      expect(events).toHaveLength(1);
      expect(events[0]?.detail).toEqual({ dock: "right", open: true });

      state.terminalAvailable = false;
      renderHeader();
      expect(container.querySelector('[aria-label="Toggle terminal"]')).toBeNull();
    } finally {
      window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
    }
  });

  it("targets the selected session from the desktop controls", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const localSession = {
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");
    const renderHeader = (session: GatewaySessionRow | undefined) => {
      render(
        pane.renderPaneHeader(
          createSessionWorkspaceProps(state),
          createBackgroundTasksProps(state),
          session,
          false,
          undefined,
          false,
        ),
        container,
      );
    };
    const panelActionIds = () =>
      container
        .querySelector<HTMLElement & { panelActions: Array<{ id: string }> }>(
          "openclaw-chat-header-session-menu",
        )
        ?.panelActions.map((action) => action.id) ?? [];
    const snapshot = pane.context.gateway.snapshot;
    snapshot.hello = desktopHello([], ["operator.admin"]);
    renderHeader(localSession);
    expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();

    snapshot.hello = desktopHello(["desktop.observe"], ["operator.admin"]);
    const events: CustomEvent<DesktopPanelToggleDetail>[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent<DesktopPanelToggleDetail>);
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    try {
      const targetCases: Array<{
        name: string;
        session: GatewaySessionRow;
        environmentId: string;
      }> = [
        { name: "local", session: localSession, environmentId: "gateway" },
        {
          name: "cloud",
          session: {
            ...localSession,
            execNode: "stale-node",
            placement: {
              state: "active",
              environmentId: "worker-desktop-1",
            } as GatewaySessionRow["placement"],
          },
          environmentId: "worker-desktop-1",
        },
        {
          name: "node",
          session: { ...localSession, execNode: "  paired-node  " },
          environmentId: "node:paired-node",
        },
        {
          name: "reclaimed",
          session: {
            ...localSession,
            execNode: " reclaimed-node ",
            placement: {
              state: "reclaimed",
              environmentId: "former-worker",
            } as GatewaySessionRow["placement"],
          },
          environmentId: "node:reclaimed-node",
        },
      ];
      for (const testCase of targetCases) {
        renderHeader(testCase.session);
        const button = container.querySelector<HTMLButtonElement>(
          '[aria-label="Toggle desktop panel"]',
        );
        expect(button, testCase.name).not.toBeNull();
        expect(panelActionIds(), testCase.name).toContain("desktop");
        button?.click();
        expect(events.at(-1)?.detail, testCase.name).toEqual({
          open: true,
          environmentId: testCase.environmentId,
        });
      }

      const eventCount = events.length;
      renderHeader({
        ...localSession,
        execNode: "must-not-fall-back",
        placement: { state: "requested" } as GatewaySessionRow["placement"],
      });
      expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
      expect(panelActionIds()).not.toContain("desktop");
      expect(events).toHaveLength(eventCount);

      renderHeader(undefined);
      expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
      expect(panelActionIds()).not.toContain("desktop");

      snapshot.hello = desktopHello(["desktop.observe"], ["operator.read"]);
      renderHeader(localSession);
      expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
    } finally {
      window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    }
  });

  it("renders the browser control only when available and exposes it in the narrow menu", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const session = {
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");
    const renderHeader = () =>
      render(
        pane.renderPaneHeader(
          createSessionWorkspaceProps(state),
          createBackgroundTasksProps(state),
          session,
          false,
          undefined,
          false,
        ),
        container,
      );
    const panelActionIds = () =>
      container
        .querySelector<HTMLElement & { panelActions: Array<{ id: string }> }>(
          "openclaw-chat-header-session-menu",
        )
        ?.panelActions.map((action) => action.id) ?? [];

    state.browserPanelAvailable = false;
    renderHeader();
    expect(container.querySelector(".chat-browser-panel-toggle")).toBeNull();
    expect(panelActionIds()).not.toContain("browser");

    const events: CustomEvent<BrowserPanelToggleDetail>[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent<BrowserPanelToggleDetail>);
    window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
    try {
      state.browserPanelAvailable = true;
      renderHeader();
      const button = container.querySelector<HTMLButtonElement>(".chat-browser-panel-toggle");
      expect(button).not.toBeNull();
      button?.click();
      expect(events).toHaveLength(1);

      (pane as typeof pane & { narrow: boolean }).narrow = true;
      renderHeader();
      expect(container.querySelector(".chat-browser-panel-toggle")).toBeNull();
      expect(panelActionIds()).toContain("browser");
    } finally {
      window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
    }
  });
});
