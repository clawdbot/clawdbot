/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./catalog-session-menu.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";

type CatalogMenuElement = HTMLElement & { updateComplete: Promise<boolean> };
type CatalogMenuItem = HTMLElement & { disabled: boolean; updateComplete: Promise<unknown> };

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("catalog session menu", () => {
  it("renders an anchored Web Awesome dropdown and focuses the first item", async () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(
      html`<openclaw-catalog-session-menu .lastActive=${"57d"}></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    const dropdown = menu.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
    const items = [...menu.querySelectorAll<CatalogMenuItem>("wa-dropdown-item")];

    await Promise.resolve();
    expect(dropdown?.open).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(items.map((item) => item.getAttribute("value"))).toEqual(["viewer", "terminal"]);
    expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  });

  it.each([
    [0, "viewer"],
    [1, "terminal"],
  ] as const)("dispatches item %s before synchronous close", async (index, expected) => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    let backingState: { open: true } | null = { open: true };
    const order: string[] = [];
    const onAction = vi.fn((action: CatalogSessionMenuAction) => {
      order.push(backingState ? action : "cleared");
    });
    render(
      html`<openclaw-catalog-session-menu
        .onAction=${onAction}
        .onClose=${() => {
          backingState = null;
          order.push("close");
        }}
      ></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;

    menu.querySelectorAll<CatalogMenuItem>("wa-dropdown-item")[index]?.click();

    expect(onAction).toHaveBeenCalledWith(expected);
    expect(order).toEqual([expected, "close"]);
    expect(backingState).toBeNull();
  });

  it("disables terminal selection with the unavailable reason", async () => {
    const onAction = vi.fn();
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(
      html`<openclaw-catalog-session-menu
        .terminalDisabled=${true}
        .onAction=${onAction}
      ></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    const terminal = menu.querySelector<CatalogMenuItem>('wa-dropdown-item[value="terminal"]');

    expect(terminal?.disabled).toBe(true);
    expect(terminal?.title).toBe("Terminal opening is unavailable for this thread.");
    terminal?.click();
    expect(onAction).not.toHaveBeenCalled();
  });
});
