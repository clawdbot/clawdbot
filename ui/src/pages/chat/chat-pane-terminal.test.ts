/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { decodeResumeHandoff } from "../../../../src/shared/resume-handoff.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import { openSlot } from "./sidebar-layout.ts";

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

  it("exposes the terminal as a side-panel tab only when available", () => {
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
          {
            ...createSessionWorkspaceProps(state),
            onToggleTerminal: state.terminalAvailable
              ? () => state.updateSidebarLayout(openSlot(state.sidebarLayout, "terminal"))
              : undefined,
          },
          createBackgroundTasksProps(state),
          session,
          false,
          undefined,
          false,
        ),
        container,
      );
    const panelActions = () =>
      container.querySelector<
        HTMLElement & { panelActions: Array<{ id: string; onActivate: () => void }> }
      >("openclaw-chat-header-session-menu")?.panelActions ?? [];

    renderHeader();
    expect(container.querySelector('[aria-label="Toggle terminal"]')).toBeNull();
    panelActions()
      .find((action) => action.id === "terminal")
      ?.onActivate();
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toContain("terminal");

    state.terminalAvailable = false;
    renderHeader();
    expect(panelActions().some((action) => action.id === "terminal")).toBe(false);
  });

  it("exposes Desktop as a side-panel action only for observable session targets", () => {
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
    const onToggleDesktop = vi.fn();
    const renderDesktopHeader = (session: GatewaySessionRow | undefined) => {
      render(
        pane.renderPaneHeader(
          { ...createSessionWorkspaceProps(state), onToggleDesktop },
          createBackgroundTasksProps(state),
          session,
          false,
          undefined,
          false,
        ),
        container,
      );
    };
    {
      const targetCases: Array<{
        name: string;
        session: GatewaySessionRow;
      }> = [
        { name: "local", session: localSession },
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
        },
        {
          name: "node",
          session: { ...localSession, execNode: "  paired-node  " },
        },
      ];
      for (const testCase of targetCases) {
        renderDesktopHeader(testCase.session);
        expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
        expect(panelActionIds(), testCase.name).toContain("desktop");
        const menu = container.querySelector<
          HTMLElement & { panelActions: Array<{ id: string; onActivate: () => void }> }
        >("openclaw-chat-header-session-menu");
        menu?.panelActions.find((action) => action.id === "desktop")?.onActivate();
        expect(onToggleDesktop, testCase.name).toHaveBeenCalledTimes(1);
        onToggleDesktop.mockClear();
      }

      for (const placement of [
        { state: "requested" },
        { state: "reclaimed", environmentId: "former-worker" },
      ]) {
        renderDesktopHeader({
          ...localSession,
          execNode: "must-not-fall-back",
          placement: placement as GatewaySessionRow["placement"],
        });
        expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
        expect(panelActionIds()).not.toContain("desktop");
      }

      renderDesktopHeader(undefined);
      expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
      expect(panelActionIds()).not.toContain("desktop");

      snapshot.hello = desktopHello(["desktop.observe"], ["operator.read"]);
      renderDesktopHeader(localSession);
      expect(container.querySelector('[aria-label="Toggle desktop panel"]')).toBeNull();
    }
  });

  it("keeps Browser and Tasks reachable in the topbar", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const session = {
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");
    const onToggleTasks = vi.fn();
    const backgroundTasks = {
      ...createBackgroundTasksProps(state),
      onToggleCollapsed: onToggleTasks,
    };
    const renderHeader = () =>
      render(
        pane.renderPaneHeader(
          createSessionWorkspaceProps(state),
          backgroundTasks,
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
    container.querySelector<HTMLButtonElement>(".chat-tasks-toggle")?.click();
    expect(onToggleTasks).toHaveBeenCalledOnce();

    state.browserPanelAvailable = true;
    const onToggleBrowser = vi.fn();
    render(
      pane.renderPaneHeader(
        { ...createSessionWorkspaceProps(state), onToggleBrowser },
        backgroundTasks,
        session,
        false,
        undefined,
        false,
      ),
      container,
    );
    container.querySelector<HTMLButtonElement>(".chat-browser-panel-toggle")?.click();
    expect(onToggleBrowser).toHaveBeenCalledOnce();
    expect(panelActionIds()).toContain("browser");
    container
      .querySelector<HTMLElement & { panelActions: Array<{ id: string; onActivate: () => void }> }>(
        "openclaw-chat-header-session-menu",
      )
      ?.panelActions.find((action) => action.id === "browser")
      ?.onActivate();
    expect(onToggleBrowser).toHaveBeenCalledTimes(2);
  });
});
