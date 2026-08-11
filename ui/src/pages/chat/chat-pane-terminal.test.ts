/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  DESKTOP_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
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

  it("renders the desktop launcher only when available and opens the panel", () => {
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
    const snapshot = pane.context.gateway.snapshot;
    snapshot.hello = desktopHello([], ["operator.admin"]);
    renderHeader();
    expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();

    snapshot.hello = desktopHello(["worker.desktop.observe"], ["operator.admin"]);
    const events: CustomEvent<DesktopPanelToggleDetail>[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent<DesktopPanelToggleDetail>);
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    try {
      renderHeader();
      const button = container.querySelector<HTMLButtonElement>(
        '[aria-label="Toggle desktop panel"]',
      );
      expect(button).not.toBeNull();
      button?.click();
      expect(events).toHaveLength(1);
      expect(events[0]?.detail).toEqual({ open: true });

      snapshot.hello = desktopHello(["worker.desktop.observe"], ["operator.read"]);
      renderHeader();
      expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
    } finally {
      window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    }
  });
});
