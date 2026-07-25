/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { NativeLinkMenu, type NativeLinkMenuAction } from "./native-link-menu.ts";

const NATIVE_LINK_MENU_ELEMENT_NAME = `test-openclaw-native-link-menu-${crypto.randomUUID()}`;
const containers: HTMLElement[] = [];
type DropdownElement = HTMLElement & { readonly updateComplete: Promise<unknown> };

// The non-isolated UI runner resets modules but not customElements. Register
// the current class graph so instanceof and locale updates share one module.
class TestNativeLinkMenu extends NativeLinkMenu {}

customElements.define(NATIVE_LINK_MENU_ELEMENT_NAME, TestNativeLinkMenu);

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  await i18n.setLocale("en");
});

async function mountMenu(options: {
  trigger?: HTMLAnchorElement;
  onAction?: (action: NativeLinkMenuAction) => void;
  onClose?: () => void;
}): Promise<NativeLinkMenu> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const menu = document.createElement(NATIVE_LINK_MENU_ELEMENT_NAME) as NativeLinkMenu;
  menu.x = 100;
  menu.y = 100;
  menu.trigger = options.trigger ?? null;
  menu.onAction = options.onAction ?? (() => {});
  menu.onClose = options.onClose ?? (() => {});
  container.append(menu);
  if (!(menu instanceof NativeLinkMenu)) {
    throw new Error("Expected native link menu");
  }
  await menu.updateComplete;
  return menu;
}

function menuItems(menu: ParentNode): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>("wa-dropdown-item")];
}

describe("native link menu", () => {
  it("renders the native link actions in order and closes before dispatch", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action),
    });
    const items = menuItems(menu);

    await Promise.resolve();
    expect(document.activeElement).toBe(items[0]);

    expect(
      items.map((item) => item.querySelector(".session-menu__text")?.textContent?.trim()),
    ).toEqual(["Open in Sidebar", "Open in Default Browser", "Copy Link"]);

    items[0]?.click();
    expect(calls).toEqual(["close", "inline"]);
  });

  it("rerenders open actions when the locale changes", async () => {
    const menu = await mountMenu({});
    const dropdown = menu.querySelector<DropdownElement>("wa-dropdown");
    expect(dropdown).not.toBeNull();
    await dropdown?.updateComplete;

    await i18n.setLocale("de");
    await menu.updateComplete;

    expect(menu.querySelector("wa-dropdown")?.getAttribute("aria-label")).toBe("Link-Aktionen");
    await vi.waitFor(() =>
      expect(dropdown?.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
        "Link-Aktionen",
      ),
    );
    expect(
      menuItems(menu).map((item) => item.querySelector(".session-menu__text")?.textContent?.trim()),
    ).toEqual(["In der Seitenleiste öffnen", "Im Standardbrowser öffnen", "Link kopieren"]);
  });

  it("renders shortcut hints and dispatches actions from bare letter keys", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action),
    });

    const hints = menuItems(menu).map(
      (item) => item.querySelector(".session-menu__shortcut")?.textContent,
    );
    expect(hints).toEqual(["S", "B", "C"]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
    );
    expect(calls).toEqual(["close", "copy"]);
  });

  it("closes on Escape without leaking the key to an underlying dialog", async () => {
    const trigger = document.createElement("a");
    trigger.href = "https://example.com";
    document.body.append(trigger);
    containers.push(trigger);
    const onClose = vi.fn();
    const menu = await mountMenu({ trigger, onClose });
    const escaped = vi.fn();
    menu.addEventListener("keydown", escaped);

    const keydown = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    menu.dispatchEvent(keydown);

    expect(keydown.defaultPrevented).toBe(true);
    expect(escaped).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes after Web Awesome hides without stealing focus", async () => {
    const trigger = document.createElement("a");
    trigger.href = "https://example.com";
    document.body.append(trigger);
    containers.push(trigger);
    const onClose = vi.fn();
    const menu = await mountMenu({ trigger, onClose });

    menu
      .querySelector("wa-dropdown")
      ?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(trigger);
  });
});
