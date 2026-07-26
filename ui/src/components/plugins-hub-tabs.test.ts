/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderPluginsHubTabs } from "./plugins-hub-tabs.ts";

type PluginsHubTabsProps = Parameters<typeof renderPluginsHubTabs>[0];

async function mount(props: PluginsHubTabsProps): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPluginsHubTabs(props), container);
  const group = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "wa-tab-group",
  );
  await group?.updateComplete;
  return container;
}

describe("renderPluginsHubTabs", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders all hub tabs with the active tab selected", async () => {
    const container = await mount({
      active: "skills",
      installedCount: 4,
      onSelect: () => undefined,
    });
    const tabs = [...container.querySelectorAll<HTMLElement>("wa-tab")];
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

  it("omits the installed count badge when no catalog data is provided", async () => {
    const container = await mount({ active: "workshop", onSelect: () => undefined });
    expect(container.querySelector("#plugins-tab-installed span")).toBeNull();
  });

  it("selects tabs on click", async () => {
    const onSelect = vi.fn();
    const container = await mount({ active: "installed", onSelect });
    container
      .querySelector<HTMLButtonElement>("#plugins-tab-workshop")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith("workshop");
  });

  it("uses manual Web Awesome activation for cross-route tabs", async () => {
    const onSelect = vi.fn();
    const container = await mount({ active: "installed", onSelect });
    const group = container.querySelector("wa-tab-group");
    const installed = container.querySelector<HTMLElement>("#plugins-tab-installed");

    expect(group?.getAttribute("activation")).toBe("manual");
    installed?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hands focus to the destination strip after keyboard activation", async () => {
    const onSelect = vi.fn();
    const source = await mount({ active: "installed", onSelect });
    const target = source.querySelector<HTMLElement>("#plugins-tab-workshop");
    target?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
    );
    source.querySelector("wa-tab-group")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        composed: true,
        detail: { name: "workshop" },
      }),
    );
    expect(onSelect).toHaveBeenLastCalledWith("workshop");

    source.remove();
    const destination = await mount({ active: "workshop", onSelect: () => undefined });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        destination.querySelector<HTMLElement>("#plugins-tab-workshop"),
      );
    });
  });

  it("hands focus to the destination strip after synthesized activation", async () => {
    const source = await mount({ active: "installed", onSelect: () => undefined });
    source.querySelector("wa-tab-group")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        composed: true,
        detail: { name: "discover" },
      }),
    );
    source.remove();

    const destination = await mount({ active: "discover", onSelect: () => undefined });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        destination.querySelector<HTMLElement>("#plugins-tab-discover"),
      );
    });
  });

  it("does not queue focus recovery for same-tab keyboard activation", async () => {
    const container = await mount({ active: "installed", onSelect: () => undefined });
    const installed = container.querySelector<HTMLElement>("#plugins-tab-installed");
    installed?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
    );
    container.querySelector("wa-tab-group")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        composed: true,
        detail: { name: "installed" },
      }),
    );

    // A later re-render of the strip must not reclaim focus from whatever
    // control the user moved on to.
    container.remove();
    const rerendered = await mount({ active: "installed", onSelect: () => undefined });
    await Promise.resolve();
    expect(document.activeElement).not.toBe(
      rerendered.querySelector<HTMLElement>("#plugins-tab-installed"),
    );
  });

  it("does not steal focus after mouse activation", async () => {
    const source = await mount({ active: "installed", onSelect: () => undefined });
    source
      .querySelector<HTMLElement>("#plugins-tab-skills")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1 }));
    source.querySelector("wa-tab-group")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        composed: true,
        detail: { name: "skills" },
      }),
    );
    source.remove();

    const destination = await mount({ active: "skills", onSelect: () => undefined });
    await Promise.resolve();
    expect(document.activeElement).not.toBe(
      destination.querySelector<HTMLElement>("#plugins-tab-skills"),
    );
  });

  it("clears a same-tab pointer source when keyboard navigation follows", async () => {
    const source = await mount({ active: "installed", onSelect: () => undefined });
    const active = source.querySelector<HTMLElement>("#plugins-tab-installed");
    active?.dispatchEvent(new MouseEvent("click", { detail: 1 }));
    active?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }),
    );
    source.querySelector("wa-tab-group")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        composed: true,
        detail: { name: "discover" },
      }),
    );
    source.remove();

    const destination = await mount({ active: "discover", onSelect: () => undefined });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        destination.querySelector<HTMLElement>("#plugins-tab-discover"),
      );
    });
  });
});
