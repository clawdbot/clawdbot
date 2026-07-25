/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderSidebarRegion, resolveSidebarLayoutForBoard } from "./chat-pane-sidebar-layout.ts";
import { openSlot } from "./sidebar-layout.ts";

function board(dock: ResolvedBoardView["dock"], face: ResolvedBoardView["face"] = "dashboard") {
  return {
    hasBoard: true,
    face,
    dock,
  } as ResolvedBoardView;
}

describe("chat pane sidebar layout", () => {
  it("preserves the primary DOM across open, close, and reopen", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const callbacks = {
      activatePanel: vi.fn(),
      closeSlot: vi.fn(),
      detachPanel: vi.fn(),
      mergePanel: vi.fn(),
      resizeColumn: vi.fn(),
    };
    const renderLayout = async (layout: ReturnType<typeof openSlot> | { columns: [] }) => {
      render(
        renderSidebarRegion({
          availableWidth: 1_400,
          callbacks,
          discussionOpenUrl: null,
          focusPanelId: "",
          focusVersion: 0,
          layout,
          narrow: false,
          panelTemplates: { detail: html`<aside>Details</aside>` },
          primary: html`<main data-primary>Primary</main>`,
          sessionKey: "agent:main:current",
        }),
        container,
      );
      await container.querySelector("openclaw-chat-sidebar-region")?.updateComplete;
    };

    await renderLayout({ columns: [] });
    const primary = container.querySelector("[data-primary]");
    await renderLayout(openSlot({ columns: [] }, "detail"));
    expect(container.querySelector("[data-primary]")).toBe(primary);
    await renderLayout({ columns: [] });
    expect(container.querySelector("[data-primary]")).toBe(primary);
    await renderLayout(openSlot({ columns: [] }, "detail"));
    expect(container.querySelector("[data-primary]")).toBe(primary);

    container.remove();
  });

  it("promotes side-docked dashboard chat into the requested side", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("left"),
      hasDetail: false,
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    expect(layout.columns[0]?.side).toBe("left");
    expect(layout.columns[0]?.panels[0]?.slot).toBe("chat");
  });

  it("keeps bottom chat outside the sidebar model", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("bottom"),
      hasDetail: true,
      layout: openSlot(openSlot({ columns: [] }, "chat"), "detail"),
      paneWidth: 1_400,
    });
    expect(layout.columns.flatMap((column) => column.panels.map((panel) => panel.slot))).toEqual([
      "detail",
    ]);
  });

  it("drops stale detail placement when no transient detail is available", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("hidden", "chat"),
      hasDetail: false,
      layout: openSlot({ columns: [] }, "detail"),
      paneWidth: 1_400,
    });
    expect(layout).toEqual({ columns: [] });
  });

  it("refits ordinary chat columns to preserve the primary minimum", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("hidden", "chat"),
      hasDetail: true,
      layout: openSlot(openSlot({ columns: [] }, "detail"), "discussion"),
      paneWidth: 1_000,
    });
    expect(layout.columns.reduce((sum, column) => sum + column.width, 0)).toBe(680);
  });
});
