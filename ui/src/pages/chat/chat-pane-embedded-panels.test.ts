/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableSidebarSlots,
  sidebarPanelActions,
  sidebarPanelDefinitions,
} from "./chat-pane-embedded-panels.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";

type PanelTestOptions = {
  dashboard?: ReturnType<typeof html>;
  canvasCommentAvailable?: boolean;
  canvasCommentMode?: boolean;
  canvasAnnotationCount?: number;
  onToggleCanvasComment?: () => void;
  onExitCanvasComment?: () => void;
  onDiscardCanvasComments?: () => void;
  onSendCanvasComments?: () => void;
};

function panelDefinitions(discussionAvailable: boolean, options: PanelTestOptions = {}) {
  const discussion = {} as SessionDiscussionPanelConfig;
  return sidebarPanelDefinitions({
    discussion,
    discussionAvailable,
    ...options,
  } as Parameters<typeof sidebarPanelDefinitions>[0]);
}

function discussionSlots(discussionAvailable: boolean) {
  return availableSidebarSlots(panelDefinitions(discussionAvailable));
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

  it("renders the staged Canvas annotation controls in the Dashboard panel header", () => {
    const onToggleCanvasComment = vi.fn();
    const onExitCanvasComment = vi.fn();
    const onDiscardCanvasComments = vi.fn();
    const onSendCanvasComments = vi.fn();
    const definitions = panelDefinitions(false, {
      dashboard: html`<div>dashboard</div>`,
      canvasCommentAvailable: true,
      canvasCommentMode: true,
      canvasAnnotationCount: 2,
      onToggleCanvasComment,
      onExitCanvasComment,
      onDiscardCanvasComments,
      onSendCanvasComments,
    });
    const actions = sidebarPanelActions(definitions);
    const action = actions.dashboard;
    const container = document.createElement("div");

    render(action, container);
    const button = container.querySelector<HTMLButtonElement>("button[data-canvas-comment-toggle]");

    expect(button?.getAttribute("aria-pressed")).toBe("true");
    button?.click();
    expect(onToggleCanvasComment).toHaveBeenCalledOnce();
    container.querySelector<HTMLButtonElement>("button[data-canvas-comment-exit]")?.click();
    container.querySelector<HTMLButtonElement>("button[data-canvas-comment-discard]")?.click();
    container.querySelector<HTMLButtonElement>("button[data-canvas-comment-send]")?.click();
    expect(onExitCanvasComment).toHaveBeenCalledOnce();
    expect(onDiscardCanvasComments).toHaveBeenCalledOnce();
    expect(onSendCanvasComments).toHaveBeenCalledOnce();

    for (const [slot, panelAction] of Object.entries(actions)) {
      if (slot === "dashboard") {
        continue;
      }
      const otherPanel = document.createElement("div");
      render(panelAction, otherPanel);
      expect(otherPanel.querySelector("[data-canvas-comment-toggle]"), slot).toBeNull();
    }
  });

  it("enumerates a structural loading variant for every side-panel tab", async () => {
    const expected = {
      browser: "browser",
      companion: "chat",
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
