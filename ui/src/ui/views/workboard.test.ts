// Control UI tests cover workboard behavior.
import { nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { getWorkboardState } from "../controllers/workboard.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { renderWorkboard } from "./workboard.ts";

type WorkboardRenderProps = Parameters<typeof renderWorkboard>[0];

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function renderInto(container: HTMLElement, props: WorkboardRenderProps) {
  render(renderWorkboard(props), container);
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

describe("renderWorkboard", () => {
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
    expect(container.querySelector(".workboard-card__priority")?.textContent).toContain("high");
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
      .querySelector<HTMLButtonElement>('button[title="Delete card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenSession).not.toHaveBeenCalled();
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

      const modal = container.querySelector<HTMLElement>(".workboard-draft");
      const titleInput = container.querySelector<HTMLInputElement>(".workboard-draft__title");
      const main = container.querySelector<HTMLElement>(".workboard-main");
      expect(modal?.getAttribute("role")).toBe("dialog");
      expect(modal?.getAttribute("aria-modal")).toBe("true");
      expect(modal?.getAttribute("aria-labelledby")).toBe("workboard-card-modal-title");
      expect(modal?.getAttribute("aria-describedby")).toBe("workboard-card-modal-description");
      expect(container.querySelector("#workboard-card-modal-title")?.textContent).toContain(
        "New card",
      );
      expect(container.querySelector("#workboard-card-modal-description")?.textContent).toContain(
        "Queue work",
      );
      expect(document.activeElement).toBe(titleInput);
      expect(main?.hasAttribute("inert")).toBe(true);
      expect(main?.getAttribute("aria-hidden")).toBe("true");

      const cancel = [...modal!.querySelectorAll<HTMLButtonElement>("button")].at(-1);
      const close = modal!.querySelector<HTMLButtonElement>("button[aria-label='Cancel']");
      expect(cancel).toBeInstanceOf(HTMLButtonElement);
      expect(close).toBeInstanceOf(HTMLButtonElement);
      cancel?.focus();
      const tab = dispatchKey(cancel!, "Tab");
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(close);

      const shiftTab = dispatchKey(close!, "Tab", { shiftKey: true });
      expect(shiftTab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(cancel);

      dispatchKey(titleInput!, "Escape");
      await nextFrame();
      expect(container.querySelector(".workboard-draft")).toBeNull();
      expect(main?.hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(launcher);
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

      const drawer = container.querySelector<HTMLElement>(".workboard-detail-drawer");
      const main = container.querySelector<HTMLElement>(".workboard-main");
      expect(drawer?.getAttribute("role")).toBe("dialog");
      expect(drawer?.getAttribute("aria-modal")).toBe("true");
      expect(drawer?.getAttribute("aria-labelledby")).toBe("workboard-card-detail-title");
      expect(drawer?.getAttribute("aria-describedby")).toBe("workboard-card-detail-description");
      expect(container.querySelector("#workboard-card-detail-title")?.textContent).toContain(
        "Card details: Inspect drawer focus",
      );
      expect(container.querySelector("#workboard-card-detail-description")?.textContent).toContain(
        "Start or link a session",
      );
      expect(document.activeElement).toBe(drawer);
      expect(main?.hasAttribute("inert")).toBe(true);
      expect(main?.getAttribute("aria-hidden")).toBe("true");

      const close = drawer!.querySelector<HTMLButtonElement>("button[aria-label='Cancel']");
      const tab = dispatchKey(drawer!, "Tab");
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(close);

      const lastFocusable = [
        ...drawer!.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]"),
      ]
        .toReversed()
        .find((element) => !element.hasAttribute("disabled"));
      const shiftTab = dispatchKey(close!, "Tab", { shiftKey: true });
      expect(shiftTab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(lastFocusable);

      dispatchKey(drawer!, "Escape");
      await nextFrame();
      expect(container.querySelector(".workboard-detail-drawer")).toBeNull();
      expect(main?.hasAttribute("inert")).toBe(false);
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

      expect(document.activeElement).toBe(
        container.querySelector<HTMLElement>(".workboard-detail-drawer"),
      );

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
    expect(startButtons.map((button) => button.title)).toEqual(["Run default agent"]);
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");

    container
      .querySelector<HTMLButtonElement>('button[title="View details"]')
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
    expect(start?.title).toBe("Run default agent");

    childCard
      ?.querySelector<HTMLButtonElement>('button[title="View details"]')
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
    expect(startButtons.map((button) => button.title)).toEqual(["Run default agent"]);

    container
      .querySelector<HTMLButtonElement>('button[title="View details"]')
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
      .querySelector<HTMLButtonElement>('button[title="View details"]')
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
    expect(container.querySelector('button[title="Stop session"]')).not.toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");

    container
      .querySelector<HTMLButtonElement>('button[title="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Worker is active.",
    );
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
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

    expect(container.querySelector<HTMLButtonElement>('button[title="Edit card"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[title="Delete card"]')).toBeNull();
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
    state.busyCardId = "card-1";
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

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("New card");
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
      .querySelector<HTMLButtonElement>('button[title="View details"]')
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
      .querySelector<HTMLButtonElement>('button[title="Show archived cards"]')
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
    expect(
      container.querySelector<HTMLButtonElement>('button[title="Hide archived cards"]'),
    ).not.toBeNull();

    container
      .querySelector<HTMLButtonElement>('button[title="View details"]')
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

    const agentFilter = [...container.querySelectorAll<HTMLSelectElement>("select")].find(
      (select) => select.title === "Filter by agent",
    );
    agentFilter!.value = "ops";
    agentFilter!.dispatchEvent(new Event("change", { bubbles: true }));
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
    expect(container.textContent).toContain("Ops");
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
    expect(engineButtons[0]?.title).toContain("uses the codex ACP runtime");
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
      expect(container.querySelector('button[title="Stop session"]')).toBeNull();
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
    expect(container.querySelector('button[title="Stop session"]')).not.toBeNull();
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
      .querySelector<HTMLButtonElement>('button[title="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Edit card");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Needs owner check");
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
      ...container.querySelectorAll<HTMLSelectElement>(".workboard-draft__meta select"),
    ].at(1);
    priority!.value = "high";
    priority!.dispatchEvent(new Event("change", { bubbles: true }));
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
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    container
      .querySelector<HTMLButtonElement>('button[title="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Renamed",
    );
    expect(
      [...container.querySelectorAll<HTMLSelectElement>(".workboard-draft__meta select")].at(1)
        ?.value,
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
    state.busyCardId = "card-1";
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
      .querySelector<HTMLButtonElement>('button[title="View details"]')
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
      .querySelector<HTMLButtonElement>('button[title="Archive card"]')
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
      ...container.querySelectorAll<HTMLSelectElement>(".workboard-draft__meta select"),
    ].at(3);
    const labels = [...(sessionOptions?.querySelectorAll("option") ?? [])].map((option) =>
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

  it("does not retry a failed initial load on every render", async () => {
    const host = {};
    const container = document.createElement("div");
    const request = vi.fn(async () => {
      throw new Error("workboard unavailable");
    });
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

    render(renderWorkboard(props), container);
    await Promise.resolve();
    await Promise.resolve();
    render(renderWorkboard(props), container);
    await Promise.resolve();

    expect(request).toHaveBeenCalledOnce();
    expect(getWorkboardState(host).error).toBe("workboard unavailable");
  });
});
