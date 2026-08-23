/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat composer steering queue", () => {
  it("renders the durable steer mode without a run-bound state", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatQueue({
        queue: [
          {
            id: "steer-1",
            text: "change course",
            createdAt: 1,
            queueMode: "steer",
            sendState: "waiting-idle",
          },
        ],
        onQueueRemove: vi.fn(),
      }),
      container,
    );

    const badges = container.querySelectorAll(".chat-queue__badge");
    expect(badges).toHaveLength(2);
    expect(badges[0]?.textContent?.trim()).toBe(t("chat.queue.steer"));
    expect(badges[1]?.textContent?.trim()).toBe(t("chat.queue.states.waitingForRun"));
    const icon = container.querySelector(".chat-queue__icon");
    expect(icon?.querySelector('path[d="M12 19V5m-7 7 7-7 7 7"]')).not.toBeNull();
    expect(icon?.querySelector("circle")).toBeNull();
  });

  it("keeps a failed steer visually classified as an error", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatQueue({
        queue: [
          {
            id: "failed-steer",
            text: "change course",
            createdAt: 1,
            queueMode: "steer",
            sendState: "failed",
            sendError: "steer rejected",
          },
        ],
        onQueueRemove: vi.fn(),
      }),
      container,
    );

    const row = container.querySelector(".chat-queue__item");
    expect(row?.classList.contains("chat-queue__item--failed")).toBe(true);
    const icon = row?.querySelector(".chat-queue__icon");
    expect(icon?.querySelector('path[d^="m21.73 18"]')).not.toBeNull();
    expect(icon?.querySelector('path[d="M12 19V5m-7 7 7-7 7 7"]')).toBeNull();
    expect(container.querySelector(".chat-queue__badge--steered")).toBeNull();
    expect(row?.querySelector(".chat-queue__error .chat-queue__badge")?.textContent?.trim()).toBe(
      t("common.failed"),
    );
  });
});

function renderQueue(props: Parameters<typeof renderChatQueue>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderChatQueue(props), container);
  return container;
}

const waiting = (id: string, createdAt: number) => ({
  id,
  text: id,
  createdAt,
  sendState: "waiting-reconnect" as const,
});

describe("chat composer queue reordering", () => {
  it("puts reordering on one focusable handle for pointer and keyboard alike", () => {
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2)],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    const rows = container.querySelectorAll(".chat-queue__item");
    expect(rows).toHaveLength(2);
    expect([...rows].map((row) => row.getAttribute("draggable"))).toEqual([null, null]);
    const grips = [...container.querySelectorAll(".chat-queue__grip")];
    expect(grips).toHaveLength(2);
    expect(grips[0]?.tagName).toBe("BUTTON");
    expect(grips[0]?.getAttribute("aria-label")).toBe(t("chat.queue.reorderQueuedMessage"));
    expect(grips[0]?.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");
    expect(grips.map((grip) => grip.getAttribute("draggable"))).toEqual(["true", "true"]);
    expect(grips[0]?.querySelector(".chat-queue__grip-state--idle")).not.toBeNull();
    expect(grips[0]?.querySelector(".chat-queue__grip-state--active")).not.toBeNull();
    expect(container.querySelectorAll("wa-dropdown")).toHaveLength(0);
  });

  it("caps long queues and records both scroll boundaries", () => {
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3), waiting("d", 4)],
      onQueueRemove: vi.fn(),
    });
    const scroll = container.querySelector<HTMLElement>(".chat-queue__scroll")!;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 149 },
      scrollHeight: { configurable: true, value: 220 },
    });

    expect(scroll.dataset.scrollable).toBe("true");
    expect(scroll.dataset.atStart).toBe("true");
    expect(scroll.dataset.atEnd).toBe("false");
    scroll.scrollTop = 24;
    scroll.dispatchEvent(new Event("scroll"));
    expect(scroll.dataset.atStart).toBe("false");
    expect(scroll.dataset.atEnd).toBe("false");
    scroll.scrollTop = 71;
    scroll.dispatchEvent(new Event("scroll"));
    expect(scroll.dataset.atEnd).toBe("true");
  });

  it("auto-scrolls a long queue while a drag stays near its edge", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3), waiting("d", 4)],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });
    const scroll = container.querySelector<HTMLElement>(".chat-queue__scroll")!;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    scroll.scrollTop = 10;
    const dragOver = new Event("dragover", { bubbles: true });
    Object.defineProperties(dragOver, {
      clientY: { value: 99 },
      dataTransfer: { value: { types: ["application/x-openclaw-queued-message"] } },
    });
    scroll.dispatchEvent(dragOver);
    expect(requestFrame).toHaveBeenCalledOnce();
    frames.shift()?.(0);
    expect(scroll.scrollTop).toBeGreaterThan(10);

    const dragLeave = new Event("dragleave", { bubbles: true });
    Object.defineProperty(dragLeave, "relatedTarget", { value: null });
    scroll.dispatchEvent(dragLeave);
    expect(cancelFrame).toHaveBeenCalled();
  });

  it.each([
    { key: "ArrowUp", expected: ["c", 1] },
    { key: "ArrowDown", expected: ["c", 3] },
  ])("moves the focused row on $key", ({ key, expected }) => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3), waiting("d", 4)],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });
    const grip = container.querySelectorAll(".chat-queue__grip")[2]!;

    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    grip.dispatchEvent(event);

    expect(onQueueMove.mock.calls).toEqual([expected]);
    // Arrow keys belong to the handle here, so the transcript must not scroll.
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves other keys alone on the handle", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2)],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    container.querySelector(".chat-queue__grip")!.dispatchEvent(event);

    expect(onQueueMove).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("hides reorder affordances when there is nothing to reorder against", () => {
    const container = renderQueue({
      queue: [waiting("only", 1)],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    expect(container.querySelector(".chat-queue__grip")).toBeNull();
    expect(container.querySelector(".chat-queue__item")?.getAttribute("draggable")).toBeNull();
  });

  it("reserves the handle column on every row so the pills never shift", () => {
    const container = renderQueue({
      queue: [
        { id: "pending", text: "pending", createdAt: 1, pendingRunId: "run-1" },
        waiting("b", 2),
        waiting("c", 3),
      ],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    const grips = [...container.querySelectorAll(".chat-queue__item")].map((row) =>
      row.querySelector(".chat-queue__grip"),
    );
    // Every row keeps the column; only the rows that may move keep it live.
    expect(grips.every((grip) => grip !== null)).toBe(true);
    expect(grips.map((grip) => grip!.hasAttribute("disabled"))).toEqual([true, false, false]);
    expect(grips[0]?.getAttribute("aria-label")).toBe(t("chat.queue.reorderUnavailable"));
    expect(grips[0]?.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("holds the column with an inert handle on the row being edited", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3)],
      editingId: "b",
      onQueueMove,
      onQueueRemove: vi.fn(),
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    const grips = rows.map((row) => row.querySelector(".chat-queue__grip"));
    expect(grips.every((grip) => grip !== null)).toBe(true);
    // The edited row holds the drain, so it splits the queue: neither neighbour
    // has anywhere to go, and every handle waits without leaving the column.
    expect(grips.map((grip) => grip!.hasAttribute("disabled"))).toEqual([true, true, true]);
    expect(rows[1]?.classList.contains("chat-queue__item--editing")).toBe(true);

    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    grips[1]!.dispatchEvent(event);

    expect(onQueueMove).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders the inline editor while keeping other rows actionable", () => {
    const onQueueEdit = vi.fn();
    const onQueueSteer = vi.fn();
    const onQueueRemove = vi.fn();
    const container = renderQueue({
      canAbort: true,
      queue: [
        { id: "a", text: "a", createdAt: 1, sendState: "waiting-idle" },
        { id: "b", text: "b", createdAt: 2, sendState: "waiting-idle" },
        { id: "c", text: "c", createdAt: 3, sendState: "waiting-idle" },
      ],
      editingId: "b",
      onQueueEdit,
      onQueueSteer,
      onQueueMove: vi.fn(),
      onQueueRemove,
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    expect(rows.map((row) => row.querySelector("wa-dropdown") !== null)).toEqual([
      true,
      false,
      true,
    ]);
    expect(rows[1]?.querySelector(".chat-queue__edit-input")).not.toBeNull();
    expect(rows[1]?.querySelector(".chat-queue__edit-submit")).not.toBeNull();
    expect(rows[1]?.querySelector(".chat-queue__edit-cancel")).not.toBeNull();
    expect(rows.map((row) => row.querySelector(".chat-queue__action") !== null)).toEqual([
      true,
      false,
      true,
    ]);

    const disabled = (selector: string) =>
      rows.map((row) => row.querySelector(selector)?.hasAttribute("disabled") ?? false);
    expect(disabled("wa-dropdown-item")).toEqual([true, false, true]);
    expect(disabled(".chat-queue__more")).toEqual([true, false, true]);
    expect(disabled(".chat-queue__remove")).toEqual([false, false, false]);

    rows[2]?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledWith("c");
  });

  it("omits overflow for a local command with no available action", () => {
    const container = renderQueue({
      queue: [
        {
          id: "local-command",
          text: "/compact",
          createdAt: 1,
          localCommandName: "compact",
          sendState: "waiting-idle",
        },
      ],
      onQueueEdit: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    expect(container.querySelector(".chat-queue__more")).toBeNull();
    expect(container.querySelector("wa-dropdown-item")).toBeNull();
  });

  it("routes inline draft changes, submit, cancel, and keyboard shortcuts", () => {
    const onQueueEditChange = vi.fn();
    const onQueueEditSubmit = vi.fn();
    const onQueueEditCancel = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1)],
      editingId: "a",
      editingText: "a draft",
      onQueueEditChange,
      onQueueEditSubmit,
      onQueueEditCancel,
      onQueueRemove: vi.fn(),
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input")!;
    expect(editor.value).toBe("a draft");
    editor.dispatchEvent(new FocusEvent("focus"));
    expect(editor.selectionStart).toBe(editor.value.length);
    editor.value = "updated draft";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onQueueEditChange).toHaveBeenCalledWith("updated draft");
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onQueueEditCancel).toHaveBeenCalledOnce();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(onQueueEditSubmit).not.toHaveBeenCalled();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onQueueEditSubmit).toHaveBeenCalledOnce();
  });

  it("leaves queue editor shortcuts to an active IME composition", () => {
    const onQueueEditSubmit = vi.fn();
    const onQueueEditCancel = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1)],
      editingId: "a",
      onQueueEditSubmit,
      onQueueEditCancel,
      onQueueRemove: vi.fn(),
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input")!;
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    const legacyImeEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      keyCode: 229,
    });

    editor.dispatchEvent(composingEnter);
    editor.dispatchEvent(legacyImeEscape);

    expect(composingEnter.defaultPrevented).toBe(false);
    expect(legacyImeEscape.defaultPrevented).toBe(false);
    expect(onQueueEditSubmit).not.toHaveBeenCalled();
    expect(onQueueEditCancel).not.toHaveBeenCalled();
  });

  it("projects an offline queue row as waiting for reconnect", () => {
    const container = renderQueue({
      offline: true,
      queue: [{ id: "a", text: "a", createdAt: 1, sendState: "waiting-idle" }],
      onQueueRemove: vi.fn(),
    });

    const row = container.querySelector(".chat-queue__item");
    expect(row?.classList.contains("chat-queue__item--reconnect")).toBe(true);
    expect(row?.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe(
      t("chat.queue.states.waitingForReconnect"),
    );
  });

  it.each([
    { sendState: "failed" as const, label: t("common.failed") },
    { sendState: "unconfirmed" as const, label: t("chat.queue.states.needsReview") },
  ])("keeps an offline $sendState row terminal with its diagnostic", ({ sendState, label }) => {
    const container = renderQueue({
      offline: true,
      queue: [
        {
          id: sendState,
          text: sendState,
          createdAt: 1,
          sendError: `${sendState} diagnostic`,
          sendState,
        },
      ],
      onQueueRemove: vi.fn(),
    });

    const row = container.querySelector(".chat-queue__item");
    expect(row?.classList.contains("chat-queue__item--failed")).toBe(true);
    expect(row?.classList.contains("chat-queue__item--reconnect")).toBe(false);
    expect(row?.querySelector(".chat-queue__error .chat-queue__badge")?.textContent?.trim()).toBe(
      label,
    );
    expect(row?.querySelector(".chat-queue__error-text")?.textContent).toBe(
      `${sendState} diagnostic`,
    );
  });

  it("keeps a row that already joined a run out of the reorder set", () => {
    const container = renderQueue({
      queue: [
        { id: "pending", text: "pending", createdAt: 1, pendingRunId: "run-1" },
        waiting("b", 2),
        waiting("c", 3),
      ],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    expect(
      rows.map((row) => row.querySelector(".chat-queue__grip")?.getAttribute("draggable")),
    ).toEqual(["false", "true", "true"]);
  });

  it("offers no move to a row alone between locked rows, and refuses a drop from across one", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [
        waiting("a", 1),
        { id: "locked", text: "locked", createdAt: 2, sendState: "unconfirmed" },
        waiting("b", 3),
        waiting("c", 4),
      ],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    // "a" is a segment of one, so it has nothing to move against.
    expect(
      rows.map((row) => row.querySelector(".chat-queue__grip")?.getAttribute("draggable")),
    ).toEqual(["false", "false", "true", "true"]);

    const dataTransfer = {
      types: ["application/x-openclaw-queued-message"],
      getData: () => "c",
      setData: vi.fn(),
      dropEffect: "none",
      effectAllowed: "none",
    };
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    rows[0]!.dispatchEvent(drop);

    expect(onQueueMove).not.toHaveBeenCalled();
  });

  it("reports the drop position of the row the message was dropped on", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3)],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });
    const rows = [...container.querySelectorAll(".chat-queue__item")];
    const dataTransfer = {
      types: ["application/x-openclaw-queued-message"],
      getData: () => "c",
      setData: vi.fn(),
      dropEffect: "none",
      effectAllowed: "none",
    };

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    rows[0]!.dispatchEvent(drop);

    expect(onQueueMove.mock.calls).toEqual([["c", 0]]);
  });
});
