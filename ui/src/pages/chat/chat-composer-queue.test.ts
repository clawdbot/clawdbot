/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("chat composer steering queue", () => {
  it.each([
    { sendState: "steering" as const, sendRunId: "send-1" },
    { pendingRunId: "run-1", sendRunId: "send-1" },
  ])("renders one Steering badge for an in-flight or acknowledged steer", (steerState) => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatQueue({
        queue: [
          {
            id: "steer-1",
            text: "change course",
            createdAt: 1,
            kind: "steered",
            ...steerState,
          },
        ],
        onQueueRemove: vi.fn(),
      }),
      container,
    );

    const badges = container.querySelectorAll(".chat-queue__badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent?.trim()).toBe(t("chat.queue.states.steering"));
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
    expect([...rows].map((row) => row.getAttribute("draggable"))).toEqual(["true", "true"]);
    const grips = [...container.querySelectorAll(".chat-queue__grip")];
    expect(grips).toHaveLength(2);
    expect(grips[0]?.tagName).toBe("BUTTON");
    expect(grips[0]?.getAttribute("aria-label")).toBe(t("chat.queue.reorderQueuedMessage"));
    expect(grips[0]?.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");
    // The row carries no overflow menu: the handle is the whole reorder surface.
    expect(container.querySelector("wa-dropdown")).toBeNull();
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
    expect(container.querySelector(".chat-queue__item")?.getAttribute("draggable")).toBe("false");
  });

  it("reserves the handle column on every row so the pills never shift", () => {
    const container = renderQueue({
      queue: [
        { id: "steer", text: "steer", createdAt: 1, kind: "steered", pendingRunId: "run-1" },
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

  it("holds every action slot inert while one edit is open", () => {
    const onQueueEdit = vi.fn();
    const onQueueRemove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3)],
      editingId: "b",
      onQueueEdit,
      onQueueMove: vi.fn(),
      onQueueRemove,
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    // Every row keeps both buttons, so no column shifts while the edit is open.
    for (const selector of [".chat-queue__edit", ".chat-queue__remove"]) {
      const present = rows.map((row) => row.querySelector(selector) !== null);
      expect(present).toEqual([true, true, true]);
    }
    // One edit at a time, so every pencil waits; discarding another row is still
    // safe, so only the edited row's X goes inert.
    const disabled = (selector: string) =>
      rows.map((row) => row.querySelector(selector)!.hasAttribute("disabled"));
    expect(disabled(".chat-queue__edit")).toEqual([true, true, true]);
    expect(disabled(".chat-queue__remove")).toEqual([false, true, false]);

    rows[0]?.querySelector<HTMLButtonElement>(".chat-queue__edit")?.click();
    rows[1]?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueEdit).not.toHaveBeenCalled();
    expect(onQueueRemove).not.toHaveBeenCalled();

    rows[2]?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledWith("c");
  });

  it("keeps a row that already joined a run out of the reorder set", () => {
    const container = renderQueue({
      queue: [
        { id: "steer", text: "steer", createdAt: 1, kind: "steered", pendingRunId: "run-1" },
        waiting("b", 2),
        waiting("c", 3),
      ],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    expect(rows.map((row) => row.getAttribute("draggable"))).toEqual(["false", "true", "true"]);
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
    expect(rows.map((row) => row.getAttribute("draggable"))).toEqual([
      "false",
      "false",
      "true",
      "true",
    ]);

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
