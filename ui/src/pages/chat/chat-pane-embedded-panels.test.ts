/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableSidebarSlots,
  sidebarPanelDefinitions,
  sidebarPanelTemplates,
} from "./chat-pane-embedded-panels.ts";
import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import "./components/chat-sidebar-region.runtime.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  setSidebarExpanded,
  setSidebarOpen,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function discussionSlots(discussionAvailable: boolean) {
  const discussion = {} as SessionDiscussionPanelConfig;
  const definitions = sidebarPanelDefinitions({
    discussion,
    discussionAvailable,
  } as Parameters<typeof sidebarPanelDefinitions>[0]);
  return availableSidebarSlots(definitions);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("chat pane embedded panels", () => {
  it("does not offer Discussion when no provider is available", () => {
    expect(discussionSlots(false)).not.toContain("discussion");
  });

  it("offers Discussion after the provider reports it available", () => {
    expect(discussionSlots(true)).toContain("discussion");
  });

  it("retains default Review content and collapsed files while switching tabs, focusing Chat, and minimizing", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:review",
      branch: "feature/review",
      baseRef: "main",
      additions: 1,
      deletions: 1,
      files: [{ path: "example.txt", status: "modified", additions: 1, deletions: 1 }],
    });
    const state = {
      client: { request },
      connected: true,
      connectionEpoch: 1,
      hello: { features: { methods: ["sessions.diff"] } },
      sessionKey: "agent:main:review",
      sidebarContent: null,
    } as unknown as ChatPageHost;
    const mount = document.body.appendChild(document.createElement("div"));
    const renderPanels = async (layout: SidebarLayout) => {
      const definitions = sidebarPanelDefinitions({
        state,
        renderDetail: (content) =>
          html`<openclaw-chat-detail-panel
            .content=${content}
            embedded
          ></openclaw-chat-detail-panel>`,
        workspace: html`<div>Files</div>`,
      } as Parameters<typeof sidebarPanelDefinitions>[0]);
      render(
        renderSidebarRegion({
          availableWidth: 1400,
          availableSlots: ["detail", "workspace"],
          callbacks: {
            activatePanel: vi.fn(),
            appendComposerText: vi.fn(),
            closeSlot: vi.fn(),
            openSlot: vi.fn(),
            reorderPanel: vi.fn(),
            resizePanel: vi.fn(),
            setExpanded: vi.fn(),
            setOpen: vi.fn(),
          },
          layout,
          narrow: false,
          panelDefinitions: definitions,
          panelActions: {},
          panelTemplates: sidebarPanelTemplates(definitions),
          primary: html`<main>Chat</main>`,
          requestUpdate: vi.fn(),
        }),
        mount,
      );
      await mount.querySelector("openclaw-chat-sidebar-region")?.updateComplete;
    };
    const review = openSlot({ columns: [] }, "detail");
    await renderPanels(setSidebarOpen(review, false));
    expect(mount.querySelector("openclaw-session-diff")).toBeNull();
    expect(request).not.toHaveBeenCalled();

    await renderPanels(review);
    await vi.waitFor(() =>
      expect(mount.querySelector(".session-diff__file-toggle")).not.toBeNull(),
    );
    const diff = mount.querySelector("openclaw-session-diff");
    const toggle = mount.querySelector<HTMLButtonElement>(".session-diff__file-toggle")!;
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));

    const focused = setSidebarExpanded(ensureSidebarConversation(review), true);
    for (const layout of [
      openSlot(review, "workspace"),
      review,
      focused,
      setSidebarExpanded(focused, false),
      setSidebarOpen(review, false),
      review,
    ]) {
      await renderPanels(layout);
      expect(mount.querySelector("openclaw-session-diff")).toBe(diff);
      expect(diff?.closest("[data-panel-slot]")?.hasAttribute("hidden")).toBe(
        !isSidebarSlotVisible(layout, "detail"),
      );
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
    await renderPanels(closeSlot(review, "detail"));
    expect(mount.querySelector("openclaw-session-diff")).toBeNull();
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.diff", {
      sessionKey: state.sessionKey,
      agentId: "main",
      scope: "all",
    });
    expect(state.sidebarContent).toBeNull();
  });

  it("enumerates a structural loading variant for every side-panel tab", async () => {
    const expected = {
      browser: "browser",
      companion: "chat",
      conversation: "chat",
      dashboard: "review",
      desktop: "desktop",
      detail: "review",
      discussion: "discussion",
      tasks: "tasks",
      terminal: "terminal",
      workspace: "files",
    } as const;

    const definitions = sidebarPanelDefinitions();
    expect(definitions.map((definition) => definition.slot)).toEqual([
      "conversation",
      "detail",
      "terminal",
      "browser",
      "workspace",
      "companion",
      "tasks",
      "desktop",
      "discussion",
      "dashboard",
    ]);
    for (const definition of definitions) {
      const mount = document.body.appendChild(document.createElement("div"));
      render(definition.loading, mount);
      const skeleton = mount.querySelector("openclaw-panel-loading-skeleton");
      await skeleton?.updateComplete;
      expect(skeleton?.getAttribute("data-panel-skeleton")).toBe(expected[definition.slot]);
    }
  });

  it("exposes task refresh in the shared side-panel header", () => {
    const onRefreshTasks = vi.fn();
    const params = {} as NonNullable<Parameters<typeof sidebarPanelDefinitions>[0]>;
    params.connected = true;
    params.onRefreshTasks = onRefreshTasks;
    params.tasksLoading = false;
    const tasks = sidebarPanelDefinitions(params).find((definition) => definition.slot === "tasks");
    const mount = document.body.appendChild(document.createElement("div"));
    render(tasks?.headerAction, mount);

    const refresh = mount.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh background tasks"]',
    );
    expect(refresh).not.toBeNull();
    expect(refresh?.querySelector("svg")?.outerHTML).toContain("M21 12a9");
    refresh?.click();
    expect(onRefreshTasks).toHaveBeenCalledOnce();

    for (const [connected, tasksLoading] of [
      [false, false],
      [true, true],
    ] as const) {
      params.connected = connected;
      params.tasksLoading = tasksLoading;
      const definition = sidebarPanelDefinitions(params).find(
        (candidate) => candidate.slot === "tasks",
      );
      render(definition?.headerAction, mount);
      expect(
        mount.querySelector<HTMLButtonElement>('button[aria-label="Refresh background tasks"]')
          ?.disabled,
      ).toBe(true);
      if (tasksLoading) {
        expect(
          mount.querySelector(
            'button[aria-label="Refresh background tasks"] .btn__spinner[aria-hidden="true"]',
          ),
        ).not.toBeNull();
      }
    }
  });
});
