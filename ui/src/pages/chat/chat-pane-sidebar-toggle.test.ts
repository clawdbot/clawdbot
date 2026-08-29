/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { isSidebarSlotVisible, openSlot } from "./sidebar-layout.ts";

function dispatchWorkspaceShortcut(pane: TestChatPane) {
  const event = new KeyboardEvent("keydown", {
    cancelable: true,
    key: "и",
    code: "KeyB",
    metaKey: true,
    shiftKey: true,
  });
  pane.handleDocumentKeydown(event);
  return event;
}

describe("chat pane sidebar toggles", () => {
  it("activates a stored Workspace tab from the rail", () => {
    const sidebarLayout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");
    const state = makeChatHost({ connected: false }) as unknown as ChatPageHost;
    const updateSidebarLayout = vi.fn((layout) => {
      state.sidebarLayout = layout;
    });

    const rails = createChatPaneRails({
      state,
      sidebarLayout,
      presentationId: "pane-left",
      presented: true,
      gatewaySnapshot: { hello: null } as never,
      setObserverVisibility: vi.fn(),
      updateSidebarLayout,
    });

    expect(rails.sessionWorkspace.collapsed).toBe(true);
    rails.sessionWorkspace.onToggleCollapsed();

    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "workspace",
      "terminal",
    ]);
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);
  });

  it("activates a stored Workspace tab from the keyboard shortcut", () => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.active = true;
    state.connected = false;
    state.sidebarLayout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");

    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(false);

    const event = dispatchWorkspaceShortcut(pane);

    expect(event.defaultPrevented).toBe(true);
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "workspace",
      "terminal",
    ]);
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);
  });
});
