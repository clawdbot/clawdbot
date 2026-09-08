/* @vitest-environment jsdom */

import { html, render, type LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult, SessionWorkspaceListResult } from "../../api/types.ts";
import type { TaskSummary } from "../../lib/tasks/task-summary.ts";
import {
  availableSidebarSlots,
  sidebarPanelDefinitions,
  sidebarPanelTemplates,
} from "./chat-pane-embedded-panels.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import type { ChatProps } from "./chat-view.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { renderChatDetailSlot } from "./components/chat-detail-slot.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  renderSessionWorkspaceRail,
} from "./components/chat-session-workspace.ts";
import "./components/chat-sidebar-region.runtime.ts";
import type { ChatTranscriptController } from "./components/chat-transcript-controller.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  setSidebarExpanded,
  setSidebarOpen,
  type SidebarLayout,
  type SidebarSlotId,
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

async function renderPanelFixture(
  mount: HTMLElement,
  layout: SidebarLayout,
  definitions: ReturnType<typeof sidebarPanelDefinitions>,
  closePanelSlot: (slot: SidebarSlotId) => void = vi.fn(),
) {
  render(
    renderSidebarRegion({
      availableWidth: 1400,
      availableSlots: ["detail", "workspace"],
      callbacks: {
        activatePanel: vi.fn(),
        closeSlot: closePanelSlot,
        openSlot: vi.fn(),
        reorderPanel: vi.fn(),
        resizePanel: vi.fn(),
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
  await mount.querySelector<LitElement>("openclaw-chat-detail-panel")?.updateComplete;
  await mount.querySelector("openclaw-panel-loading-skeleton")?.updateComplete;
}

function createReviewFixture() {
  const file = createDeferred<SessionWorkspaceGetResult | null>();
  const list = createDeferred<SessionWorkspaceListResult | null>();
  const sessions = createSessionCapabilityFixture({
    getFile: vi.fn(() => file.promise),
    listFiles: vi.fn(() => list.promise),
  });
  const mount = document.body.appendChild(document.createElement("div"));
  const context = { ...createInitializationContext(), sessions };
  const state = createPageState(
    context,
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    mount,
  );
  state.client = createGatewayBrowserClientFixture({
    request: (method) => (method === "tasks.list" ? { tasks: [] } : { artifacts: [] }),
  });
  state.connected = true;
  state.connectionEpoch = 1;
  state.sessionKey = "agent:main:review-intent";
  state.sidebarLayout = { columns: [] };
  const task = {
    id: "review-task",
    taskId: "review-task",
    runtime: "subagent",
    status: "completed",
    title: "Inspect the completed task",
    prompt: "Review the synthetic result",
    terminalSummary: "Review completed",
    sessionKey: state.sessionKey,
    agentId: "main",
    createdAt: 1,
    updatedAt: 2,
  } satisfies TaskSummary;
  const backgroundTasks = {
    ...createBackgroundTasksProps(state, { presented: false }),
    tasks: [task],
    taskDetails: new Map([[task.id, task]]),
  };
  const preview = {
    sessionKey: state.sessionKey,
    root: "/synthetic/workspace",
    file: {
      kind: "read",
      path: "images/preview.png",
      name: "preview.png",
      missing: false,
      previewKind: "image",
      contentEncoding: "base64",
      mimeType: "image/png",
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9kAAAAASUVORK5CYII=",
    },
  } satisfies SessionWorkspaceGetResult;
  const rails = () =>
    createChatPaneRails({
      state,
      sidebarLayout: state.sidebarLayout,
      presentationId: "review-intent",
      presented: true,
      gatewaySnapshot: { ...context.gateway.snapshot, phase: "connected" },
      setObserverVisibility: vi.fn(),
      updateSidebarLayout: state.updateSidebarLayout,
    });
  const renderPanels = async () => {
    const definitions = sidebarPanelDefinitions({
      state,
      renderDetail: (content) =>
        renderChatDetailSlot({
          backgroundTasks,
          chat: { paneId: "review-intent", sessionKey: state.sessionKey } as ChatProps,
          content,
          host: state,
          layout: state.sidebarLayout,
          transcript: {} as ChatTranscriptController,
        }),
      workspace: renderSessionWorkspaceRail(createSessionWorkspaceProps(state), {
        embedded: true,
      }),
    } as Parameters<typeof sidebarPanelDefinitions>[0]);
    await renderPanelFixture(mount, state.sidebarLayout, definitions, rails().closePanelSlot);
  };
  return { file, list, mount, preview, rails, renderPanels, sessions, state, task };
}

describe("chat pane embedded panels", () => {
  it("keeps a newer task selection visible when a pending file preview completes", async () => {
    const { file, mount, preview, rails, renderPanels, state, task } = createReviewFixture();
    const taskContent = { kind: "task" as const, taskId: task.id };
    state.handleOpenSidebar(taskContent);
    await renderPanels();
    expect(mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
      task.title,
    );

    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    expect(mount.querySelector('[data-panel-skeleton="review"]')).not.toBeNull();
    rails().backgroundTasks.onOpenTaskDetail?.(task);
    await renderPanels();
    expect
      .soft(mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent)
      .toBe(task.title);
    expect.soft(mount.querySelector('[data-panel-skeleton="review"]')).toBeNull();

    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
      task.title,
    );
    expect(mount.querySelector(".chat-tool-card__preview-image")).toBeNull();
  });

  it("keeps Review closed when a pending file preview completes", async () => {
    const { file, mount, preview, renderPanels, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    const close = mount.querySelector<HTMLButtonElement>('button[aria-label="Close Review"]');
    expect(close).not.toBeNull();
    close!.click();
    await renderPanels();
    expect(mount.querySelector('[data-panel-slot="detail"]')).toBeNull();

    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(mount.querySelector('[data-panel-slot="detail"]')).toBeNull();
  });

  it("opens the requested file when an unrelated directory listing completes first", async () => {
    const { file, list, mount, preview, renderPanels, state } = createReviewFixture();
    createSessionWorkspaceProps(state).onRefresh();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    expect(mount.querySelector('[data-panel-skeleton="review"]')).not.toBeNull();

    list.resolve({
      sessionKey: state.sessionKey,
      root: "/synthetic/workspace",
      files: [{ kind: "modified", name: "other.txt", path: "other.txt", missing: false }],
      artifacts: [],
    });
    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).list?.files[0]?.name).toBe("other.txt"),
    );
    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(mount.querySelector<HTMLImageElement>(".chat-tool-card__preview-image")?.alt).toBe(
      "preview.png",
    );
  });

  it.each(["Files", "minimized"] as const)(
    "keeps the operator's %s presentation when a pending preview completes",
    async (presentation) => {
      const { file, mount, preview, renderPanels, state } = createReviewFixture();
      openSessionWorkspaceFile(state, { path: preview.file.path });
      await renderPanels();
      if (presentation === "Files") {
        state.handleOpenSidebar({
          kind: "attachment",
          attachmentKind: "image",
          title: "Attachment in Files",
          src: "/synthetic/attachment.png",
        });
      } else {
        state.updateSidebarLayout(setSidebarOpen(state.sidebarLayout, false));
      }
      const layout = state.sidebarLayout;
      await renderPanels();

      file.resolve(preview);
      await file.promise;
      await renderPanels();
      expect(state.sidebarLayout).toEqual(layout);
      expect(isSidebarSlotVisible(state.sidebarLayout, "detail")).toBe(false);
      if (presentation === "Files") {
        expect(
          mount.querySelector<HTMLImageElement>(".sidebar-attachment-preview__image")?.alt,
        ).toBe("Attachment in Files");
      }
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
      await renderPanels();
      expect(mount.querySelector<HTMLImageElement>(".chat-tool-card__preview-image")?.alt).toBe(
        "preview.png",
      );
    },
  );

  it("keeps the newer file visible after an older preview request settles", async () => {
    const { file, mount, preview, renderPanels, sessions, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    const replacement = {
      ...preview,
      file: { ...preview.file, name: "replacement.png", path: "replacement.png" },
    };
    sessions.getFile = vi.fn().mockResolvedValue(replacement);
    openSessionWorkspaceFile(state, { path: replacement.file.path });
    await vi.waitFor(async () => {
      await renderPanels();
      expect(mount.querySelector<HTMLImageElement>(".chat-tool-card__preview-image")?.alt).toBe(
        "replacement.png",
      );
    });
    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(mount.querySelector<HTMLImageElement>(".chat-tool-card__preview-image")?.alt).toBe(
      "replacement.png",
    );
  });

  it("retires a preview across reconnect without refocusing Review over Files", async () => {
    const { file, mount, preview, renderPanels, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    state.handleOpenSidebar({
      kind: "attachment",
      attachmentKind: "image",
      title: "Attachment in Files",
      src: "/synthetic/attachment.png",
    });
    await renderPanels();
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);

    state.connectionEpoch += 1;
    await renderPanels();
    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);
    expect(mount.querySelector<HTMLImageElement>(".sidebar-attachment-preview__image")?.alt).toBe(
      "Attachment in Files",
    );
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
    await renderPanels();
    expect(mount.querySelector(".chat-tool-card__preview-image")).toBeNull();
  });

  it("shows a current preview request failure without leaving Review loading", async () => {
    const { file, mount, preview, renderPanels, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    file.reject(new Error("Preview unavailable"));
    await expect(file.promise).rejects.toThrow("Preview unavailable");
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "workspace"));
    await renderPanels();
    expect(mount.textContent).toContain("Preview unavailable");
    expect(mount.querySelector('[data-panel-skeleton="review"]')).toBeNull();
  });

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
      sidebarLayout: { columns: [] },
    } as unknown as ChatPageHost;
    const mount = document.body.appendChild(document.createElement("div"));
    const renderPanels = async (layout: SidebarLayout) => {
      state.sidebarLayout = layout;
      const definitions = sidebarPanelDefinitions({
        state,
        renderDetail: (content) =>
          html`<openclaw-chat-detail-panel
            .content=${content}
            embedded
          ></openclaw-chat-detail-panel>`,
        workspace: html`<div>Files</div>`,
      } as Parameters<typeof sidebarPanelDefinitions>[0]);
      await renderPanelFixture(mount, layout, definitions);
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
      dashboard: "board",
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
      expect(skeleton?.getAttribute("data-panel-skeleton")).toBe(
        expected[definition.slot as keyof typeof expected],
      );
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
