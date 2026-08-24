/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderHubTabs } from "./hub-tabs.ts";

describe("renderHubTabs", () => {
  it("renders counts, badges, and the reduced sub variant", () => {
    const container = document.createElement("div");
    render(
      renderHubTabs({
        id: "example",
        active: "files",
        tabs: [
          { value: "files", label: "Files", count: 3 },
          { value: "memory", label: "Memory", badge: "New" },
        ],
        ariaLabel: "Example sections",
        panelId: "example-panel",
        variant: "sub",
        onSelect: () => undefined,
      }),
      container,
    );
    expect(container.querySelector("wa-tab-group")?.classList).toContain("hub-tabs--sub");
    expect(container.querySelector("#example-tab-files")?.hasAttribute("active")).toBe(true);
    expect(container.querySelector(".hub-tab__badge--count")?.textContent).toBe("3");
    expect(container.querySelector("#example-tab-memory .hub-tab__badge")?.textContent).toBe("New");
  });

  it("forwards the aria-label to the shadow tablist", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    try {
      render(
        renderHubTabs({
          id: "example",
          active: "files",
          tabs: [{ value: "files", label: "Files" }],
          ariaLabel: "Example sections",
          panelId: "example-panel",
          onSelect: () => undefined,
        }),
        container,
      );
      const group = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
        "wa-tab-group",
      );
      await group?.updateComplete;
      // syncTabGroupLabel resolves on the same updateComplete chain; yield once more.
      await group?.updateComplete;
      expect(group?.shadowRoot?.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(
        "Example sections",
      );
    } finally {
      container.remove();
    }
  });

  it("selects only enabled tabs from direct user activation", () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");
    render(
      renderHubTabs({
        id: "example",
        active: "first",
        tabs: [
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
          { value: "disabled", label: "Disabled", disabled: true },
        ],
        ariaLabel: "Example sections",
        panelId: "example-panel",
        onSelect,
      }),
      container,
    );

    container
      .querySelector("#example-tab-second")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    container
      .querySelector("#example-tab-disabled")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    container.querySelector("wa-tab-group")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        composed: true,
        detail: { name: "disabled" },
      }),
    );

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("second");
    expect(container.querySelector("wa-tab-group")?.getAttribute("activation")).toBe("manual");
  });

  it("preserves an intentional no-selection state", () => {
    const container = document.createElement("div");
    render(
      renderHubTabs({
        id: "example",
        active: null,
        tabs: [
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ],
        ariaLabel: "Example sections",
        panelId: "example-panel",
        onSelect: () => undefined,
      }),
      container,
    );

    const group = container.querySelector<HTMLElement & { active: string }>("wa-tab-group");
    expect(group?.active).not.toBe("");
    expect(group?.active).not.toBe("first");
    expect(container.querySelector("wa-tab[active]")).toBeNull();
    expect(container.querySelector<HTMLElement>("#example-tab-first")?.tabIndex).toBe(0);
    expect(container.querySelector<HTMLElement>("#example-tab-second")?.tabIndex).toBe(-1);
  });
});
