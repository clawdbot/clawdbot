import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createLazyView, renderLazyView } from "./lazy-view.ts";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
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

    expect(container.textContent).toContain("Loading panel");

    await flushPromises();
    render(
      renderLazyView(view, (mod) => mod.label),
      container,
    );

    expect(onChange).toHaveBeenCalled();
    expect(container.textContent).toContain("Logs view");
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

    expect(container.textContent).toContain("Panel failed to load");
    expect(container.textContent).toContain("chunk 404");

    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).not.toBeUndefined();
    retry?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    render(
      renderLazyView(view, (mod) => mod.label),
      container,
    );

    expect(loader).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalled();
    expect(container.textContent).toContain("Recovered");
  });
});
