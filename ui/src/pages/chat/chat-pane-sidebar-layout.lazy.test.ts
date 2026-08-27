/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSlot } from "./sidebar-layout.ts";

const lazyMocks = vi.hoisted(() => ({
  importAttempts: 0,
  retryDocument: vi.fn(async () => true),
}));

vi.mock("./components/chat-sidebar-region.runtime.ts", () => {
  lazyMocks.importAttempts += 1;
  throw new Error("Failed to fetch dynamically imported module: sidebar-region.js");
});

vi.mock("../../app/stale-chunk-reload.ts", () => ({
  isStaleChunkImportError: () => true,
  retryStaleChunkReloadWhenReachable: lazyMocks.retryDocument,
  scheduleStaleChunkReload: vi.fn(async () => false),
}));

import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("chat pane lazy sidebar failures", () => {
  it("keeps primary chat visible and offers document-level recovery", async () => {
    vi.stubGlobal("customElements", { get: vi.fn(() => undefined) });
    const container = document.createElement("div");
    document.body.append(container);
    const layout = openSlot({ columns: [] }, "detail");
    const renderCurrent = () => {
      render(
        renderSidebarRegion({
          availableWidth: 1_400,
          availableSlots: ["detail"],
          callbacks: {
            activatePanel: vi.fn(),
            closeSlot: vi.fn(),
            openSlot: vi.fn(),
            reorderPanel: vi.fn(),
            resizePanel: vi.fn(),
            setDock: vi.fn(),
            setExpanded: vi.fn(),
            setOpen: vi.fn(),
          },
          layout,
          narrow: false,
          panelActions: {},
          panelTemplates: { detail: html`<aside>Review</aside>` },
          primary: html`<main data-primary>Primary chat</main>`,
          requestUpdate: renderCurrent,
        }),
        container,
      );
    };

    renderCurrent();

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector("[data-primary]")?.textContent).toContain("Primary chat");
    expect(container.querySelector(".lazy-view-error__detail")?.textContent).toContain(
      "sidebar-region.js",
    );
    const action = container.querySelector<HTMLButtonElement>(".lazy-view-error__action");
    expect(action?.textContent).toContain("Reload");
    action?.click();
    await vi.waitFor(() => expect(lazyMocks.retryDocument).toHaveBeenCalledOnce());
    expect(lazyMocks.importAttempts).toBe(1);
  });
});
