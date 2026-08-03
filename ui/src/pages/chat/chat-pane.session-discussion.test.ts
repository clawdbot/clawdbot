/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import "./components/session-discussion-panel.ts";
import { openSlot } from "./sidebar-layout.ts";

type DiscussionTestPane = TestChatPane & {
  buildSessionDiscussionPanel: (
    state: ReturnType<typeof createTestChatPane>["state"],
    sessionKey: string,
  ) => SessionDiscussionPanelConfig | null;
  probeSessionDiscussion: (sessionKey: string) => Promise<void>;
  renderSessionDiscussionAction: () => unknown;
  paneWidth: number;
};

const SESSION_KEY = "agent:main:current";

function createDiscussionPane(params: {
  info: SessionDiscussionInfo | Promise<SessionDiscussionInfo>;
  detailOpen?: boolean;
}) {
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === "session.discussion.info") {
      return await params.info;
    }
    throw new Error(`unexpected method ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const created = createTestChatPane({ client, sessions: {} as SessionCapability });
  const pane = created.pane as DiscussionTestPane;
  const state = created.state;
  (pane.context.gateway.snapshot as { hello: unknown }).hello = {
    features: { methods: ["session.discussion.info", "session.discussion.open"] },
  };
  state.sidebarLayout = params.detailOpen ? openSlot({ columns: [] }, "detail") : { columns: [] };
  const updateSidebarLayout = vi.fn((layout) => {
    state.sidebarLayout = layout;
  });
  state.updateSidebarLayout = updateSidebarLayout;
  return { pane, state, updateSidebarLayout, request };
}

describe("chat pane session discussion auto-show", () => {
  it("auto-shows the discussion slot when the probe reports an open discussion", async () => {
    const { pane, state, updateSidebarLayout } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
    });

    await pane.probeSessionDiscussion(SESSION_KEY);

    expect(updateSidebarLayout).toHaveBeenCalledTimes(1);
    expect(
      state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
    ).toEqual(["discussion"]);
  });

  it("keeps the reported external URL with the promoted discussion panel", async () => {
    const openUrl = "https://clack.example/channels/c1";
    const { pane, state } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1", openUrl },
    });

    await pane.probeSessionDiscussion(SESSION_KEY);
    pane
      .buildSessionDiscussionPanel(state, SESSION_KEY)
      ?.onStateChange(SESSION_KEY, "open", openUrl);

    expect(pane.buildSessionDiscussionPanel(state, SESSION_KEY)?.openUrl).toBe(openUrl);
  });

  it("does not reload discussion info when the pane renders unchanged config twice", async () => {
    const { pane, state, request } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
    });
    const container = document.createElement("div");
    document.body.append(container);

    const renderPanel = async () => {
      const config = pane.buildSessionDiscussionPanel(state, SESSION_KEY)!;
      render(
        html`<openclaw-session-discussion
          .sessionKey=${config.sessionKey}
          .canOpen=${config.canOpen}
          .sourceGeneration=${pane.connectionGeneration}
          .loadInfo=${config.loadInfo}
          .openDiscussion=${config.openDiscussion}
          .onStateChange=${config.onStateChange}
        ></openclaw-session-discussion>`,
        container,
      );
      await container.querySelector("openclaw-session-discussion")?.updateComplete;
    };

    await renderPanel();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await renderPanel();
    expect(request).toHaveBeenCalledTimes(1);

    container.remove();
  });

  it("does not auto-show for a merely available discussion", async () => {
    const { pane, updateSidebarLayout } = createDiscussionPane({
      info: { state: "available" },
    });

    await pane.probeSessionDiscussion(SESSION_KEY);

    expect(updateSidebarLayout).not.toHaveBeenCalled();
  });

  it("uses the header action to open and close the discussion slot", async () => {
    const { pane, state, updateSidebarLayout } = createDiscussionPane({
      info: { state: "available" },
    });
    const container = document.createElement("div");
    document.body.append(container);

    await pane.probeSessionDiscussion(SESSION_KEY);
    render(pane.renderSessionDiscussionAction(), container);

    let action = container.querySelector<HTMLButtonElement>(".chat-session-discussion-toggle");
    expect(action?.ariaLabel).toBe("Show discussion");
    expect(action?.getAttribute("aria-pressed")).toBe("false");
    action?.click();
    expect(updateSidebarLayout).toHaveBeenCalledTimes(1);

    render(pane.renderSessionDiscussionAction(), container);
    action = container.querySelector<HTMLButtonElement>(".chat-session-discussion-toggle");
    expect(action?.ariaLabel).toBe("Hide discussion");
    expect(action?.getAttribute("aria-pressed")).toBe("true");
    action?.click();
    expect(state.sidebarLayout.columns).toEqual([]);
    expect(updateSidebarLayout).toHaveBeenCalledTimes(2);

    container.remove();
  });

  it("opens beside an existing detail slot without stealing it", async () => {
    const { pane, state } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
      detailOpen: true,
    });

    await pane.probeSessionDiscussion(SESSION_KEY);

    expect(
      state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
    ).toEqual(["detail", "discussion"]);
  });

  it("opens as a collapsed tab when two columns cannot fit side by side", async () => {
    const { pane, state } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
      detailOpen: true,
    });
    pane.paneWidth = 700;

    await pane.probeSessionDiscussion(SESSION_KEY);

    expect(
      state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
    ).toEqual(["detail", "discussion"]);
  });

  it("ignores a stale none callback after switching sessions", async () => {
    const { pane, state } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
    });
    await pane.probeSessionDiscussion(SESSION_KEY);
    const stalePanel = pane.buildSessionDiscussionPanel(state, SESSION_KEY);
    state.sessionKey = "agent:main:other";
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");

    stalePanel?.onStateChange(SESSION_KEY, "none", null);

    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
  });

  it("preserves discussion placement across a reconnect", async () => {
    const { pane, state } = createDiscussionPane({ info: { state: "available" } });
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
  });

  it("does not auto-show when the pane switched sessions before the probe resolved", async () => {
    let resolveInfo!: (value: SessionDiscussionInfo) => void;
    const { pane, state, updateSidebarLayout } = createDiscussionPane({
      info: new Promise<SessionDiscussionInfo>((resolve) => {
        resolveInfo = resolve;
      }),
    });

    const probe = pane.probeSessionDiscussion(SESSION_KEY);
    state.sessionKey = "agent:main:other";
    resolveInfo({ state: "open", embedUrl: "https://clack.example/embed/c1" });
    await probe;

    expect(updateSidebarLayout).not.toHaveBeenCalled();
  });
});
