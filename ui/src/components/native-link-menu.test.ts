/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { i18n } from "../i18n/index.ts";
import { de } from "../i18n/locales/de.ts";
import { NativeLinkMenu, type NativeLinkMenuAction } from "./native-link-menu.runtime.ts";
import "./tooltip.ts";

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
    ).toEqual(["Open in Browser Panel", "Open in Default Browser", "Copy Link"]);

    items[0]?.click();
    expect(calls).toEqual(["close", "inline"]);
  });

  it("rerenders open actions when the locale changes", async () => {
    const menu = await mountMenu({});
    const dropdown = menu.querySelector<DropdownElement>("wa-dropdown");
    expect(dropdown).not.toBeNull();
    await dropdown?.updateComplete;
    const englishLabel = dropdown?.getAttribute("aria-label");

    await i18n.setLocale("de");
    await menu.updateComplete;

    const german = flattenTranslations(de);
    expect(dropdown?.getAttribute("aria-label")).not.toBe(englishLabel);
    expect(dropdown?.getAttribute("aria-label")).toBe(german.get("nativeLinkMenu.label"));
    await vi.waitFor(() =>
      expect(dropdown?.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
        german.get("nativeLinkMenu.label"),
      ),
    );
    expect(
      menuItems(menu).map((item) => item.querySelector(".session-menu__text")?.textContent?.trim()),
    ).toEqual([
      // Changed English copy falls back until the post-merge locale refresh.
      german.get("nativeLinkMenu.openInline") ?? "Open in Browser Panel",
      german.get("nativeLinkMenu.openExternal"),
      german.get("nativeLinkMenu.copy"),
    ]);
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
      new KeyboardEvent("keydown", {
        key: "с",
        code: "KeyC",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(calls).toEqual(["close", "copy"]);
  });

  it("dismisses a tooltip before its menu without leaking either Escape", async () => {
    const trigger = document.createElement("a");
    trigger.href = "https://example.com";
    document.body.append(trigger);
    containers.push(trigger);
    const onClose = vi.fn();
    const menu = await mountMenu({ trigger, onClose });
    const escaped = vi.fn();
    menu.addEventListener("keydown", escaped);
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "Link action details";
    tooltip.anchor = menuItems(menu)[0]!;
    menu.append(tooltip);
    await tooltip.updateComplete;
    tooltip.anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    const popup = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
    await popup.updateComplete;
    expect(popup.open).toBe(true);

    const firstEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    menu.dispatchEvent(firstEscape);

    expect(popup.open).toBe(false);
    expect(firstEscape.defaultPrevented).toBe(true);
    expect(escaped).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(trigger);

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

  it("returns focus to its durable trigger before a Tab leaves the menu", async () => {
    const trigger = document.createElement("a");
    trigger.href = "https://example.com";
    document.body.append(trigger);
    containers.push(trigger);
    const menu = await mountMenu({ trigger });
    const item = menuItems(menu)[0];
    item?.focus();

    const keydown = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    item?.dispatchEvent(keydown);

    expect(document.activeElement).toBe(trigger);
    expect(keydown.defaultPrevented).toBe(false);
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
