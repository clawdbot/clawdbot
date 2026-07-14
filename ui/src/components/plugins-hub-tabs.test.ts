/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderPluginsHubTabs } from "./plugins-hub-tabs.ts";

type PluginsHubTabsProps = Parameters<typeof renderPluginsHubTabs>[0];

function mount(props: PluginsHubTabsProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPluginsHubTabs(props), container);
  return container;
}

describe("renderPluginsHubTabs", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders all hub tabs with the active tab selected", () => {
    const container = mount({ active: "skills", installedCount: 4, onSelect: () => undefined });
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.id)).toEqual([
      "plugins-tab-installed",
      "plugins-tab-discover",
      "plugins-tab-skills",
      "plugins-tab-workshop",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(container.querySelector("#plugins-tab-installed")?.textContent).toContain("4");
  });

  it("omits the installed count badge when no catalog data is provided", () => {
    const container = mount({ active: "workshop", onSelect: () => undefined });
    expect(container.querySelector("#plugins-tab-installed span")).toBeNull();
  });

  it("selects tabs on click", () => {
    const onSelect = vi.fn();
    const container = mount({ active: "installed", onSelect });
    container
      .querySelector<HTMLButtonElement>("#plugins-tab-workshop")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith("workshop");
  });

  it("moves focus with arrow keys without activating cross-route tabs", () => {
    const onSelect = vi.fn();
    const container = mount({ active: "installed", onSelect });
    const installed = container.querySelector<HTMLButtonElement>("#plugins-tab-installed")!;
    const discover = container.querySelector<HTMLButtonElement>("#plugins-tab-discover")!;
    const workshop = container.querySelector<HTMLButtonElement>("#plugins-tab-workshop")!;

    expect([installed.tabIndex, discover.tabIndex]).toEqual([0, -1]);
    installed.focus();
    installed.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(discover);

    discover.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(workshop);

    workshop.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(installed);

    // Manual activation: arrowing never selects; activation stays on
    // click/Enter so cross-route tabs cannot unmount the strip under focus.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hands focus to the destination strip after keyboard activation", async () => {
    const onSelect = vi.fn();
    const source = mount({ active: "installed", onSelect });
    // element.click() dispatches with detail 0, matching keyboard activation.
    source.querySelector<HTMLButtonElement>("#plugins-tab-workshop")?.click();
    expect(onSelect).toHaveBeenLastCalledWith("workshop");

    source.remove();
    const destination = mount({ active: "workshop", onSelect: () => undefined });
    // Focus lands on a microtask once the rendered strip is connected.
    await Promise.resolve();
    expect(document.activeElement).toBe(
      destination.querySelector<HTMLButtonElement>("#plugins-tab-workshop"),
    );
  });

  it("does not queue focus recovery for same-tab keyboard activation", async () => {
    const container = mount({ active: "installed", onSelect: () => undefined });
    container.querySelector<HTMLButtonElement>("#plugins-tab-installed")?.click();

    // A later re-render of the strip must not reclaim focus from whatever
    // control the user moved on to.
    container.remove();
    const rerendered = mount({ active: "installed", onSelect: () => undefined });
    await Promise.resolve();
    expect(document.activeElement).not.toBe(
      rerendered.querySelector<HTMLButtonElement>("#plugins-tab-installed"),
    );
  });

  it("does not steal focus after mouse activation", async () => {
    const source = mount({ active: "installed", onSelect: () => undefined });
    source
      .querySelector<HTMLButtonElement>("#plugins-tab-skills")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    source.remove();

    const destination = mount({ active: "skills", onSelect: () => undefined });
    await Promise.resolve();
    expect(document.activeElement).not.toBe(
      destination.querySelector<HTMLButtonElement>("#plugins-tab-skills"),
    );
  });
});
