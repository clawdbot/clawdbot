/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

type DropdownElement = HTMLElement & { readonly updateComplete: Promise<unknown> };
const domRoots = ["light", "shadow"] as const;

async function createDropdown(label?: string, domRoot: (typeof domRoots)[number] = "light") {
  const dropdown = document.createElement("wa-dropdown") as DropdownElement;
  if (label) {
    dropdown.setAttribute("aria-label", label);
  }
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Actions";
  const item = document.createElement("wa-dropdown-item");
  item.textContent = "Open";
  dropdown.append(trigger, item);
  const root =
    domRoot === "shadow"
      ? document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" })
      : document.body;
  root.append(dropdown);
  await dropdown.updateComplete;
  dropdown.dispatchEvent(new CustomEvent("wa-show", { bubbles: true, composed: true }));
  return { dropdown, trigger };
}

async function createSubmenuDropdown(itemLabel = "Specific owner") {
  const dropdown = document.createElement("wa-dropdown") as DropdownElement;
  dropdown.setAttribute("aria-label", "Filter & sort");
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Filter & sort";
  const item = document.createElement("wa-dropdown-item") as DropdownElement;
  item.setAttribute("aria-label", itemLabel);
  item.textContent = "Specific owner";
  const owner = document.createElement("wa-dropdown-item");
  owner.slot = "submenu";
  owner.textContent = "Ada";
  item.append(owner);
  dropdown.append(trigger, item);
  document.body.append(dropdown);
  dropdown.dispatchEvent(new CustomEvent("wa-show", { bubbles: true, composed: true }));
  await Promise.all([dropdown.updateComplete, item.updateComplete]);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await item.updateComplete;
  item.dispatchEvent(
    new CustomEvent("submenu-opening", {
      bubbles: true,
      composed: true,
      detail: { item },
    }),
  );
  await Promise.resolve();
  return { dropdown, item };
}

afterEach(() => document.body.replaceChildren());

describe("Web Awesome adapters", () => {
  it.each(domRoots)("syncs an explicit menu label only while open in %s DOM", async (domRoot) => {
    const { dropdown } = await createDropdown("Message actions", domRoot);

    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Message actions",
    );

    dropdown.setAttribute("aria-label", "Updated actions");
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Updated actions",
    );
    dropdown.dispatchEvent(new Event("wa-after-hide", { bubbles: true, composed: true }));
    dropdown.setAttribute("aria-label", "Closed actions");
    await Promise.resolve();
    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Updated actions",
    );
  });

  it("labels a dropdown menu from its trigger", async () => {
    const { dropdown } = await createDropdown();

    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Actions",
    );
  });

  it("labels a submenu from its parent item", async () => {
    const { item } = await createSubmenuDropdown("Specific owner: Ada");

    expect(item.shadowRoot?.querySelector('[part="submenu"]')?.getAttribute("aria-label")).toBe(
      "Specific owner: Ada",
    );
  });

  it.each(domRoots)("makes closing menus inert and restores them in %s DOM", async (domRoot) => {
    const { dropdown } = await createDropdown(undefined, domRoot);
    const menu = dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
    expect(menu?.hasAttribute("inert")).toBe(false);

    dropdown.dispatchEvent(
      new Event("wa-hide", { bubbles: true, cancelable: true, composed: true }),
    );

    await Promise.resolve();
    expect(menu?.hasAttribute("inert")).toBe(true);
    dropdown.dispatchEvent(
      new Event("wa-show", { bubbles: true, cancelable: true, composed: true }),
    );
    expect(menu?.hasAttribute("inert")).toBe(false);
  });

  it("keeps a canceled dropdown hide interactive", async () => {
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("wa-hide", (event) => event.preventDefault(), { once: true });

    dropdown.dispatchEvent(
      new Event("wa-hide", { bubbles: true, cancelable: true, composed: true }),
    );

    await Promise.resolve();
    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.hasAttribute("inert")).toBe(false);
  });

  it("keeps a dropdown interactive when a later document listener cancels its hide", async () => {
    const { dropdown } = await createDropdown();
    const cancelHide = (event: Event) => {
      if (event.target === dropdown) {
        event.preventDefault();
      }
    };
    document.addEventListener("wa-hide", cancelHide);

    try {
      const hideEvent = new Event("wa-hide", {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      expect(dropdown.dispatchEvent(hideEvent)).toBe(false);
      await Promise.resolve();

      expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.hasAttribute("inert")).toBe(
        false,
      );
    } finally {
      document.removeEventListener("wa-hide", cancelHide);
    }
  });

  it("restores a durable trigger only after keyboard dismissal", async () => {
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", trackDropdownKeyboardDismissal);

    expect(consumeDropdownKeyboardDismissal(new CustomEvent("wa-after-hide"))).toBe(false);

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    let restoreFocus = false;
    dropdown.addEventListener("wa-after-hide", (event) => {
      restoreFocus = consumeDropdownKeyboardDismissal(event);
    });
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide"));
    expect(restoreFocus).toBe(true);
  });

  it("restores the durable trigger before native Tab navigation", async () => {
    const durableTrigger = document.createElement("button");
    document.body.append(durableTrigger);
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", (event) =>
      trackDropdownKeyboardDismissal(event, () => durableTrigger.focus()),
    );

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(document.activeElement).toBe(durableTrigger);
  });

  it("restores radio semantics after a dropdown item updates", async () => {
    const item = document.createElement("wa-dropdown-item") as DropdownElement;
    item.setAttribute("type", "normal");
    document.body.append(item);

    syncDropdownItemRadio(item, true);
    await item.updateComplete;
    await Promise.resolve();

    expect(item.getAttribute("role")).toBe("menuitemradio");
    expect(item.getAttribute("aria-checked")).toBe("true");
  });
});
