/* @vitest-environment jsdom */

import { html, render, type nothing, type TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { openSlot } from "./sidebar-layout.ts";

type BoardTestPane = HTMLElement & {
  context: ApplicationContext;
  state: ChatPageHost;
  resolveBoardProvider: () => BoardProvider;
  resolveBoardView: () => ResolvedBoardView;
  renderBoardPanel: (
    board: ResolvedBoardView,
    layout: ChatPageHost["sidebarLayout"],
  ) => TemplateResult | typeof nothing;
  releaseBoardProviderLease: () => void;
};

type BoardSnapshot = BoardProvider["snapshot$"]["value"];

function createGatewayBoardPane(sessionKey: string) {
  const snapshot: BoardSnapshot = { sessionKey, revision: 1, tabs: [], widgets: [] };
  const request = vi.fn<(method: string, params: unknown) => Promise<BoardSnapshot>>(
    async () => snapshot,
  );
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const { pane: base } = createTestChatPane({ client, sessions: createSessionCapabilityFixture() });
  const pane = base as unknown as BoardTestPane;
  pane.state.sessionKey = sessionKey;
  Reflect.set(pane, "boardProviderLifecycleConnected", true);
  pane.context = {
    ...pane.context,
    gateway: {
      ...pane.context.gateway,
      snapshot: { client, phase: "connected", hello: { features: { methods: ["board.get"] } } },
    },
  } as unknown as ApplicationContext;
  // Lit only starts updating once connected, so the skeleton's reflected
  // attributes need a container that lives in the document.
  const container = document.body.appendChild(document.createElement("div"));
  const layout = openSlot({ columns: [] }, "dashboard");
  return {
    pane,
    request,
    snapshot,
    container,
    draw: () => render(pane.renderBoardPanel(pane.resolveBoardView(), layout), container),
    cleanup: () => {
      render(html``, container);
      container.remove();
      pane.releaseBoardProviderLease();
    },
  };
}

describe("chat pane board loading states", () => {
  it("shows a board skeleton until the snapshot arrives", async () => {
    const sessionKey = "agent:main:pending-board";
    const { pane, request, snapshot, container, draw, cleanup } =
      createGatewayBoardPane(sessionKey);
    let complete!: (snapshot: BoardSnapshot) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const provider = pane.resolveBoardProvider();
    try {
      draw();
      const skeleton = container.querySelector("openclaw-panel-loading-skeleton");
      await skeleton?.updateComplete;
      expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("board");
      expect(skeleton?.getAttribute("role")).toBe("status");
      expect(container.textContent?.trim()).toBe("");
      complete(snapshot);
      await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
      draw();
      expect(container.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
      expect(container.querySelector("openclaw-board-view")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("replaces the skeleton with a styled alert when the snapshot fails to load", async () => {
    const { pane, request, container, draw, cleanup } = createGatewayBoardPane(
      "agent:main:failing-board",
    );
    request.mockRejectedValueOnce(new Error("gateway offline"));
    const provider = pane.resolveBoardProvider();
    try {
      await vi.waitFor(() => expect(provider.loadError$.value).toBeTruthy());
      draw();
      const alert = container.querySelector('[role="alert"]');
      expect(container.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
      expect(alert?.classList.contains("board-session-surface__state--error")).toBe(true);
      expect(alert?.textContent).toContain("gateway offline");
    } finally {
      cleanup();
    }
  });
});
