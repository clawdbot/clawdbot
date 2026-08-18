// Control UI tests cover workboard behavior.
import { nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { nextWorkboardCardPosition } from "../../lib/workboard/card-state.ts";
import { getWorkboardState, stopWorkboardLifecycleRefresh } from "../../lib/workboard/index.ts";
import {
  createWorkboardCard,
  createWorkboardExecution,
} from "../../lib/workboard/test/index-helpers.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { renderWorkboard } from "./view.ts";

type WorkboardRenderProps = Parameters<typeof renderWorkboard>[0];

function createLoadedWorkboardState() {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  return { host, state };
}

function createWorkboardRenderProps(
  host: WorkboardRenderProps["host"],
  overrides: Partial<WorkboardRenderProps> = {},
): WorkboardRenderProps {
  return {
    host,
    client: null,
    connected: true,
    pluginEnabled: true,
    agentsList: null,
    sessions: [],
    onOpenSession: () => undefined,
    ...overrides,
  };
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function renderInto(container: HTMLElement, props: WorkboardRenderProps) {
  render(renderWorkboard(props), container);
}

function createWorkboardView(
  overrides: Partial<WorkboardRenderProps> = {},
  host: WorkboardRenderProps["host"] = {},
) {
  const state = getWorkboardState(host);
  state.loaded = true;
  const container = document.createElement("div");
  const props = createWorkboardRenderProps(host, overrides);
  const renderView = (next: Partial<WorkboardRenderProps> = {}) =>
    renderInto(container, { ...props, ...next });
  return { host, state, container, renderView };
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
  Reflect.deleteProperty(control, "value");
}

function selectWorkboardAgent(select: Element | null | undefined, value: string) {
  const control = select as
    | (HTMLElement & { onSelect: (value: string) => void })
    | null
    | undefined;
  expect(control).not.toBeNull();
  control?.onSelect(value);
}

describe("nextWorkboardCardPosition", () => {
  const opsCard = createWorkboardCard({
    metadata: { automation: { boardId: "ops" } },
  });
  const runningOpsCard = createWorkboardCard({
    id: "moving-ops-running",
    status: "running",
    position: 9000,
    metadata: { automation: { boardId: "ops" } },
  });

  it.each([
    {
      name: "starts an empty board column at the canonical position",
      card: opsCard,
      cards: [],
      position: 1000,
    },
    {
      name: "appends after cards on the same board",
      card: opsCard,
      cards: [
        createWorkboardCard({
          id: "ops-running",
          status: "running",
          position: 2000,
          metadata: { automation: { boardId: "ops" } },
        }),
      ],
      position: 3000,
    },
    {
      name: "does not count a card dropped back into its own empty column",
      card: runningOpsCard,
      cards: [runningOpsCard],
      position: 1000,
    },
    {
      name: "appends a same-column drop after its other cards only",
      card: runningOpsCard,
      cards: [
        runningOpsCard,
        createWorkboardCard({
          id: "other-ops-running",
          status: "running",
          position: 2000,
          metadata: { automation: { boardId: "ops" } },
        }),
      ],
      position: 3000,
    },
    {
      name: "ignores larger positions on another board",
      card: opsCard,
      cards: [
        createWorkboardCard({
          id: "product-running",
          status: "running",
          position: 9000,
          metadata: { automation: { boardId: "product" } },
        }),
      ],
      position: 1000,
    },
    {
      name: "preserves archived positions on the same board",
      card: opsCard,
      cards: [
        createWorkboardCard({
          id: "archived-ops-running",
          status: "running",
          position: 3000,
          metadata: { archivedAt: 10, automation: { boardId: "ops" } },
        }),
      ],
      position: 4000,
    },
    {
      name: "ignores a larger position in another status",
      card: opsCard,
      cards: [
        createWorkboardCard({
          id: "ops-done",
          status: "done",
          position: 9000,
          metadata: { automation: { boardId: "ops" } },
        }),
      ],
      position: 1000,
    },
    {
      name: "normalizes explicit and implicit default board ids",
      card: createWorkboardCard(),
      cards: [
        createWorkboardCard({
          id: "default-running",
          status: "running",
          position: 1000,
          metadata: { automation: { boardId: " default " } },
        }),
      ],
      position: 2000,
    },
  ])("$name", ({ card, cards, position }) => {
    expect(nextWorkboardCardPosition(cards, card, "running")).toBe(position);
  });
});

describe("renderWorkboard", () => {
  it("shows a card dashboard only for linked cards while the plugin is active", () => {
    const { state, container, renderView } = createWorkboardView();
    state.detailCardId = "card-1";
    state.cards = [
      createWorkboardCard({
        title: "Dashboard-aware card",
        status: "running",
        position: 1,
      }),
    ];
    renderView();
    expect(container.querySelector("openclaw-workboard-card-dashboard")).toBeNull();

    state.cards = [{ ...state.cards[0]!, sessionKey: "agent:main:dashboard-aware" }];
    renderView();
    expect(container.querySelector("openclaw-workboard-card-dashboard")).not.toBeNull();

    renderView({ pluginEnabled: false });
    expect(container.querySelector("openclaw-workboard-card-dashboard")).toBeNull();
  });

  it("releases the card dashboard provider when the details panel closes", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const sessionKey = "agent:main:dashboard-panel-close";
    state.loaded = true;
    state.detailCardId = "card-1";
    state.cards = [
      createWorkboardCard({
        title: "Disposable dashboard card",
        status: "running",
        position: 1,
        sessionKey,
      }),
    ];
    const removeListener = vi.fn();
    const request = vi.fn(async () => ({
      sessionKey,
      revision: 0,
      tabs: [],
      widgets: [],
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const props = createWorkboardRenderProps(host, {
      client: {
        request,
        addEventListener: vi.fn(() => removeListener),
      } as unknown as GatewayBrowserClient,
    });

    try {
      renderInto(container, props);
      // The dashboard element is lazily imported; on loaded CI runners that
      // import can outlive vi.waitFor's default timeout. Await the definition
      // and the upgraded element's first update, which acquires the provider
      // and issues board.get synchronously.
      await customElements.whenDefined("openclaw-workboard-card-dashboard");
      const dashboard = container.querySelector("openclaw-workboard-card-dashboard");
      expect(dashboard).not.toBeNull();
      await dashboard!.updateComplete;
      expect(request).toHaveBeenCalledWith("board.get", { sessionKey });

      state.detailCardId = null;
      renderInto(container, props);
      await nextFrame();

      expect(removeListener).toHaveBeenCalledOnce();
    } finally {
      // A leaked open drawer poisons later dialog tests in this shared jsdom
      // document, so tear down even when an assertion above fails.
      render(nothing, container);
      container.remove();
    }
  });

  it("keeps manual recovery refresh visible while data is loading", () => {
    const { state, container, renderView } = createWorkboardView();
    state.loading = true;
    renderView();

    expect(buttonByText(container, "Refreshing")?.disabled).toBe(true);
  });

  it("renders lifecycle refresh errors without replacing generic errors", () => {
    const { state, container, renderView } = createWorkboardView();
    state.lifecycleTaskRefreshError = "Task refresh unavailable";
    renderView();
    expect(container.querySelector(".callout.danger")?.textContent).toBe(
      "Task refresh unavailable",
    );

    state.error = "Write denied";
    renderView();
    expect(container.querySelector(".callout.danger")?.textContent).toBe("Write denied");
  });

  it("keeps dispatch available during refresh and disables it during writes", () => {
    const { state, container, renderView } = createWorkboardView();
    state.loading = true;
    renderView();

    const dispatchButton = buttonByText(container, "Dispatch ready work");
    expect(dispatchButton?.disabled).toBe(false);

    state.draftSaving = true;
    renderView();

    expect(buttonByText(container, "Dispatch ready work")?.disabled).toBe(true);

    state.loading = false;
    renderView();

    expect(buttonByText(container, "Refresh")?.disabled).toBe(true);

    state.draftSaving = false;
    state.dispatching = true;
    renderView();

    expect(buttonByText(container, "Dispatch ready work")?.disabled).toBe(true);

    renderView();

    expect(buttonByText(container, "Refresh")?.disabled).toBe(true);
  });

  it("disables card-write controls while dispatch is running", () => {
    const sessionKey = "agent:main:workboard-dispatch";
    const card = createWorkboardCard({
      title: "Dispatch-safe card",
      sessionKey,
    });
    const request = vi.fn(async () => ({ card }));
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: [
        { key: sessionKey, kind: "direct", status: "running", hasActiveRun: true, updatedAt: 2 },
      ],
    });
    state.dispatching = true;
    state.detailCardId = "card-1";
    state.cards = [card];
    renderView();

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
    renderView();

    expect(
      container.querySelector<HTMLButtonElement>(".workboard-draft .btn.primary")?.disabled,
    ).toBe(true);
  });

  it("renders stable card action slots and top updated timestamps", () => {
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        {
          key: "agent:main:dashboard:1",
          kind: "direct",
          updatedAt: Date.now(),
          status: "running",
          hasActiveRun: true,
        },
      ],
    });
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
    renderView();

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
    const { state, container, renderView } = createWorkboardView();
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
    renderView();

    const detailText = container.querySelector(".workboard-detail")?.textContent ?? "";
    expect(detailText).toContain("Updated");
    expect(detailText).toMatch(/\d+:\d\d/);
  });

  it("keeps the last updated timestamp stable next to density controls while refreshing", () => {
    const { state, container, renderView } = createWorkboardView();
    state.loading = true;
    state.lastRefreshAt = new Date("2026-06-03T18:47:00Z").getTime();
    state.lastRefreshStartedAt = Date.now();
    renderView();

    const layoutControls = container.querySelector(".workboard-layout-controls");
    expect(layoutControls?.querySelector(".workboard-layout-toggle")).toBeTruthy();
    expect(layoutControls?.querySelector(".workboard-refresh-status")?.textContent).toContain(
      "Updated",
    );
    expect(layoutControls?.textContent).not.toContain("Refreshing");
  });

  it("renders board columns and preloaded cards", () => {
    const now = Date.now();
    const { state, container, renderView } = createWorkboardView({
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
    });
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
    renderView();

    expect(container.textContent).toContain("Todo");
    expect(container.textContent).toContain("Wire dashboard tab");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Dashboard session");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);
    expect(container.querySelector(".workboard-card__priority")?.textContent).toContain("High");
    expect(container.querySelector(".workboard-health")?.textContent).toContain("running");
  });

  it("distinguishes the dragged card from its available drop columns", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.cards = [
      createWorkboardCard({
        title: "Drag feedback",
      }),
    ];
    state.draggedCardId = "card-1";
    renderView();

    expect(container.querySelector(".workboard-card")?.classList).toContain(
      "workboard-card--dragging",
    );
    expect(container.querySelectorAll(".workboard-column--drop")).toHaveLength(9);

    state.draggedCardId = null;
    renderView();

    expect(container.querySelector(".workboard-card--dragging")).toBeNull();
    expect(container.querySelector(".workboard-column--drop")).toBeNull();
  });

  it("moves the resolved active card when a drop has no transfer payload", async () => {
    const card = createWorkboardCard({ title: "Fallback drag move" });
    const moved = { ...card, status: "running" as const, position: 1000 };
    const request = vi.fn(async () => ({ card: moved }));
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
    });
    state.cards = [card];
    state.draggedCardId = card.id;
    renderView();

    container
      .querySelector(".workboard-column--running")
      ?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.move", {
      id: card.id,
      status: "running",
      position: 1000,
    });
    expect(state.cards).toContainEqual(moved);
  });

  it("hides cached card mutation controls until a lifecycle teardown reload succeeds", async () => {
    const { host, state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Stale cached card",
      }),
    ];
    stopWorkboardLifecycleRefresh(host);
    renderView();

    expect(buttonByLabel(container, "Edit card")).toBeNull();
    expect(buttonByLabel(container, "Archive card")).toBeNull();
    expect(buttonByText(container, "New card")).toBeNull();
    expect(container.querySelector(".workboard-card")?.getAttribute("draggable")).toBe("false");

    state.mutationReadiness = "ready";
    renderView();

    expect(buttonByLabel(container, "Edit card")).not.toBeNull();
    expect(buttonByText(container, "New card")).not.toBeNull();
  });

  it("keeps a stale edit draft disabled until it is cancelled", async () => {
    const { host, state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Canonical title",
      }),
    ];
    state.draftOpen = true;
    state.editingCardId = "card-1";
    state.draftTitle = "Unsaved edit";
    stopWorkboardLifecycleRefresh(host);
    renderView();
    state.mutationReadiness = "stale_edit_draft";
    renderView();

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
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Blocked worker",
        status: "blocked",
        metadata: {
          attempts: [{ id: "attempt-1", status: "failed", startedAt: 1 }],
          claim: {
            ownerId: "agent-1",
            token: "[redacted]",
            claimedAt: 1,
            lastHeartbeatAt: Date.now(),
          },
          diagnostics: [
            {
              kind: "orphaned_session",
              severity: "warning",
              title: "Old diagnostic",
              detail: "Older detail.",
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
              actions: [],
            },
            {
              kind: "repeated_failures",
              severity: "error",
              title: "Repeated run failures",
              detail: "Multiple attempts failed.",
              firstSeenAt: 1,
              lastSeenAt: 2,
              count: 1,
              actions: [],
            },
          ],
          notifications: [{ id: "note-1", kind: "failed", createdAt: 1, message: "Needs proof." }],
        },
      }),
    ];
    renderView();

    expect(container.querySelector(".workboard-health")?.textContent).toContain("1blocked");
    expect(container.textContent).toContain("1 attempts");
    expect(container.textContent).toContain("heartbeat");
    expect(container.textContent).toContain("Repeated run failures");
    expect(container.textContent).not.toContain("Old diagnostic");
    expect(container.textContent).toContain("Needs proof.");
  });

  it("keeps bounded diagnostic badges UTF-16 safe", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        id: "card-boundary",
        title: "Boundary badge",
        metadata: {
          diagnostics: [
            {
              kind: "orphaned_session",
              severity: "warning",
              title: `${"x".repeat(62)}🚀tail`,
              detail: "Boundary detail.",
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
              actions: [],
            },
          ],
        },
      }),
    ];
    renderView();

    expect(container.querySelector(".workboard-card__badge--warning")?.textContent?.trim()).toBe(
      `${"x".repeat(62)}…`,
    );
  });

  it("renders sub-minute heartbeat ages with the duration count interpolation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00Z"));
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Active worker",
        status: "running",
        metadata: {
          claim: {
            ownerId: "agent-1",
            token: "[redacted]",
            claimedAt: 1,
            lastHeartbeatAt: Date.now() - 42_000,
          },
        },
      }),
    ];
    try {
      renderView();

      expect(container.textContent).toContain("heartbeat 42s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("highlights cards matching a clicked health badge", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Blocked worker",
        status: "blocked",
      }),
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
    renderView();

    container
      .querySelector<HTMLButtonElement>(".workboard-health__item--blocked")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

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
    renderView();

    expect(state.activeHealthHighlight).toBeNull();
    expect(container.querySelector(".workboard-card--health-highlight")).toBeNull();
  });

  it("filters cards with the view preset selector", () => {
    const { state, container, renderView } = createWorkboardView();
    state.viewPreset = "ready";
    state.cards = [
      createWorkboardCard({
        id: "ready",
        title: "Ready card",
        status: "ready",
      }),
      createWorkboardCard({
        id: "blocked",
        title: "Blocked card",
        status: "blocked",
      }),
    ];
    renderView();

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
    const { state, container, renderView } = createWorkboardView();
    state.viewPreset = "running";
    state.cards = [
      createWorkboardCard({
        id: "card-ready",
        title: "Ready card",
        status: "ready",
      }),
    ];
    renderView();

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
    const { state, container, renderView } = createWorkboardView();
    state.viewPreset = "all";
    state.priorityFilter = "urgent";
    state.cards = [
      createWorkboardCard({
        id: "card-ready",
        title: "Ready card",
        status: "ready",
      }),
    ];
    renderView();

    expect(container.querySelector(".workboard-column")).toBeNull();
    expect(container.querySelector(".workboard-empty-state")?.textContent).toContain(
      "No cards match this view",
    );
  });

  it("uses the same Web Awesome select control for Workboard toolbar filters", () => {
    const { container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "per-sender",
        agents: [{ id: "main", name: "Main" }],
      },
    });
    renderView();

    const toolbarFilters = container.querySelector(".workboard-toolbar__filters");
    expect(toolbarFilters?.querySelectorAll(".workboard-select--toolbar")).toHaveLength(2);
    expect(toolbarFilters?.querySelectorAll("select")).toHaveLength(0);
    expect(toolbarFilters?.textContent).toContain("All cards");
    expect(toolbarFilters?.textContent).toContain("All priorities");
    expect(
      toolbarFilters
        ?.querySelector<HTMLElement & { options: Array<{ label: string }> }>(
          ".workboard-agent-select--toolbar",
        )
        ?.options.map((option) => option.label),
    ).toContain("All agents");
    const priorityFilter = toolbarFilters?.querySelectorAll(".workboard-select--toolbar").item(1);
    expect(priorityFilter?.textContent).toContain("Low");
    expect(priorityFilter?.textContent).toContain("Normal");
    expect(priorityFilter?.textContent).toContain("High");
    expect(priorityFilter?.textContent).toContain("Urgent");
  });

  it("filters cards to the global agent scope and hides the secondary agent filter", () => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "writer" }, { id: "ops" }],
      },
      scopeAgentId: "writer",
      showAgentFilter: false,
    });
    state.viewPreset = "all";
    state.cards = [
      createWorkboardCard({
        id: "writer-card",
        title: "Writer card",
        status: "ready",
        agentId: "writer",
      }),
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
    renderView();

    expect(container.textContent).toContain("Writer card");
    expect(container.textContent).not.toContain("Ops card");
    expect(container.querySelectorAll(".workboard-select--toolbar")).toHaveLength(2);
  });

  it("uses labelled controls for Workboard filters", () => {
    const { container, renderView } = createWorkboardView();
    renderView();

    const selects = [
      ...container.querySelectorAll<HTMLElement & { value: string }>(
        ".workboard-toolbar__filters > wa-select",
      ),
    ];
    expect(selects).toHaveLength(2);
    expect(selects.map((select) => select.querySelector('[slot="label"]')?.textContent)).toEqual([
      "Workboard view",
      "All priorities",
    ]);
    expect(
      selects.map((select) => select.querySelector("wa-option[selected]")?.getAttribute("value")),
    ).toEqual(["all", "all"]);
    const agentSelect = container.querySelector<
      HTMLElement & { accessibleLabel: string; value: string }
    >(".workboard-agent-select--toolbar");
    expect(agentSelect?.accessibleLabel).toBe("Filter by agent");
    expect(agentSelect?.value).toBe("all");
    expect(container.querySelector(".workboard-select__trigger")).toBeNull();
  });

  it("can hide empty columns while keeping populated columns visible", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [
      createWorkboardCard({
        title: "Keep visible",
      }),
    ];
    renderView();
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);

    const toggle = container.querySelector<HTMLInputElement>(
      'input[name="workboard-hide-empty-columns"]',
    );
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change", { bubbles: true }));
    renderView();

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
    const { state, container, renderView } = createWorkboardView();
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
    renderView();

    expect(container.textContent).toContain("Bad timestamp card");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it("opens card details from the card surface without hijacking action buttons", () => {
    const onOpenSession = vi.fn();
    const { state, container, renderView } = createWorkboardView({
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
    });
    state.cards = [
      createWorkboardCard({
        title: "Inspect a running task",
        status: "running",
        sessionKey: "agent:main:dashboard:1",
      }),
    ];
    renderView();

    const card = container.querySelector<HTMLElement>(".workboard-card");
    card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
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
    const sessionKey = "agent:main:detail-parity";
    const onOpenSession = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
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
    });
    state.detailCardId = "card-1";
    state.cards = [
      createWorkboardCard({
        title: "Detail parity",
        status: "running",
        sessionKey,
      }),
    ];
    renderView();

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
    const { host, state } = createLoadedWorkboardState();
    state.cards = [];
    const container = document.createElement("div");
    document.body.append(container);
    const props = createWorkboardRenderProps(host, {
      onRequestUpdate: () => renderInto(container, props),
    });

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
    const { host } = createLoadedWorkboardState();
    const container = document.createElement("div");
    document.body.append(container);
    const props = createWorkboardRenderProps(host, {
      onRequestUpdate: () => renderInto(container, props),
    });

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
    const { host, state } = createLoadedWorkboardState();
    state.cards = [
      createWorkboardCard({
        title: "Inspect drawer focus",
      }),
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const props = createWorkboardRenderProps(host, {
      onRequestUpdate: () => renderInto(container, props),
    });

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
    const { host, state } = createLoadedWorkboardState();
    state.cards = [];
    const container = document.createElement("div");
    document.body.append(container);
    const props = createWorkboardRenderProps(host, {
      onRequestUpdate: () => renderInto(container, props),
    });

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
    const { host, state } = createLoadedWorkboardState();
    state.cards = [
      createWorkboardCard({
        title: "Remove drawer externally",
      }),
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const props = createWorkboardRenderProps(host, {
      onRequestUpdate: () => renderInto(container, props),
    });

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
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Start this later",
      }),
    ];
    renderView();

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
    renderView();

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
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [
      createWorkboardCard({
        id: "parent-1",
        title: "Finish art pass",
      }),
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
    renderView();

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
    renderView();

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
    const { state, container, renderView } = createWorkboardView({ canModelOverride: false });
    state.cards = [
      createWorkboardCard({
        title: "Start with default model",
      }),
    ];
    renderView();

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
    renderView();
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
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Review task result",
        status: "running",
        sessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
        taskId: "task-1",
      }),
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
    renderView();

    expect(container.textContent).toContain("task linked");
    expect(container.textContent).toContain("Task complete");
    expect(container.textContent).toContain("Ready for operator review.");
  });

  it("renders a queued linked session without running copy", () => {
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        {
          key: "agent:main:queued",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: true,
          status: "queued",
        },
      ],
    });
    state.cards = [
      createWorkboardCard({
        status: "todo",
        sessionKey: "agent:main:queued",
      }),
    ];
    renderView();

    expect(container.querySelector(".workboard-lifecycle")?.textContent?.trim()).toBe("Queued");
    expect(container.querySelector(".workboard-card__lifecycle-detail")?.textContent?.trim()).toBe(
      "Waiting for a concurrency slot",
    );
  });

  it("uses terminal session lifecycle when cached task status is stale", () => {
    const { state, container, renderView } = createWorkboardView({
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
      onRequestUpdate: () => undefined,
    });
    state.cards = [
      createWorkboardCard({
        title: "Finished despite stale task",
        status: "running",
        sessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
        taskId: "task-1",
      }),
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
    renderView();

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("Finished session");
    expect(container.textContent).not.toContain("Task running");
    expect(container.textContent).not.toContain("Still running according to stale cache.");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Finished session");
    expect(container.querySelector(".workboard-detail")?.textContent).not.toContain(
      "Still running according to stale cache.",
    );
  });

  it("shows stop controls without start controls for active task-only cards", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [
      createWorkboardCard({
        title: "Task only run",
        status: "running",
        taskId: "task-1",
      }),
    ];
    state.tasksByCardId.set("card-1", {
      id: "task-1",
      taskId: "task-1",
      status: "running",
      title: "Task only run",
      progressSummary: "Worker is active.",
    });
    renderView();

    expect(container.textContent).toContain("Task running");
    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Worker is active.",
    );
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("keeps unresolved task-linked cards from exposing duplicate starts", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Historical task link",
        status: "running",
        taskId: "task-older-than-poll-page",
      }),
    ];
    renderView();

    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("does not expose live controls for terminal cards with unresolved task links", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Completed historical task",
        status: "done",
        taskId: "task-older-than-poll-page",
      }),
    ];
    renderView();

    expect(container.querySelector(".workboard-live")).toBeNull();
    expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("keeps newly started unresolved runs from exposing duplicate starts", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Newly started run",
        status: "running",
        sessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
      }),
    ];
    renderView();

    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("allows starts for authoritatively missing historical task links", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Historical task link",
        status: "running",
        taskId: "task-pruned-from-ledger",
      }),
    ];
    state.missingTaskIds = new Set(["task-pruned-from-ledger"]);
    renderView();

    expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(1);
  });

  it("hides write controls for read-only operators", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: false });
    state.cards = [
      createWorkboardCard({
        title: "Inspect only",
      }),
    ];
    renderView();

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
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Keyboard move",
      }),
    ];
    const request = vi.fn(async () => ({
      card: { ...state.cards[0], status: "blocked", position: 1000, updatedAt: 2 },
    }));
    renderView({ client: { request } as unknown as GatewayBrowserClient });
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    expect(moveSelect?.value).toBe("todo");
    expect(moveSelect?.tagName).toBe("SELECT");
    expect(moveSelect?.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft ArrowRight");
    expect(moveSelect?.getAttribute("aria-label")).toBe("Status: Keyboard move");

    moveSelect!.value = "blocked";
    moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    renderView({ client: { request } as unknown as GatewayBrowserClient });

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

  it("appends a status move after archived cards on its own board only", async () => {
    const { state, container, renderView } = createWorkboardView();
    const movingCard = createWorkboardCard({
      title: "Move within Operations",
      metadata: { automation: { boardId: "ops" } },
    });
    state.boardFilter = "ops";
    state.cards = [
      movingCard,
      createWorkboardCard({
        id: "archived-ops-running",
        title: "Archived Operations run",
        status: "running",
        position: 3000,
        metadata: { archivedAt: 10, automation: { boardId: "ops" } },
      }),
      createWorkboardCard({
        id: "product-running",
        title: "Unrelated Product run",
        status: "running",
        position: 9000,
        metadata: { automation: { boardId: "product" } },
      }),
    ];
    const moved = { ...movingCard, status: "running" as const, position: 4000 };
    const request = vi.fn(async () => ({ card: moved }));
    renderView({ client: { request } as unknown as GatewayBrowserClient });
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    expect(moveSelect).not.toBeNull();
    moveSelect!.value = "running";
    moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.move", {
      id: movingCard.id,
      status: "running",
      position: 4000,
    });
    expect(state.cards).toContainEqual(moved);
  });

  it("moves a focused status control with keyboard arrows", async () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Keyboard arrow move",
      }),
    ];
    const request = vi.fn(async () => ({
      card: { ...state.cards[0], status: "scheduled", position: 1000, updatedAt: 2 },
    }));
    renderView({ client: { request } as unknown as GatewayBrowserClient });
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
    const { state, container, renderView } = createWorkboardView();
    state.busyCardIds.add("card-1");
    state.cards = [
      createWorkboardCard({
        title: "Busy move",
      }),
    ];
    const request = vi.fn();
    renderView({ client: { request } as unknown as GatewayBrowserClient });
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
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Restart this",
        status: "blocked",
        sessionKey: "agent:main:missing:1",
      }),
    ];
    renderView();

    expect(container.textContent).toContain("Session missing");
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(1);
  });

  it("opens a modal for new cards", () => {
    const { container, renderView } = createWorkboardView();
    renderView();

    container
      .querySelector<HTMLButtonElement>(".workboard-toolbar__actions .btn.primary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(container.querySelector("openclaw-modal-dialog")?.textContent).toContain("New card");
    expect(container.querySelector('[aria-label="Card templates"]')?.textContent).toContain(
      "Bugfix",
    );
    expect(container.querySelector(".workboard-board")).toBeTruthy();
  });

  it.each([
    {
      name: "the selected named agent scope",
      scopeAgentId: "writer",
      agentFilter: "all",
      expectedAgentId: "writer",
    },
    {
      name: "the selected named agent filter",
      scopeAgentId: null,
      agentFilter: "ops",
      expectedAgentId: "ops",
    },
    {
      name: "the selected default agent scope",
      scopeAgentId: "main",
      agentFilter: "all",
      expectedAgentId: "",
    },
    {
      name: "the explicitly selected default agent filter",
      scopeAgentId: null,
      agentFilter: "main",
      expectedAgentId: "main",
    },
    {
      name: "the all-agents filter",
      scopeAgentId: null,
      agentFilter: "all",
      expectedAgentId: "",
    },
    {
      name: "the unassigned default-agent filter",
      scopeAgentId: null,
      agentFilter: "default",
      expectedAgentId: "",
    },
    {
      name: "a non-assignable system-agent diagnostic filter",
      scopeAgentId: null,
      agentFilter: "workboard-dispatcher",
      expectedAgentId: "",
    },
  ])("initializes new cards from $name", ({ scopeAgentId, agentFilter, expectedAgentId }) => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "writer", name: "Writer" },
          { id: "ops", name: "Ops" },
          { id: "workboard-dispatcher", kind: "system", name: "Dispatcher" },
        ],
      },
      scopeAgentId,
    });
    state.agentFilter = agentFilter;
    renderView();
    container
      .querySelector<HTMLButtonElement>(".workboard-toolbar__actions .btn.primary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(state.draftOpen).toBe(true);
    expect(state.draftAgentId).toBe(expectedAgentId);
    expect(
      container.querySelector<HTMLElement & { value: string }>(
        ".workboard-draft .workboard-agent-select",
      )?.value,
    ).toBe(expectedAgentId);
  });

  it.each([
    {
      name: "a selected named agent",
      scopeAgentId: "writer",
      defaultAgentId: "main",
      expectedAgentId: "writer",
    },
    {
      name: "the gateway's default agent",
      scopeAgentId: "main",
      defaultAgentId: "main",
      expectedAgentId: "",
    },
    {
      name: "a configured non-main default agent",
      scopeAgentId: "research",
      defaultAgentId: "research",
      expectedAgentId: "",
    },
    {
      name: "an unvalidated secondary agent filter",
      scopeAgentId: null,
      defaultAgentId: "main",
      agentFilter: "ops",
      expectedAgentId: "",
    },
    {
      name: "a stale system-agent diagnostic filter",
      scopeAgentId: null,
      defaultAgentId: "main",
      agentFilter: "workboard-dispatcher",
      expectedAgentId: "",
    },
  ])(
    "keeps $name while its roster has not loaded",
    ({ scopeAgentId, defaultAgentId, agentFilter, expectedAgentId }) => {
      const { state, container, renderView } = createWorkboardView({
        agentsList: null,
        defaultAgentId,
        scopeAgentId,
      });
      state.agentFilter = agentFilter ?? "all";
      if (agentFilter) {
        state.cards = [createWorkboardCard({ agentId: agentFilter })];
      }
      renderView();
      container
        .querySelector<HTMLButtonElement>(".workboard-toolbar__actions .btn.primary")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      renderView();

      expect(state.draftOpen).toBe(true);
      expect(state.draftAgentId).toBe(expectedAgentId);
      expect(
        container.querySelector<HTMLElement & { value: string }>(
          ".workboard-draft .workboard-agent-select",
        )?.value,
      ).toBe(expectedAgentId);
    },
  );

  it("applies card templates in the create modal", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.draftOpen = true;
    renderView();
    [...container.querySelectorAll<HTMLButtonElement>(".workboard-template-strip .btn")]
      .find((button) => button.textContent?.includes("Release"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(state.draftTemplateId).toBe("release");
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Release: ",
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value,
    ).toContain("Verification:");
  });

  it("renders card event history", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
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
    renderView();

    expect(container.querySelector(".workboard-events")?.textContent).toContain("Moved to Review");

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Moved to Done");
    expect(container.querySelector(".workboard-detail")?.textContent).not.toContain(
      "Moved to Backlog",
    );
  });

  it("renders card metadata badges and hides archived cards", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Metadata rich",
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
      }),
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
    renderView();

    expect(container.textContent).toContain("Plugin");
    expect(container.textContent).toContain("1 failed");
    expect(container.textContent).toContain("1 comments");
    expect(container.textContent).toContain("7 proof");
    expect(container.textContent).toContain("stale");
    expect(container.textContent).not.toContain("Archived task");

    container
      .querySelector<HTMLButtonElement>(".workboard-archive-toggle")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    expect(container.textContent).toContain("Archived task");
    expect(container.querySelector<HTMLButtonElement>(".workboard-archive-toggle")).not.toBeNull();

    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
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

  it("filters cards by persisted boards and keeps empty archived boards selectable", () => {
    const onBoardFilterChange = vi.fn();
    const { state, container, renderView } = createWorkboardView({ onBoardFilterChange });
    state.boards = [
      { id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } },
      {
        id: "ops",
        name: "Operations",
        total: 1,
        active: 1,
        archived: 0,
        byStatus: { todo: 1 },
      },
      {
        id: "archive",
        name: "Old work",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        archivedAt: 7,
      },
    ];
    state.cards = [
      createWorkboardCard({
        id: "card-default",
        title: "Default work",
      }),
      {
        id: "card-ops",
        title: "Ops work",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { automation: { boardId: "ops" } },
      },
    ];
    renderView();
    const boardFilter = container.querySelector(".workboard-select--toolbar-board");
    expect(boardFilter?.textContent).toContain("Default board");
    expect(boardFilter?.textContent).toContain("Operations (ops)");
    expect(boardFilter?.textContent).toContain("Old work (archive)");

    changeWorkboardSelect(boardFilter, "ops");
    renderView();

    expect(onBoardFilterChange).toHaveBeenCalledWith("ops");
    expect(container.textContent).not.toContain("Default work");
    expect(container.textContent).toContain("Ops work");
  });

  it("shows the board switcher at two boards with icon, color, and fallback glyphs", () => {
    const { state, container, renderView } = createWorkboardView();
    state.boards = [
      { id: "default", total: 0, active: 0, archived: 0, byStatus: {} },
      {
        id: "ops",
        name: "Operations",
        icon: "⚙",
        color: "#22c55e",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
      },
    ];
    renderView();

    const boardFilter = container.querySelector(".workboard-select--toolbar-board");
    expect(boardFilter).not.toBeNull();
    const defaultGlyph = boardFilter?.querySelector(
      'wa-option[value="default"] .workboard-board-glyph',
    );
    const opsGlyph = boardFilter?.querySelector('wa-option[value="ops"] .workboard-board-glyph');
    expect(defaultGlyph?.textContent?.trim()).toBe("D");
    expect(opsGlyph?.textContent?.trim()).toBe("⚙");
    expect(opsGlyph?.getAttribute("style")).toContain("#22c55e");
  });

  it("keeps a deleted routed board filtered instead of exposing every board", () => {
    const { state, container, renderView } = createWorkboardView();
    state.boardFilter = "deleted";
    state.boards = [{ id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } }];
    state.cards = [
      createWorkboardCard({
        id: "default-card",
        title: "Default board work",
      }),
    ];
    renderView();

    expect(container.textContent).not.toContain("Default board work");
    expect(container.querySelector(".workboard-empty-state")).not.toBeNull();
  });

  it("filters cards by linked agent", () => {
    const agentsList: NonNullable<WorkboardRenderProps["agentsList"]> = {
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    };
    const { state, container, renderView } = createWorkboardView({ agentsList });
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
    renderView();

    const agentFilter = container.querySelector<
      HTMLElement & { options: Array<{ label: string }>; value: string }
    >(".workboard-agent-select--toolbar");
    expect(agentFilter?.options.map((option) => option.label)).toEqual([
      "All agents",
      "Unassigned (uses Main)",
      "Main (default)",
      "Ops",
      "workboard-dispatcher (not configured)",
    ]);

    selectWorkboardAgent(agentFilter, "ops");
    renderView();

    expect(container.textContent).not.toContain("Main work");
    expect(container.textContent).toContain("Ops work");
    expect(
      container.querySelector<HTMLElement & { value: string }>(".workboard-agent-select--toolbar")
        ?.value,
    ).toBe("ops");

    selectWorkboardAgent(
      container.querySelector(".workboard-agent-select--toolbar"),
      "workboard-dispatcher",
    );
    renderView();

    expect(container.textContent).not.toContain("Ops work");
    expect(container.textContent).toContain("Dispatcher work");
    expect(
      container.querySelector<HTMLElement & { value: string }>(".workboard-agent-select--toolbar")
        ?.value,
    ).toBe("workboard-dispatcher");
  });

  it("limits assignment choices to configured agents and preserves an unknown current assignee", () => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "main", name: "Main duplicate" },
          { id: "ops", name: "Ops" },
        ],
      },
    });
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
    renderView();

    const draft = container.querySelector<HTMLElement>(".workboard-draft");
    const agentSelect = draft?.querySelector<HTMLElement & { options: Array<{ label: string }> }>(
      ".workboard-agent-select",
    );
    expect(agentSelect?.options.map((option) => option.label)).toEqual([
      "Unassigned (uses Main)",
      "Main (default)",
      "Ops",
      "workboard-dispatcher (not configured)",
    ]);
  });

  it("renders the card modal with a single scrollable body and stable footer actions", () => {
    const { state, container, renderView } = createWorkboardView();
    state.draftOpen = true;
    state.draftTitle = "New task";
    renderView();

    const draft = container.querySelector(".workboard-draft");
    const body = draft?.querySelector(".workboard-draft__body");
    const footer = draft?.querySelector(":scope > .workboard-modal__actions");

    expect(body?.querySelector(".workboard-template-strip")).toBeTruthy();
    expect(body?.querySelector(".workboard-draft__meta")).toBeTruthy();
    expect(footer?.textContent).toContain("Create");
    expect(body?.contains(footer as Node)).toBe(false);
  });

  it("delegates modal select positioning and dismissal to Web Awesome", () => {
    const { state, container, renderView } = createWorkboardView();
    state.draftOpen = true;
    state.draftTitle = "New task";
    renderView();

    const selects = container.querySelectorAll(".workboard-draft wa-select");
    expect(selects.length).toBeGreaterThan(0);
    expect(container.querySelector(".workboard-select__menu")).toBeNull();
  });

  it("preflights model-specific starts for ACP runtime agents", () => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "per-sender",
        agents: [{ id: "main", name: "Main", agentRuntime: { id: "codex", source: "agent" } }],
      },
    });
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
    renderView();

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
    const { state, container, renderView } = createWorkboardView();
    state.detailCardId = "card-1";
    state.cards = [
      createWorkboardCard({
        title: "Archived selected task",
        metadata: { archivedAt: 2 },
      }),
    ];
    renderView();

    expect(container.querySelector(".workboard-detail")).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
  });

  it("keeps visible archived cards inspectable and restorable without move or drag controls", () => {
    const archivedCard = createWorkboardCard({
      title: "Archived historical task",
      metadata: { archivedAt: 10 },
    });
    const request = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
    });
    state.cards = [archivedCard];
    state.showArchived = true;
    renderView();

    const article = container.querySelector<HTMLElement>(".workboard-card--archived");
    expect(article).not.toBeNull();
    expect(article?.getAttribute("draggable")).toBe("false");
    expect(article?.querySelector(".workboard-card__move-select")).toBeNull();
    expect(buttonByLabel(article!, "Restore from archive")).not.toBeNull();
    expect(
      article!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(state.draggedCardId).toBeNull();

    state.draggedCardId = archivedCard.id;
    container
      .querySelector(".workboard-column--running")
      ?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(request).not.toHaveBeenCalled();

    state.draggedCardId = null;
    state.detailCardId = archivedCard.id;
    renderView();

    const drawer = container.querySelector<HTMLElement>(".workboard-detail");
    expect(drawer?.textContent).toContain(archivedCard.title);
    expect(drawer?.querySelector(".workboard-card__move-select")).toBeNull();
    expect(buttonByLabel(drawer!, "Restore from archive")).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("shows stale lifecycle on executed linked cards", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(60 * 60 * 1000);
    try {
      const { host, state } = createLoadedWorkboardState();
      state.cards = [
        createWorkboardCard({
          title: "Watch stale run",
          status: "running",
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
        }),
      ];
      const { container, renderView } = createWorkboardView(
        {
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
        },
        host,
      );
      renderView();

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
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        {
          key: "agent:main:dashboard:1",
          kind: "direct",
          displayName: "Dashboard session",
          updatedAt: 1,
          status: "running",
        },
      ],
    });
    state.cards = [
      createWorkboardCard({
        title: "Stop legacy run",
        status: "running",
        sessionKey: "agent:main:dashboard:1",
      }),
    ];
    renderView();

    expect(container.querySelector(".workboard-live")?.textContent).toContain("live");
    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
  });

  it.each([
    {
      scenario: "an execution-owned linked session",
      sessionKey: "agent:main:execution-linked-session",
      topLevelSessionKey: undefined,
    },
    {
      scenario: "the authoritative top-level session",
      sessionKey: "agent:main:top-level-linked-session",
      topLevelSessionKey: "agent:main:top-level-linked-session",
    },
  ])("preserves $scenario when editing a Workboard card", async (testCase) => {
    const card = createWorkboardCard({
      title: "Keep my linked session",
      ...(testCase.topLevelSessionKey ? { sessionKey: testCase.topLevelSessionKey } : {}),
      execution: createWorkboardExecution({
        sessionKey: "agent:main:execution-linked-session",
      }),
    });
    const request = vi.fn(async () => ({
      card: { ...card, title: "Renamed without unlinking", updatedAt: 2 },
    }));
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
      onRequestUpdate: () => undefined,
      sessions: [
        {
          key: testCase.sessionKey,
          kind: "direct",
          displayName: "Active linked session",
          updatedAt: 1,
          status: "running",
        },
      ],
    });
    state.cards = [card];
    state.detailCardId = card.id;

    renderView();
    const editButton = buttonByLabel(container, "Edit card");
    expect(editButton).not.toBeNull();
    editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(state.draftSessionKey).toBe(testCase.sessionKey);
    expect(
      [...container.querySelectorAll(".workboard-draft wa-select")].some(
        (select) =>
          select.querySelector("wa-option[selected]")?.getAttribute("value") ===
          testCase.sessionKey,
      ),
    ).toBe(true);

    const title = container.querySelector<HTMLInputElement>(".workboard-draft__title");
    expect(title).not.toBeNull();
    title!.value = "Renamed without unlinking";
    title!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".workboard-draft")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      patch: expect.objectContaining({
        title: "Renamed without unlinking",
        sessionKey: testCase.sessionKey,
      }),
    });
    expect(state.cards[0]?.execution?.sessionKey).toBe("agent:main:execution-linked-session");
    renderView();
    expect(container.querySelector("openclaw-workboard-card-dashboard")).not.toBeNull();
  });

  it("opens an edit modal and submits card updates", async () => {
    const { host, state } = createLoadedWorkboardState();
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
        ?.querySelector("wa-option[selected]")
        ?.getAttribute("value"),
    ).toBe("high");
  });

  it("locks edit-modal actions while a comment request is in flight", () => {
    const { host, state } = createLoadedWorkboardState();
    state.draftOpen = true;
    state.editingCardId = "card-1";
    state.draftTitle = "Rename me";
    state.draftCommentBody = "Ship after CI";
    state.busyCardIds.add("card-1");
    state.cards = [
      createWorkboardCard({
        title: "Rename me",
      }),
    ];
    const container = document.createElement("div");

    render(renderWorkboard(createWorkboardRenderProps(host)), container);

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find((button) => button.textContent?.includes("Create"))?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent?.includes("Save"))?.disabled).toBe(true);
  });

  it("adds operator notes from the details drawer", async () => {
    const { host, state } = createLoadedWorkboardState();
    state.cards = [
      createWorkboardCard({
        title: "Investigate proof gap",
        status: "review",
      }),
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
    const { host, state } = createLoadedWorkboardState();
    state.cards = [
      createWorkboardCard({
        title: "Archive me",
        status: "done",
      }),
    ];
    const request = vi.fn(async () => ({
      card: { ...state.cards[0], metadata: { archivedAt: 2 } },
    }));
    const container = document.createElement("div");

    render(
      renderWorkboard(
        createWorkboardRenderProps(host, {
          client: { request } as unknown as GatewayBrowserClient,
          onRequestUpdate: () => undefined,
        }),
      ),
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
    const { host, state } = createLoadedWorkboardState();
    state.draftOpen = true;
    const container = document.createElement("div");

    render(
      renderWorkboard(
        createWorkboardRenderProps(host, {
          sessions: [
            {
              key: "agent:main:dashboard:1",
              kind: "direct",
              displayName: "Existing session",
              updatedAt: 2,
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("No linked session");
    expect(container.textContent).toContain("Existing session");
  });

  it("shows a missing current session key instead of a false empty selection", () => {
    const { host, state } = createLoadedWorkboardState();
    state.draftOpen = true;
    state.draftSessionKey = "agent:main:archived-session";
    const container = document.createElement("div");

    render(renderWorkboard(createWorkboardRenderProps(host)), container);

    const sessionSelect = [
      ...(container
        .querySelector(".workboard-draft")
        ?.querySelectorAll<HTMLElement>(".workboard-select") ?? []),
    ].at(2);
    expect(sessionSelect?.querySelector("wa-option[selected]")?.getAttribute("value")).toBe(
      "agent:main:archived-session",
    );
    expect(
      sessionSelect?.querySelector('wa-option[value="agent:main:archived-session"]'),
    ).not.toBeNull();
  });

  it("does not offer synthetic heartbeat sessions when creating a card", () => {
    const { host, state } = createLoadedWorkboardState();
    state.draftOpen = true;
    const container = document.createElement("div");

    render(
      renderWorkboard(
        createWorkboardRenderProps(host, {
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
        }),
      ),
      container,
    );

    const sessionOptions = [
      ...(container
        .querySelector(".workboard-draft")
        ?.querySelectorAll<HTMLElement>(".workboard-select") ?? []),
    ].at(2);
    const labels = [...(sessionOptions?.querySelectorAll("wa-option") ?? [])].map((option) =>
      option.textContent?.trim(),
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

  it("shows the animated mascot while config enablement is unknown", () => {
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

    const loadingState = container.querySelector('[role="status"]');
    expect(loadingState?.getAttribute("aria-label")).toBe("Loading…");
    expect(loadingState?.querySelector("openclaw-mascot")?.getAttribute("mood")).toBe("thinking");
    expect(loadingState?.textContent?.trim()).toBe("");
    expect(container.textContent).not.toContain("Loading panel");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
