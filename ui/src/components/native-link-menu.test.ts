/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeLinkMenu, type NativeLinkMenuAction } from "./native-link-menu.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

async function mountMenu(options: {
  trigger?: HTMLAnchorElement;
  onAction?: (action: NativeLinkMenuAction) => void;
  onClose?: () => void;
}): Promise<NativeLinkMenu> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  render(
    html`<openclaw-native-link-menu
      .x=${100}
      .y=${100}
      .trigger=${options.trigger ?? null}
      .onAction=${options.onAction ?? (() => {})}
      .onClose=${options.onClose ?? (() => {})}
    ></openclaw-native-link-menu>`,
    container,
  );
  const menu = container.querySelector("openclaw-native-link-menu");
  if (!(menu instanceof NativeLinkMenu)) {
    throw new Error("Expected native link menu");
  }
  await menu.updateComplete;
  return menu;
}

function menuItems(menu: ParentNode): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

describe("native link menu", () => {
  it("renders the native link actions in order and closes before dispatch", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action),
    });
    const items = menuItems(menu);

    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Open in Sidebar",
      "Open in Default Browser",
      "Copy Link",
    ]);

    items[0]?.click();
    expect(calls).toEqual(["close", "inline"]);
  });

  it("closes on Escape and outside pointerdown while preserving trigger clicks", async () => {
    const trigger = document.createElement("a");
    trigger.href = "https://example.com";
    document.body.append(trigger);
    containers.push(trigger);
    const onClose = vi.fn();
    await mountMenu({ trigger, onClose });

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escape);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(onClose).toHaveBeenCalledTimes(2);

    trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
