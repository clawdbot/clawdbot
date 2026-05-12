import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createLazyView, renderLazyView } from "./lazy-view.ts";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function expectButtonWithText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

describe("lazy view rendering", () => {
  it("renders a loading panel until the view module resolves", async () => {
    const onChange = vi.fn();
    const view = createLazyView(async () => ({ label: "Logs view" }), onChange);
    const container = document.createElement("div");

    render(
      renderLazyView(view, (mod) => mod.label),
      container,
    );

    expect(
      container.querySelector(".lazy-view-state--loading .card-title")?.textContent?.trim(),
    ).toBe("Loading panel");

    await flushPromises();
    render(
      renderLazyView(view, (mod) => mod.label),
      container,
    );

    expect(onChange).toHaveBeenCalled();
    expect(container.textContent?.trim()).toBe("Logs view");
  });

  it("renders a recoverable error panel when a lazy module import fails", async () => {
    const onChange = vi.fn();
    const loader = vi
      .fn<() => Promise<{ label: string }>>()
      .mockRejectedValueOnce(new Error("chunk 404"))
      .mockResolvedValueOnce({ label: "Recovered" });
    const view = createLazyView(loader, onChange);
    const container = document.createElement("div");

    render(
      renderLazyView(view, (mod) => mod.label),
      container,
    );
    await flushPromises();
    render(
      renderLazyView(view, (mod) => mod.label),
      container,
    );

    expect(
      container.querySelector(".lazy-view-state--error .card-title")?.textContent?.trim(),
    ).toBe("Panel failed to load");
    expect(container.querySelector(".lazy-view-state--error .callout")?.textContent?.trim()).toBe(
      "chunk 404",
    );

    const retry = expectButtonWithText(container, "Retry");
    retry.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    render(
      renderLazyView(view, (mod) => mod.label),
      container,
    );

    expect(loader).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalled();
    expect(container.textContent?.trim()).toBe("Recovered");
  });
});
