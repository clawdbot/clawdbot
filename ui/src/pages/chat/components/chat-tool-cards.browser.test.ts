import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

let container: HTMLDivElement | undefined;
afterEach(() => {
  if (container) {
    render(nothing, container);
    container.remove();
    container = undefined;
  }
});

describe.runIf("__vitest_browser__" in globalThis)("narrow tool activity rows", () => {
  it("truncates long progress receipts while keeping short tool labels intact", () => {
    container = document.body.appendChild(document.createElement("div"));
    container.style.width = "220px";
    const step = "Verify the implementation and report the result. ".repeat(12).slice(0, 512);
    const options = { messageKey: "narrow", expanded: false, onToggleExpanded: vi.fn() };
    render(
      html`
        ${renderToolCard(
          {
            id: "receipt",
            name: "progress_card",
            args: { plan: [{ step, status: "completed" }] },
            completed: true,
          },
          options,
        )}
        ${renderToolCard(
          { id: "yield", name: "yield", args: { message: step }, completed: true },
          options,
        )}
      `,
      container,
    );

    const receipt = container.querySelector<HTMLElement>('[role="status"]')!;
    const text = receipt.querySelector<HTMLElement>(":scope > span:last-child")!;
    expect(receipt.textContent).toContain(step);
    expect(receipt.clientWidth).toBeGreaterThan(0);
    expect(receipt.scrollWidth).toBe(receipt.clientWidth);
    expect(container.scrollWidth).toBe(container.clientWidth);
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");

    const label = Array.from(
      container.querySelectorAll<HTMLElement>(".chat-tool-msg-summary__label"),
    ).find((element) => element.textContent === "Yield")!;
    expect(label).toBeDefined();
    expect(label.scrollWidth).toBe(label.clientWidth);
  });
});
