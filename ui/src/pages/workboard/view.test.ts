// Control UI tests cover workboard behavior.
import { nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getWorkboardState, stopWorkboardLifecycleRefresh } from "../../lib/workboard/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { renderWorkboard } from "./view.ts";

type WorkboardRenderProps = Parameters<typeof renderWorkboard>[0];

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function renderInto(container: HTMLElement, props: WorkboardRenderProps) {
  render(renderWorkboard(props), container);
}

function buttonByLabel(container: Element, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === label,
    ) ?? null
  );
}

function buttonByText(container: Element, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function dispatchKey(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function changeWorkboardSelect(select: Element | null | undefined, value: string) {
  const control = select as (HTMLElement & { value: string }) | null | undefined;
  expect(control).not.toBeNull();
  if (!control) {
    return;
  }
  Object.defineProperty(control, "value", { configurable: true, value, writable: true });
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("renderWorkboard", () => {
  it("hides the manual refresh button while auto-refresh is enabled", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.loading = true;
    state.autoRefreshIntervalMs = 5000;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(buttonByText(container, "Refresh")).toBeNull();
    expect(container.querySelector(".workboard-toolbar__actions")?.textContent).not.toContain(
      "Refreshing",
    );
  });

  it("renders lifecycle refresh errors without replacing generic errors", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.lifecycleTaskRefreshError = "Task refresh unavailable";
    const container = document.createElement("div");
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
    };

    renderInto(container, props);
    expect(container.querySelector(".callout.danger")?.textContent).toBe(
      "Task refresh unavailable",
    );

    state.error = "Write denied";
    renderInto(container, props);
    expect(container.querySelector(".callout.danger")?.textContent).toBe("Write denied");
  });

  it("keeps dispatch available during refresh and disables it during writes", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.loading = true;
    state.autoRefreshIntervalMs = 5000;
    const container = document.createElement("div");
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
    };

    render(renderWorkboard(props), container);

    const dispatchButton = buttonByText(container, "Dispatch ready work");
    expect(dispatchButton?.disabled).toBe(false);

    state.draftSaving = true;
    render(renderWorkboard(props), container);

    expect(buttonByText(container, "Dispatch ready work")?.disabled).toBe(true);

    state.loading = false;
    state.autoRefreshIntervalMs = 0;
    render(renderWorkboard(props), container);

    expect(buttonByText(container, "Refresh")?.disabled).toBe(true);

    state.draftSaving = false;
    state.dispatching = true;
    render(renderWorkboard(props), container);

    expect(buttonByText(container, "Dispatch ready work")?.disabled).toBe(true);

    render(renderWorkboard(props), container);

    expect(buttonByText(container, "Refresh")?.disabled).toBe(true);
  });

  it("disables card-write controls while dispatch is running", () => {
    const host = {};
    const state = getWorkboardState(host);
    const sessionKey = "agent:main:workboard-dispatch";
    const request = vi.fn(async () => ({ card: state.cards[0] }));
    state.loaded = true;
    state.dispatching = true;
    state.detailCardId = "card-1";
    state.cards = [
      {
        id: "card-1",
        title: "Dispatch-safe card",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey,
      },
    ];
    const container = document.createElement("div");
    const props: WorkboardRenderProps = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [
        { key: sessionKey, kind: "direct", status: "running", hasActiveRun: true, updatedAt: 2 },
      ],
      onOpenSession: () => undefined,
    };

    render(renderWorkboard(props), container);

    expect(buttonByText(container, "New card")?.disabled).toBe(true);
    expect(buttonByLabel(container, "Edit card")?.disabled).toBe(true);
    expect(buttonByLabel(container, "Archive card")?.disabled).toBe(true);
    expect(buttonByLabel(container, "Delete card")?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLSelectElement>(".workboard-card__move-select")?.disabled,
    ).toBe(true);
    const detailActions = container.querySelector<HTMLElement>(".workboard-detail__actions");
    expect(detailActions).not.toBeNull();
    expect(buttonByLabel(detailActions!, "Edit card")?.disabled).toBe(true);
    expect(buttonByLabel(detailActions!, "Archive card")?.disabled).toBe(true);
    expect(buttonByLabel(detailActions!, "Stop session")?.disabled).toBe(true);
    expect(buttonByLabel(detailActions!, "Delete card")?.disabled).toBe(true);
    expect(
      detailActions!.querySelector<HTMLSelectElement>(".workboard-card__move-select")?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLElement>(".workboard-card")?.getAttribute("draggable")).toBe(
      "false",
    );
    expect(request).not.toHaveBeenCalled();

    state.draftOpen = true;
    state.editingCardId = "card-1";
    state.draftTitle = "Dispatch-safe card";
    render(renderWorkboard(props), container);

    expect(
      container.querySelector<HTMLButtonElement>(".workboard-draft .btn.primary")?.disabled,
    ).toBe(true);
  });

  it("renders stable card action slots and top updated timestamps", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "ready",
        title: "Ready card",
        status: "ready",
        priority: "normal",
        labels: [],
        agentId: "workboard-dispatcher",
        position: 1000,
        createdAt: 1,
        updatedAt: new Date("2026-06-03T18:47:00Z").getTime(),
      },
      {
        id: "running",
        title: "Running card",
        status: "running",
        priority: "high",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: new Date("2026-06-03T19:12:00Z").getTime(),
        sessionKey: "agent:main:dashboard:1",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            updatedAt: Date.now(),
            status: "running",
            hasActiveRun: true,
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const cards = [...container.querySelectorAll(".workboard-card")];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.querySelector(".workboard-card__updated")?.textContent).toMatch(/\d+:\d\d/);
      expect(card.querySelector(".workboard-card__updated")?.textContent).not.toContain("Updated:");
      expect(card.querySelector(".workboard-card__updated")?.getAttribute("aria-label")).toContain(
        "Updated:",
      );
      expect(card.querySelector(".workboard-card__updated-icon svg")).toBeTruthy();
      expect(card.querySelector(".workboard-card__top > .workboard-card__updated")).toBeTruthy();
      expect(
        card.querySelector(".workboard-card__chips")?.previousElementSibling?.className,
      ).toContain("workboard-card__top");
      expect(
        card.querySelectorAll(".workboard-card__quick-actions .workboard-card__action-slot"),
      ).toHaveLength(3);
      expect(
        card.querySelectorAll(".workboard-card__actions-primary .workboard-card__action-slot"),
      ).toHaveLength(3);
      expect(
        card.querySelectorAll(".workboard-card__actions > .workboard-card__action-slot"),
      ).toHaveLength(2);
    }
    expect(container.querySelector(".workboard-agent-chip")?.textContent).toContain(
      "workboard-dispatcher",
    );
    const runningCard = cards.find((card) => card.textContent?.includes("Running card"));
    expect(runningCard?.querySelector('button[aria-label="Open session"]')).not.toBeNull();
    expect(runningCard?.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
  });

  it("renders date and time in detail drawer timestamps", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.detailCardId = "card-1";
    state.cards = [
      {
        id: "card-1",
        title: "Timestamped card",
        status: "running",
        priority: "high",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: new Date("2026-06-03T18:47:00Z").getTime(),
        metadata: {
          workerProtocol: {
            state: "running",
            updatedAt: new Date("2026-06-03T19:12:00Z").getTime(),
          },
        },
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const detailText = container.querySelector(".workboard-detail")?.textContent ?? "";
    expect(detailText).toContain("Updated");
    expect(detailText).toMatch(/\d+:\d\d/);
  });

  it("keeps the last updated timestamp stable next to density controls while refreshing", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.loading = true;
    state.lastRefreshAt = new Date("2026-06-03T18:47:00Z").getTime();
    state.lastRefreshStartedAt = Date.now();
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const layoutControls = container.querySelector(".workboard-layout-controls");
    expect(layoutControls?.querySelector(".workboard-layout-toggle")).toBeTruthy();
    expect(layoutControls?.querySelector(".workboard-refresh-status")?.textContent).toContain(
      "Updated",
    );
    expect(layoutControls?.textContent).not.toContain("Refreshing");
  });

  it("renders board columns and preloaded cards", () => {
    const now = Date.now();
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Wire dashboard tab",
        notes: "Call plugin gateway methods from the Workboard page.",
        status: "todo",
        priority: "high",
        labels: ["ui"],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:dashboard:1",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Dashboard session",
            updatedAt: now,
            hasActiveRun: true,
            status: "running",
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Todo");
    expect(container.textContent).toContain("Wire dashboard tab");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Dashboard session");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);
    expect(container.querySelector(".workboard-card__priority")?.textContent).toContain("High");
    expect(container.querySelector(".workboard-health")?.textContent).toContain("running");
  });

  it("hides cached card mutation controls until a lifecycle teardown reload succeeds", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Stale cached card",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    stopWorkboardLifecycleRefresh(host);
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
    };
    const container = document.createElement("div");

    render(renderWorkboard(props), container);

    expect(buttonByLabel(container, "Edit card")).toBeNull();
    expect(buttonByLabel(container, "Archive card")).toBeNull();
    expect(buttonByText(container, "New card")).toBeNull();
    expect(container.querySelector(".workboard-card")?.getAttribute("draggable")).toBe("false");

    state.mutationReadiness = "ready";
    render(renderWorkboard(props), container);

    expect(buttonByLabel(container, "Edit card")).not.toBeNull();
    expect(buttonByText(container, "New card")).not.toBeNull();
  });

  it("keeps a stale edit draft disabled until it is cancelled", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Canonical title",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    state.draftOpen = true;
    state.editingCardId = "card-1";
    state.draftTitle = "Unsaved edit";
    stopWorkboardLifecycleRefresh(host);
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
    };
    const container = document.createElement("div");

    render(renderWorkboard(props), container);
    state.mutationReadiness = "stale_edit_draft";
    render(renderWorkboard(props), container);

    expect(
      container.querySelector<HTMLButtonElement>(".workboard-modal__actions .primary")?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Unsaved edit",
    );

    const cancelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
    expect(cancelButton?.disabled).toBe(false);
    cancelButton?.click();

    expect(state.draftOpen).toBe(false);
  });

  it("renders health counts and dense card metadata", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Blocked worker",
        status: "blocked",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          attempts: [{ id: "attempt-1", status: "failed", startedAt: 1 }],
          claim: { ownerId: "agent-1", claimedAt: 1, lastHeartbeatAt: Date.now() },
          diagnostics: [
            {
              kind: "protocol_violation",
              severity: "warning",
              title: "Old diagnostic",
              detail: "Older detail.",
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
            },
            {
              kind: "repeated_failures",
              severity: "error",
              title: "Repeated run failures",
              detail: "Multiple attempts failed.",
              firstSeenAt: 1,
              lastSeenAt: 2,
              count: 1,
            },
          ],
          notifications: [{ id: "note-1", kind: "failed", createdAt: 1, message: "Needs proof." }],
        },
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-health")?.textContent).toContain("1blocked");
    expect(container.textContent).toContain("1 attempts");
    expect(container.textContent).toContain("heartbeat");
    expect(container.textContent).toContain("Repeated run failures");
    expect(container.textContent).not.toContain("Old diagnostic");
    expect(container.textContent).toContain("Needs proof.");
  });

  it("keeps bounded diagnostic badges UTF-16 safe", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-boundary",
        title: "Boundary badge",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          diagnostics: [
            {
              kind: "protocol_violation",
              severity: "warning",
              title: `${"x".repeat(62)}🚀tail`,
              detail: "Boundary detail.",
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
            },
          ],
        },
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-card__badge--warning")?.textContent?.trim()).toBe(
      `${"x".repeat(62)}…`,
    );
  });

  it("renders sub-minute heartbeat ages with the duration count interpolation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00Z"));
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Active worker",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          claim: {
            ownerId: "agent-1",
            claimedAt: 1,
            lastHeartbeatAt: Date.now() - 42_000,
          },
        },
      },
    ];
    const container = document.createElement("div");

    try {
      renderInto(container, {
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      });

      expect(container.textContent).toContain("heartbeat 42s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("highlights cards matching a clicked health badge", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Blocked worker",
        status: "blocked",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "card-2",
        title: "Running worker",
        status: "running",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");
    const renderBoard = () =>
      render(
        renderWorkboard({
          host,
          client: null,
          connected: true,
          pluginEnabled: true,
          agentsList: null,
          sessions: [],
          onOpenSession: () => undefined,
        }),
        container,
      );

    renderBoard();

    container
      .querySelector<HTMLButtonElement>(".workboard-health__item--blocked")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderBoard();

    const cards = [...container.querySelectorAll<HTMLElement>(".workboard-card")];
    expect(state.activeHealthHighlight).toBe("blocked");
    expect(cards.find((card) => card.textContent?.includes("Blocked worker"))?.className).toContain(
      "workboard-card--health-highlight",
    );
    expect(cards.find((card) => card.textContent?.includes("Blocked worker"))?.className).toContain(
      "workboard-card--health-highlight-blocked",
    );
    expect(
      cards.find((card) => card.textContent?.includes("Running worker"))?.className,
    ).not.toContain("workboard-card--health-highlight");
    expect(
      container
        .querySelector<HTMLButtonElement>(".workboard-health__item--blocked")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    container
      .querySelector<HTMLButtonElement>(".workboard-health__item--blocked")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderBoard();

    expect(state.activeHealthHighlight).toBeNull();
    expect(container.querySelector(".workboard-card--health-highlight")).toBeNull();
  });

  it("filters cards with the view preset selector", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.viewPreset = "ready";
    state.cards = [
      {
        id: "ready",
        title: "Ready card",
        status: "ready",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "blocked",
        title: "Blocked card",
        status: "blocked",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Ready card");
    expect(container.textContent).not.toContain("Blocked card");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(1);
    expect(container.querySelector(".workboard-board")?.className).toContain(
      "workboard-board--single-column",
    );
    expect(container.querySelector(".workboard-column h2")?.textContent).toContain("Ready");
    expect(
      [...container.querySelectorAll(".workboard-column h2")].map((heading) => heading.textContent),
    ).not.toContain("Blocked");
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-health__item--blocked")?.textContent,
    ).toContain("0blocked");
  });

  it("shows an empty state and disables zero-result view presets", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.viewPreset = "running";
    state.cards = [
      {
        id: "card-ready",
        title: "Ready card",
        status: "ready",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-column")).toBeNull();
    expect(container.querySelector(".workboard-board")).toBeNull();
    expect(container.querySelector(".workboard-empty-state")?.textContent).toContain(
      "No cards match this view",
    );
    const viewSelect = container.querySelector(".workboard-toolbar__filters .workboard-select");
    const runningOption = [
      ...(viewSelect?.querySelectorAll<HTMLElement & { disabled: boolean }>("wa-option") ?? []),
    ].find((option) => option.textContent?.includes("Running"));
    expect(runningOption?.disabled).toBe(true);
    expect(runningOption?.textContent).toContain("0 cards");
  });

  it("shows the empty state when non-view filters match no cards", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.viewPreset = "all";
    state.priorityFilter = "urgent";
    state.cards = [
      {
        id: "card-ready",
        title: "Ready card",
        status: "ready",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-column")).toBeNull();
    expect(container.querySelector(".workboard-empty-state")?.textContent).toContain(
      "No cards match this view",
    );
  });

  it("uses the same Web Awesome select control for Workboard toolbar filters", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: {
          defaultId: "main",
          mainKey: "agent:main:main",
          scope: "test",
          agents: [{ id: "main", name: "Main" }],
        },
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const toolbarFilters = container.querySelector(".workboard-toolbar__filters");
    expect(toolbarFilters?.querySelectorAll(".workboard-select--toolbar")).toHaveLength(3);
    expect(toolbarFilters?.querySelectorAll("select")).toHaveLength(0);
    expect(toolbarFilters?.textContent).toContain("All cards");
    expect(toolbarFilters?.textContent).toContain("All priorities");
    expect(toolbarFilters?.textContent).toContain("All agents");
    const priorityFilter = toolbarFilters?.querySelectorAll(".workboard-select--toolbar").item(1);
    expect(priorityFilter?.textContent).toContain("Low");
    expect(priorityFilter?.textContent).toContain("Normal");
    expect(priorityFilter?.textContent).toContain("High");
    expect(priorityFilter?.textContent).toContain("Urgent");
  });

  it("filters cards to the global agent scope and hides the secondary agent filter", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.viewPreset = "all";
    state.cards = [
      {
        id: "writer-card",
        title: "Writer card",
        status: "ready",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        agentId: "writer",
      },
      {
        id: "ops-card",
        title: "Ops card",
        status: "ready",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        agentId: "ops",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: {
          defaultId: "main",
          mainKey: "agent:main:main",
          scope: "test",
          agents: [{ id: "main" }, { id: "writer" }, { id: "ops" }],
        },
        sessions: [],
        scopeAgentId: "writer",
        showAgentFilter: false,
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Writer card");
    expect(container.textContent).not.toContain("Ops card");
    expect(container.querySelectorAll(".workboard-select--toolbar")).toHaveLength(2);
  });

  it("uses labelled Web Awesome selects for Workboard filters", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const selects = [
      ...container.querySelectorAll<HTMLElement & { value: string }>(
        ".workboard-toolbar__filters > wa-select",
      ),
    ];
    expect(selects).toHaveLength(3);
    expect(selects.map((select) => select.getAttribute("label"))).toEqual([
      "Workboard view",
      "All priorities",
      "Filter by agent",
    ]);
    expect(selects.map((select) => select.getAttribute("value"))).toEqual(["all", "all", "all"]);
    expect(container.querySelector(".workboard-select__trigger")).toBeNull();
  });

  it("can hide empty columns while keeping populated columns visible", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Keep visible",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    } satisfies WorkboardRenderProps;

    render(renderWorkboard(props), container);
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);

    const toggle = container.querySelector<HTMLInputElement>(
      'input[name="workboard-hide-empty-columns"]',
    );
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change", { bubbles: true }));
    render(renderWorkboard(props), container);

    const columnHeadings = Array.from(
      container.querySelectorAll<HTMLElement>(".workboard-column__header h2"),
    ).map((heading) => heading.textContent?.trim());
    expect(state.hideEmptyColumns).toBe(true);
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(1);
    expect(columnHeadings).toEqual(["Todo"]);
    expect(container.textContent).toContain("Todo");
    expect(container.textContent).toContain("Keep visible");
  });

  it("does not render Invalid Date for Date-invalid card timestamps", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Bad timestamp card",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 8_640_000_000_000_001,
        events: [{ id: "event-1", kind: "edited", at: 8_640_000_000_000_001 }],
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Bad timestamp card");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it("opens card details from the card surface without hijacking action buttons", () => {
    const host = {};
    const state = getWorkboardState(host);
    const onOpenSession = vi.fn();
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Inspect a running task",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:dashboard:1",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Dashboard session",
            updatedAt: 2,
            hasActiveRun: true,
            status: "running",
          },
        ],
        onOpenSession,
      }),
      container,
    );

    const card = container.querySelector<HTMLElement>(".workboard-card");
    card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Dashboard session",
            updatedAt: 2,
            hasActiveRun: true,
            status: "running",
          },
        ],
        onOpenSession,
      }),
      container,
    );
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Inspect a running task",
    );
    expect(onOpenSession).not.toHaveBeenCalled();

    onOpenSession.mockClear();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Delete card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("mirrors compact card actions in the detail drawer", () => {
    const host = {};
    const state = getWorkboardState(host);
    const sessionKey = "agent:main:detail-parity";
    state.loaded = true;
    state.detailCardId = "card-1";
    state.cards = [
      {
        id: "card-1",
        title: "Detail parity",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey,
      },
    ];
    const container = document.createElement("div");
    const onOpenSession = vi.fn();

    render(
      renderWorkboard({
        host,
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            displayName: "Detail parity session",
            updatedAt: 2,
            hasActiveRun: true,
            status: "running",
          },
        ],
        onOpenSession,
      }),
      container,
    );

    const actions = container.querySelector<HTMLElement>(".workboard-detail__actions");
    expect(actions).not.toBeNull();
    expect(buttonByLabel(actions!, "Edit card")).not.toBeNull();
    expect(buttonByLabel(actions!, "Archive card")).not.toBeNull();
    expect(buttonByLabel(actions!, "Stop session")).not.toBeNull();
    expect(buttonByLabel(actions!, "Open session")).not.toBeNull();
    expect(buttonByLabel(actions!, "Delete card")).not.toBeNull();

    const moveSelect = actions!.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    expect(moveSelect?.getAttribute("aria-label")).toBe("Status: Detail parity");
    expect([...moveSelect!.options].map((option) => option.textContent?.trim())).toContain(
      "Review",
    );

    buttonByLabel(actions!, "Edit card")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(state.draftOpen).toBe(true);
    expect(state.editingCardId).toBe("card-1");
  });

  it("keeps focus inside the card modal and restores focus on Escape", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [];
    const container = document.createElement("div");
    document.body.append(container);
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => renderInto(container, props),
    };

    try {
      renderInto(container, props);
      const launcher = container.querySelector<HTMLButtonElement>(
        ".workboard-toolbar__actions .primary",
      );
      expect(launcher).toBeInstanceOf(HTMLButtonElement);
      launcher?.focus();
      launcher?.click();
      await nextFrame();

      const modal = container.querySelector("openclaw-modal-dialog");
      const { dialog } = await getRenderedModalDialog(container);
      const titleInput = container.querySelector<HTMLInputElement>(".workboard-draft__title");
      expect(modal?.getAttribute("label")).toBe("New card");
      expect(dialog.open).toBe(true);
      expect(container.querySelector("#workboard-card-modal-title")?.textContent).toContain(
        "New card",
      );
      expect(container.querySelector("#workboard-card-modal-description")?.textContent).toContain(
        "Queue work",
      );
      expect(document.activeElement).toBe(titleInput);

      dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
      await nextFrame();
      expect(container.querySelector(".workboard-draft")).toBeNull();
      expect(document.activeElement).toBe(launcher);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it("lets Escape close the card modal from a closed Web Awesome select", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    const container = document.createElement("div");
    document.body.append(container);
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => renderInto(container, props),
    };

    try {
      renderInto(container, props);
      container.querySelector<HTMLButtonElement>(".workboard-toolbar__actions .primary")?.click();
      await nextFrame();

      const select = container.querySelector<HTMLElement & { open: boolean }>(
        ".workboard-draft .workboard-select",
      );
      expect(select?.open).toBe(false);

      select?.focus();
      dispatchKey(select!, "Escape");
      await nextFrame();

      expect(container.querySelector(".workboard-draft")).toBeNull();
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it("treats the detail drawer as a labelled keyboard-modal dialog", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Inspect drawer focus",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => renderInto(container, props),
    };

    try {
      renderInto(container, props);
      const launcher = container.querySelector<HTMLButtonElement>(
        "button[aria-label='View details']",
      );
      expect(launcher).toBeInstanceOf(HTMLButtonElement);
      launcher?.focus();
      launcher?.click();
      await nextFrame();

      const modal = container.querySelector("openclaw-modal-dialog");
      const { dialog } = await getRenderedModalDialog(container);
      expect(modal?.getAttribute("label")).toBe("Inspect drawer focus");
      expect(dialog.open).toBe(true);
      expect(container.querySelector("#workboard-card-detail-title")?.textContent).toContain(
        "Card details: Inspect drawer focus",
      );
      expect(container.querySelector("#workboard-card-detail-description")?.textContent).toContain(
        "Start or link a session",
      );
      dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
      await nextFrame();
      expect(container.querySelector(".workboard-detail-drawer")).toBeNull();
      expect(document.activeElement).toBe(launcher);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it("does not restore focus to a disconnected modal opener", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [];
    const container = document.createElement("div");
    document.body.append(container);
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => renderInto(container, props),
    };

    try {
      renderInto(container, props);
      const launcher = container.querySelector<HTMLButtonElement>(
        ".workboard-toolbar__actions .primary",
      );
      launcher?.focus();
      launcher?.click();
      await nextFrame();

      const titleInput = container.querySelector<HTMLInputElement>(".workboard-draft__title");
      expect(document.activeElement).toBe(titleInput);

      launcher?.remove();
      dispatchKey(titleInput!, "Escape");
      await nextFrame();

      expect(container.querySelector(".workboard-draft")).toBeNull();
      expect(document.activeElement).not.toBe(launcher);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it("restores focus when the detail drawer is removed by state", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Remove drawer externally",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => renderInto(container, props),
    };

    try {
      renderInto(container, props);
      const launcher = container.querySelector<HTMLButtonElement>(
        "button[aria-label='View details']",
      );
      launcher?.focus();
      launcher?.click();
      await nextFrame();

      state.detailCardId = null;
      renderInto(container, props);
      await nextFrame();

      expect(container.querySelector(".workboard-detail-drawer")).toBeNull();
      expect(document.activeElement).toBe(launcher);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it("keeps cards compact and puts model-specific execution actions in details", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Start this later",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const startButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-card__start"),
    ];
    expect(startButtons.map((button) => button.textContent?.trim())).toEqual([""]);
    expect(startButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Run default agent",
    ]);
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const detailStartButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-detail .workboard-card__start"),
    ];
    expect(detailStartButtons.map((button) => button.textContent?.replace(/\s+/g, ""))).toEqual([
      "Start",
      "OpenAIRun",
      "ClaudeRun",
      "OpenAIOpen",
      "ClaudeOpen",
    ]);
  });

  it("shows unfinished parent dependencies without blocking stale local starts", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "parent-1",
        title: "Finish art pass",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "child-1",
        title: "Ship game shell",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          links: [{ id: "link-1", type: "parent", targetCardId: "parent-1", createdAt: 1 }],
        },
      },
    ];
    const container = document.createElement("div");
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    } satisfies WorkboardRenderProps;

    render(renderWorkboard(props), container);

    const childCard = [...container.querySelectorAll<HTMLElement>(".workboard-card")].find((card) =>
      card.textContent?.includes("Ship game shell"),
    );
    const start = childCard?.querySelector<HTMLButtonElement>(".workboard-card__start");
    expect(childCard?.textContent).toContain("1 blocked");
    expect(start?.disabled).toBe(false);
    expect(start?.getAttribute("aria-label")).toBe("Run default agent");

    childCard
      ?.querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    const detail = container.querySelector(".workboard-detail");
    expect(detail?.textContent).toContain("Dependencies");
    expect(detail?.textContent).toContain("Finish art pass");
    expect(detail?.textContent).toContain("Todo");
    const detailRunButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start--autonomous",
      ),
    ];
    const detailOpenButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start--manual",
      ),
    ];
    expect(detailRunButtons.length).toBeGreaterThan(0);
    expect(detailRunButtons.every((button) => button.disabled)).toBe(false);
    expect(detailOpenButtons.length).toBeGreaterThan(0);
    expect(detailOpenButtons.every((button) => button.disabled)).toBe(false);
  });

  it("hides autonomous model override actions for non-admin operators", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Start with default model",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        canModelOverride: false,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const startButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-card__start"),
    ];
    expect(startButtons.map((button) => button.textContent?.trim())).toEqual([""]);
    expect(startButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Run default agent",
    ]);

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        canModelOverride: false,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );
    const detailStartButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-detail .workboard-card__start"),
    ];
    expect(detailStartButtons.map((button) => button.textContent?.replace(/\s+/g, ""))).toEqual([
      "Start",
      "OpenAIOpen",
      "ClaudeOpen",
    ]);
  });

  it("renders linked Gateway task status on cards", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Review task result",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
        taskId: "task-1",
      },
    ];
    state.tasksByCardId.set("card-1", {
      id: "task-1",
      taskId: "task-1",
      status: "completed",
      title: "Review task result",
      childSessionKey: "agent:main:subagent:workboard-default-card-1",
      runId: "run-1",
      terminalSummary: "Ready for operator review.",
    });
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("task linked");
    expect(container.textContent).toContain("Task complete");
    expect(container.textContent).toContain("Ready for operator review.");
  });

  it("uses terminal session lifecycle when cached task status is stale", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Finished despite stale task",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
        taskId: "task-1",
      },
    ];
    state.tasksByCardId.set("card-1", {
      id: "task-1",
      taskId: "task-1",
      status: "running",
      title: "Finished despite stale task",
      childSessionKey: "agent:main:subagent:workboard-default-card-1",
      runId: "run-1",
      progressSummary: "Still running according to stale cache.",
    });
    const container = document.createElement("div");
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [
        {
          key: "agent:main:subagent:workboard-default-card-1",
          kind: "direct",
          displayName: "Finished session",
          updatedAt: 2,
          hasActiveRun: false,
          status: "done",
        },
      ],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    } satisfies WorkboardRenderProps;

    render(renderWorkboard(props), container);

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("Finished session");
    expect(container.textContent).not.toContain("Task running");
    expect(container.textContent).not.toContain("Still running according to stale cache.");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Finished session");
    expect(container.querySelector(".workboard-detail")?.textContent).not.toContain(
      "Still running according to stale cache.",
    );
  });

  it("shows stop controls without start controls for active task-only cards", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Task only run",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        taskId: "task-1",
      },
    ];
    state.tasksByCardId.set("card-1", {
      id: "task-1",
      taskId: "task-1",
      status: "running",
      title: "Task only run",
      progressSummary: "Worker is active.",
    });
    const container = document.createElement("div");
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };

    render(renderWorkboard(props), container);

    expect(container.textContent).toContain("Task running");
    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Worker is active.",
    );
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("keeps unresolved task-linked cards from exposing duplicate starts", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Historical task link",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        taskId: "task-older-than-poll-page",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("does not expose live controls for terminal cards with unresolved task links", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Completed historical task",
        status: "done",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        taskId: "task-older-than-poll-page",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-live")).toBeNull();
    expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("keeps newly started unresolved runs from exposing duplicate starts", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Newly started run",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("allows starts for authoritatively missing historical task links", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Historical task link",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        taskId: "task-pruned-from-ledger",
      },
    ];
    state.missingTaskIds = new Set(["task-pruned-from-ledger"]);
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(1);
  });

  it("hides write controls for read-only operators", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Inspect only",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        canWrite: false,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(buttonByLabel(container, "Edit card")).toBeNull();
    expect(buttonByLabel(container, "Delete card")).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-toolbar__actions .btn.primary"),
    ).toBeNull();
    expect(container.querySelector<HTMLSelectElement>(".workboard-card__move-select")).toBeNull();
    expect(container.querySelector(".workboard-card")?.getAttribute("draggable")).toBe("false");
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");
  });

  it("moves a card from the compact status control", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Keyboard move",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const request = vi.fn(async () => ({
      card: { ...state.cards[0], status: "blocked", position: 1000, updatedAt: 2 },
    }));
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };
    const container = document.createElement("div");

    render(renderWorkboard(props), container);
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    expect(moveSelect?.value).toBe("todo");
    expect(moveSelect?.tagName).toBe("SELECT");
    expect(moveSelect?.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft ArrowRight");
    expect(moveSelect?.getAttribute("aria-label")).toBe("Status: Keyboard move");

    moveSelect!.value = "blocked";
    moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    render(renderWorkboard(props), container);

    expect(request).toHaveBeenCalledWith("workboard.cards.move", {
      id: "card-1",
      status: "blocked",
      position: 1000,
    });
    const blockedColumn = [...container.querySelectorAll<HTMLElement>(".workboard-column")].find(
      (column) => column.querySelector("h2")?.textContent === "Blocked",
    );
    expect(blockedColumn?.textContent).toContain("Keyboard move");
    expect(state.cards[0]).toMatchObject({ status: "blocked", updatedAt: 2 });
  });

  it("moves a focused status control with keyboard arrows", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Keyboard arrow move",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const request = vi.fn(async () => ({
      card: { ...state.cards[0], status: "scheduled", position: 1000, updatedAt: 2 },
    }));
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };
    const container = document.createElement("div");

    render(renderWorkboard(props), container);
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    const dispatched = moveSelect!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatched).toBe(false);
    expect(request).toHaveBeenCalledWith("workboard.cards.move", {
      id: "card-1",
      status: "scheduled",
      position: 1000,
    });
    expect(state.cards[0]).toMatchObject({ status: "scheduled", updatedAt: 2 });
  });

  it("does not queue status-control moves while a card is busy", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.busyCardIds.add("card-1");
    state.cards = [
      {
        id: "card-1",
        title: "Busy move",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const request = vi.fn();
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };
    const container = document.createElement("div");

    render(renderWorkboard(props), container);
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    expect(moveSelect?.disabled).toBe(true);

    moveSelect!.value = "blocked";
    moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    const dispatched = moveSelect!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(dispatched).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.cards[0]).toMatchObject({ status: "todo", updatedAt: 1 });
  });

  it("offers start controls when a linked session no longer exists", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Restart this",
        status: "blocked",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:missing:1",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Session missing");
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(1);
  });

  it("opens a modal for new cards", () => {
    const host = {};
    getWorkboardState(host).loaded = true;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    container
      .querySelector<HTMLButtonElement>(".workboard-toolbar__actions .btn.primary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector("openclaw-modal-dialog")?.textContent).toContain("New card");
    expect(container.querySelector('[aria-label="Card templates"]')?.textContent).toContain(
      "Bugfix",
    );
    expect(container.querySelector(".workboard-board")).toBeTruthy();
  });

  it("applies card templates in the create modal", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    const container = document.createElement("div");
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };

    render(renderWorkboard(props), container);
    [...container.querySelectorAll<HTMLButtonElement>(".workboard-template-strip .btn")]
      .find((button) => button.textContent?.includes("Release"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(state.draftTemplateId).toBe("release");
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Release: ",
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value,
    ).toContain("Verification:");
  });

  it("renders card event history", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Tracked task",
        status: "review",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 2,
        events: [
          { id: "event-1", kind: "moved", at: 1, fromStatus: "triage", toStatus: "backlog" },
          { id: "event-2", kind: "moved", at: 2, fromStatus: "backlog", toStatus: "todo" },
          { id: "event-3", kind: "moved", at: 3, fromStatus: "todo", toStatus: "scheduled" },
          { id: "event-4", kind: "moved", at: 4, fromStatus: "scheduled", toStatus: "ready" },
          { id: "event-5", kind: "moved", at: 5, fromStatus: "ready", toStatus: "running" },
          { id: "event-6", kind: "moved", at: 6, fromStatus: "running", toStatus: "review" },
          { id: "event-7", kind: "moved", at: 7, fromStatus: "review", toStatus: "done" },
        ],
      },
    ];
    const container = document.createElement("div");
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };

    render(renderWorkboard(props), container);

    expect(container.querySelector(".workboard-events")?.textContent).toContain("Moved to Review");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Moved to Done");
    expect(container.querySelector(".workboard-detail")?.textContent).not.toContain(
      "Moved to Backlog",
    );
  });

  it("renders card metadata badges and hides archived cards", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Metadata rich",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          templateId: "plugin",
          attempts: [{ id: "run-1", status: "blocked", startedAt: 1, endedAt: 2 }],
          failureCount: 1,
          comments: [{ id: "comment-1", body: "Needs owner check", createdAt: 3 }],
          links: [{ id: "link-1", type: "relates_to", url: "https://example.com", createdAt: 4 }],
          workerProtocol: {
            state: "blocked",
            detail: "Worker asked for owner input.",
            updatedAt: 12,
          },
          automation: {
            tenant: "ops",
            boardId: "quality",
            skills: ["review", "test"],
            workspace: { kind: "worktree", path: "/tmp/workboard", branch: "proof" },
            dispatchCount: 3,
            summary: "Ready for review.",
          },
          proof: Array.from({ length: 7 }, (_, index) => ({
            id: `proof-${index + 1}`,
            status: "passed",
            command: `pnpm test ${index + 1}`,
            url: `https://example.com/proof-${index + 1}`,
            createdAt: 5 + index,
          })),
          stale: { detectedAt: 6, reason: "No recent activity." },
        },
      },
      {
        id: "card-2",
        title: "Archived task",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 7 },
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Plugin");
    expect(container.textContent).toContain("1 failed");
    expect(container.textContent).toContain("1 comments");
    expect(container.textContent).toContain("7 proof");
    expect(container.textContent).toContain("stale");
    expect(container.textContent).not.toContain("Archived task");

    container
      .querySelector<HTMLButtonElement>(".workboard-archive-toggle")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );
    expect(container.textContent).toContain("Archived task");
    expect(container.querySelector<HTMLButtonElement>(".workboard-archive-toggle")).not.toBeNull();

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("1 attempts");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("1 links");
    expect(container.querySelector(".workboard-detail")?.textContent).not.toContain("pnpm test 1");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("pnpm test 7");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "https://example.com/proof-7",
    );
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Worker protocol");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Worker asked for owner input.",
    );
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Automation");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Tenant: ops");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Skills: review, test",
    );
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Workspace: worktree /tmp/workboard proof",
    );
  });

  it("filters cards by linked agent", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Main work",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "card-2",
        title: "Ops work",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "ops",
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "card-3",
        title: "Dispatcher work",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "workboard-dispatcher",
        position: 3000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: {
          defaultId: "main",
          mainKey: "agent:main:main",
          scope: "test",
          agents: [
            { id: "main", name: "Main" },
            { id: "ops", name: "Ops" },
          ],
        },
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const agentFilter = container.querySelector(".workboard-select--toolbar-agent");
    expect(agentFilter?.textContent).toContain("Main (default)");
    expect(agentFilter?.textContent).toContain("Unassigned (uses Main)");
    expect(agentFilter?.textContent).toContain("workboard-dispatcher (not configured)");

    changeWorkboardSelect(agentFilter, "ops");
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: {
          defaultId: "main",
          mainKey: "agent:main:main",
          scope: "test",
          agents: [
            { id: "main", name: "Main" },
            { id: "ops", name: "Ops" },
          ],
        },
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).not.toContain("Main work");
    expect(container.textContent).toContain("Ops work");
    expect(container.querySelector(".workboard-select--toolbar-agent")?.textContent).toContain(
      "Ops",
    );

    changeWorkboardSelect(
      container.querySelector(".workboard-select--toolbar-agent"),
      "workboard-dispatcher",
    );
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: {
          defaultId: "main",
          mainKey: "agent:main:main",
          scope: "test",
          agents: [
            { id: "main", name: "Main" },
            { id: "ops", name: "Ops" },
          ],
        },
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).not.toContain("Ops work");
    expect(container.textContent).toContain("Dispatcher work");
    expect(container.querySelector(".workboard-select--toolbar-agent")?.textContent).toContain(
      "workboard-dispatcher (not configured)",
    );
  });

  it("limits assignment choices to configured agents and preserves an unknown current assignee", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    state.draftTitle = "Assign me";
    state.draftAgentId = "workboard-dispatcher";
    state.cards = [
      {
        id: "card-1",
        title: "Assign me",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "workboard-dispatcher",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: {
          defaultId: "main",
          mainKey: "agent:main:main",
          scope: "test",
          agents: [
            { id: "main", name: "Main" },
            { id: "main", name: "Main duplicate" },
            { id: "ops", name: "Ops" },
          ],
        },
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const draft = container.querySelector<HTMLElement>(".workboard-draft");
    const agentSelect = [...(draft?.querySelectorAll<HTMLElement>(".workboard-select") ?? [])].at(
      2,
    );
    const optionLabels = [
      ...(agentSelect?.querySelectorAll<HTMLButtonElement>(".workboard-select__option") ?? []),
    ].map((option) => option.textContent?.trim());
    expect(optionLabels).toEqual([
      "Unassigned (uses Main)",
      "Main (default)",
      "Ops",
      "workboard-dispatcher (not configured)",
    ]);
  });

  it("renders the card modal with a single scrollable body and stable footer actions", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    state.draftTitle = "New task";
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const draft = container.querySelector(".workboard-draft");
    const body = draft?.querySelector(".workboard-draft__body");
    const footer = draft?.querySelector(":scope > .workboard-modal__actions");

    expect(body?.querySelector(".workboard-template-strip")).toBeTruthy();
    expect(body?.querySelector(".workboard-draft__meta")).toBeTruthy();
    expect(footer?.textContent).toContain("Create");
    expect(body?.contains(footer as Node)).toBe(false);
  });

  it("delegates modal select positioning and dismissal to Web Awesome", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    state.draftTitle = "New task";
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const selects = container.querySelectorAll(".workboard-draft wa-select");
    expect(selects.length).toBeGreaterThan(0);
    expect(container.querySelector(".workboard-select__menu")).toBeNull();
  });

  it("preflights model-specific starts for ACP runtime agents", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.detailCardId = "card-1";
    state.cards = [
      {
        id: "card-1",
        title: "ACP-backed work",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: {
          defaultId: "main",
          mainKey: "agent:main:main",
          scope: "test",
          agents: [{ id: "main", name: "Main", agentRuntime: { id: "codex", source: "agent" } }],
        },
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const engineButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start:not(.workboard-card__start--default)",
      ),
    ];
    expect(engineButtons).toHaveLength(4);
    expect(engineButtons.every((button) => button.disabled)).toBe(true);
    expect(engineButtons[0]?.getAttribute("aria-label")).toContain("uses the codex ACP runtime");
  });

  it("does not render details for archived selected cards", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.detailCardId = "card-1";
    state.cards = [
      {
        id: "card-1",
        title: "Archived selected task",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 2 },
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-detail")).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("shows stale lifecycle on executed linked cards", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(60 * 60 * 1000);
    try {
      const host = {};
      const state = getWorkboardState(host);
      state.loaded = true;
      state.cards = [
        {
          id: "card-1",
          title: "Watch stale run",
          status: "running",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 1,
          updatedAt: 1,
          execution: {
            id: "exec-1",
            kind: "agent-session",
            engine: "codex",
            mode: "autonomous",
            status: "running",
            model: "openai/gpt-5.5",
            sessionKey: "agent:main:dashboard:1",
            startedAt: 1,
            updatedAt: 1,
          },
        },
      ];
      const container = document.createElement("div");

      render(
        renderWorkboard({
          host,
          client: null,
          connected: true,
          pluginEnabled: true,
          agentsList: null,
          sessions: [
            {
              key: "agent:main:dashboard:1",
              kind: "direct",
              displayName: "Dashboard session",
              updatedAt: 1,
              hasActiveRun: false,
              status: "running",
            },
          ],
          onOpenSession: () => undefined,
        }),
        container,
      );

      expect(container.textContent).toContain("Stale");
      expect(container.textContent).toContain("No recent session activity");
      expect(container.textContent).not.toContain("codex autonomous");
      expect(container.querySelector(".workboard-live")).toBeNull();
      expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps live controls for legacy running session rows", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Stop legacy run",
        status: "running",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:dashboard:1",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Dashboard session",
            updatedAt: 1,
            status: "running",
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-live")?.textContent).toContain("live");
    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
  });

  it("opens an edit modal and submits card updates", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Rename me",
        notes: "Old notes",
        status: "todo",
        priority: "normal",
        labels: ["ui"],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          comments: [{ id: "comment-1", body: "Needs owner check", createdAt: 2 }],
        },
      },
    ];
    const request = vi.fn(async (method: string) =>
      method === "workboard.cards.comment"
        ? {
            card: {
              ...state.cards[0],
              metadata: {
                comments: [
                  ...(state.cards[0]?.metadata?.comments ?? []),
                  { id: "comment-2", body: "Ship after CI", createdAt: 3 },
                ],
              },
            },
          }
        : {
            card: {
              ...state.cards[0],
              title: "Renamed",
              priority: "high",
              updatedAt: 2,
            },
          },
    );
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };
    const container = document.createElement("div");

    render(renderWorkboard(props), container);
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector("openclaw-modal-dialog")?.textContent).toContain("Edit card");
    expect(container.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Needs owner check",
    );
    const commentInput = container.querySelector<HTMLTextAreaElement>(".workboard-comments__input");
    commentInput!.value = "Ship after CI";
    commentInput!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    render(renderWorkboard(props), container);
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Create"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.comment", {
      id: "card-1",
      body: "Ship after CI",
    });
    expect(state.cards[0]?.metadata?.comments?.at(-1)?.body).toBe("Ship after CI");
    render(renderWorkboard(props), container);

    const title = container.querySelector<HTMLInputElement>(".workboard-draft__title");
    expect(title?.value).toBe("Rename me");
    title!.value = "Renamed";
    title!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const priority = [
      ...(container
        .querySelector(".workboard-draft")
        ?.querySelectorAll<HTMLElement>(".workboard-select") ?? []),
    ].at(1);
    changeWorkboardSelect(priority, "high");
    container
      .querySelector<HTMLFormElement>(".workboard-draft")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({
        title: "Renamed",
        priority: "high",
      }),
    });
    expect(state.cards[0]).toMatchObject({ title: "Renamed", priority: "high", updatedAt: 2 });

    render(renderWorkboard(props), container);
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Renamed",
    );
    expect(
      [...(container.querySelector(".workboard-draft")?.querySelectorAll("wa-select") ?? [])]
        .at(1)
        ?.getAttribute("value"),
    ).toBe("high");
  });

  it("locks edit-modal actions while a comment request is in flight", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    state.editingCardId = "card-1";
    state.draftTitle = "Rename me";
    state.draftCommentBody = "Ship after CI";
    state.busyCardIds.add("card-1");
    state.cards = [
      {
        id: "card-1",
        title: "Rename me",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find((button) => button.textContent?.includes("Create"))?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent?.includes("Save"))?.disabled).toBe(true);
  });

  it("adds operator notes from the details drawer", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Investigate proof gap",
        status: "review",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const request = vi.fn(async () => ({
      card: {
        ...state.cards[0],
        metadata: {
          comments: [{ id: "comment-1", body: "Need Linux proof.", createdAt: 2 }],
        },
      },
    }));
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };
    const container = document.createElement("div");

    render(renderWorkboard(props), container);
    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    const note = container.querySelector<HTMLTextAreaElement>(".workboard-detail__note");
    note!.value = "Need Linux proof.";
    note!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    render(renderWorkboard(props), container);
    [...container.querySelectorAll<HTMLButtonElement>(".workboard-detail button")]
      .find((button) => button.textContent?.includes("Add note"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.comment", {
      id: "card-1",
      body: "Need Linux proof.",
    });
    expect(state.detailCommentBody).toBe("");
    expect(state.cards[0]?.metadata?.comments?.[0]?.body).toBe("Need Linux proof.");
  });

  it("archives cards from the card action", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Archive me",
        status: "done",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const request = vi.fn(async () => ({
      card: { ...state.cards[0], metadata: { archivedAt: 2 } },
    }));
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: { request } as unknown as GatewayBrowserClient,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
        onRequestUpdate: () => undefined,
      }),
      container,
    );
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Archive card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: "card-1",
      archived: true,
    });
    expect(state.cards[0]?.metadata?.archivedAt).toBe(2);
  });

  it("offers existing sessions when creating a card", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Existing session",
            updatedAt: 2,
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("No linked session");
    expect(container.textContent).toContain("Existing session");
  });

  it("shows a missing current session key instead of a false empty selection", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    state.draftSessionKey = "agent:main:archived-session";
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const sessionSelect = [
      ...(container
        .querySelector(".workboard-draft")
        ?.querySelectorAll<HTMLElement>(".workboard-select") ?? []),
    ].at(3);
    expect(sessionSelect?.getAttribute("value")).toBe("agent:main:archived-session");
    expect(
      sessionSelect?.querySelector('wa-option[value="agent:main:archived-session"]'),
    ).not.toBeNull();
  });

  it("does not offer synthetic heartbeat sessions when creating a card", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:heartbeat",
            kind: "direct",
            displayName: "heartbeat",
            updatedAt: 2,
          },
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Dashboard session",
            updatedAt: 3,
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const sessionOptions = [
      ...(container
        .querySelector(".workboard-draft")
        ?.querySelectorAll<HTMLElement>(".workboard-select") ?? []),
    ].at(3);
    const labels = [...(sessionOptions?.querySelectorAll(".workboard-select__option") ?? [])].map(
      (option) => option.textContent?.trim(),
    );
    expect(labels).toContain("Dashboard session");
    expect(labels).not.toContain("heartbeat");
  });

  it("shows an enablement message when the optional plugin is disabled", () => {
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host: {},
        client: null,
        connected: true,
        pluginEnabled: false,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Workboard is disabled");
    expect(container.querySelector(".workboard-column")).toBeNull();
  });

  it("keeps the panel in a neutral loading state while config enablement is unknown", () => {
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host: {},
        client: null,
        connected: true,
        pluginEnabled: null,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Loading panel");
    expect(container.textContent).not.toContain("Workboard is disabled");
    expect(container.querySelector(".workboard-column")).toBeNull();
  });

  it("shows config load failures with a retry action", () => {
    const container = document.createElement("div");
    const onReloadConfig = vi.fn();

    render(
      renderWorkboard({
        host: {},
        client: null,
        connected: true,
        pluginEnabled: null,
        pluginEnablementError: "config.get failed",
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
        onReloadConfig,
      }),
      container,
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("config.get failed");
    expect(container.textContent).not.toContain("Loading panel");
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Retry")
      ?.click();
    expect(onReloadConfig).toHaveBeenCalledOnce();
  });
});
