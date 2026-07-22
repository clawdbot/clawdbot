/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";
import "./components/chat-sidebar.ts";

type DiscussionTestPane = TestChatPane & {
  probeSessionDiscussion: (sessionKey: string) => Promise<void>;
  renderSessionDiscussionAction: () => unknown;
};

const SESSION_KEY = "agent:main:current";

function createDiscussionPane(params: {
  info: SessionDiscussionInfo | Promise<SessionDiscussionInfo>;
  sidebarOpen?: boolean;
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
  const handleOpenSidebar = vi.fn((content: SidebarContent) => {
    state.sidebarContent = content;
    state.sidebarOpen = true;
  });
  const handleCloseSidebar = vi.fn(() => {
    state.sidebarOpen = false;
  });
  state.handleOpenSidebar = handleOpenSidebar;
  state.handleCloseSidebar = handleCloseSidebar;
  state.sidebarOpen = params.sidebarOpen ?? false;
  return { pane, state, handleOpenSidebar, handleCloseSidebar, request };
}

describe("chat pane session discussion auto-show", () => {
  it("auto-shows the sidebar when the probe reports an open discussion", async () => {
    const { pane, handleOpenSidebar } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
    });

    await pane.probeSessionDiscussion(SESSION_KEY);

    expect(handleOpenSidebar).toHaveBeenCalledTimes(1);
    const content = handleOpenSidebar.mock.calls[0]?.[0];
    expect(content?.kind).toBe("session-discussion");
    expect(content && "sessionKey" in content ? content.sessionKey : null).toBe(SESSION_KEY);
  });

  it("shows the reported external URL in the outer sidebar header", async () => {
    const openUrl = "https://clack.example/channels/c1";
    const { pane, state, handleOpenSidebar } = createDiscussionPane({
      info: {
        state: "open",
        embedUrl: "https://clack.example/embed/c1",
        openUrl,
      },
    });

    await pane.probeSessionDiscussion(SESSION_KEY);

    const content = handleOpenSidebar.mock.calls[0]?.[0];
    if (!content || content.kind !== "session-discussion") {
      throw new Error("expected a session discussion sidebar");
    }
    content.onStateChange(SESSION_KEY, "open", openUrl);

    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: SidebarContent;
      onClose: () => void;
      updateComplete: Promise<unknown>;
    };
    panel.content = state.sidebarContent as SidebarContent;
    panel.onClose = vi.fn();
    document.body.append(panel);
    await panel.updateComplete;

    const external = panel.querySelector<HTMLAnchorElement>(".sidebar-header a");
    expect(external?.href).toBe(openUrl);
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener");
    expect(panel.querySelector(".session-discussion__header")).toBeNull();
    panel.remove();
  });

  it("does not auto-show for a merely available discussion", async () => {
    const { pane, handleOpenSidebar } = createDiscussionPane({
      info: { state: "available" },
    });

    await pane.probeSessionDiscussion(SESSION_KEY);

    expect(handleOpenSidebar).not.toHaveBeenCalled();
  });

  it("uses the header action to open and close the discussion sidebar", async () => {
    const { pane, handleOpenSidebar, handleCloseSidebar } = createDiscussionPane({
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
    expect(handleOpenSidebar).toHaveBeenCalledTimes(1);

    render(pane.renderSessionDiscussionAction(), container);
    action = container.querySelector<HTMLButtonElement>(".chat-session-discussion-toggle");
    expect(action?.ariaLabel).toBe("Hide discussion");
    expect(action?.getAttribute("aria-pressed")).toBe("true");
    action?.click();
    expect(handleCloseSidebar).toHaveBeenCalledTimes(1);
    expect(handleOpenSidebar).toHaveBeenCalledTimes(1);

    container.remove();
  });

  it("does not steal a sidebar that is already open", async () => {
    const { pane, handleOpenSidebar } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
      sidebarOpen: true,
    });

    await pane.probeSessionDiscussion(SESSION_KEY);

    expect(handleOpenSidebar).not.toHaveBeenCalled();
  });

  it("does not auto-show when the pane switched sessions before the probe resolved", async () => {
    let resolveInfo!: (value: SessionDiscussionInfo) => void;
    const { pane, state, handleOpenSidebar } = createDiscussionPane({
      info: new Promise<SessionDiscussionInfo>((resolve) => {
        resolveInfo = resolve;
      }),
    });

    const probe = pane.probeSessionDiscussion(SESSION_KEY);
    state.sessionKey = "agent:main:other";
    resolveInfo({ state: "open", embedUrl: "https://clack.example/embed/c1" });
    await probe;

    expect(handleOpenSidebar).not.toHaveBeenCalled();
  });
});
