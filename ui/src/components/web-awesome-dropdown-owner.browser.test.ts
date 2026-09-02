import { afterEach, describe, expect, it } from "vitest";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./web-awesome.ts";

type Item = HTMLElementTagNameMap["wa-dropdown-item"];

function item(label: string, ...children: Item[]) {
  const element = document.createElement("wa-dropdown-item");
  element.append(label);
  for (const child of children) {
    child.slot = "submenu";
    element.append(child);
  }
  return element;
}

async function fixture(shadow = false) {
  const leaf = item("Deep action");
  const inner = item("Inner", leaf);
  const middle = item("Middle", inner);
  const alternateLeaf = item("Alternate action");
  const alternate = item("Alternate", alternateLeaf);
  const parent = item("More", middle, alternate);
  const otherLeaf = item("Other action");
  const other = item("Other", otherLeaf);
  const first = item("Web search");
  const disabled = item("Unavailable");
  disabled.disabled = true;
  const dropdown = document.createElement("wa-dropdown");
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Actions";
  dropdown.append(trigger, first, disabled, parent, other);
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  const host = document.createElement("div");
  const root = shadow ? host.attachShadow({ mode: "open" }) : host;
  root.append(dropdown, outside);
  document.body.append(host);
  const items = [
    first,
    disabled,
    parent,
    middle,
    inner,
    leaf,
    alternate,
    alternateLeaf,
    other,
    otherLeaf,
  ];
  await dropdown.updateComplete;
  await Promise.all(items.map((entry) => entry.updateComplete));
  dropdown.open = true;
  await expect.poll(() => root.querySelector("wa-dropdown")?.open).toBe(true);
  await expect.poll(() => focused()).toBe(first);
  return {
    host,
    root,
    dropdown,
    trigger,
    outside,
    first,
    disabled,
    parent,
    middle,
    inner,
    leaf,
    alternate,
    alternateLeaf,
    other,
    otherLeaf,
  };
}

function focused(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

async function hidden(...items: Item[]) {
  await expect
    .poll(() =>
      items.every(
        (entry) =>
          !entry.submenuOpen &&
          entry.submenuElement.hidden &&
          !entry.submenuElement.matches(":popover-open"),
      ),
    )
    .toBe(true);
}

async function back(key: string, trigger: Item) {
  const { userEvent } = await import("vitest/browser");
  await userEvent.keyboard(`{${key}}`);
  expect(focused()).toBe(trigger);
  expect(trigger.active).toBe(true);
}

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("Web Awesome submenu owner", () => {
  it.each(["ltr", "rtl"] as const)(
    "returns to root after sibling replacement (%s)",
    async (dir) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      f.dropdown.dir = dir;
      await f.parent.openSubmenu();
      await f.other.openSubmenu();
      await hidden(f.parent);
      expect(focused()).toBe(f.otherLeaf);
      if (dir === "rtl") {
        // Placement flips at the left viewport edge; backward navigation stays RTL.
        await expect
          .poll(() => f.other.submenuElement.getAttribute("data-placement"))
          .toMatch(/^right/);
      }
      await back(dir === "rtl" ? "ArrowRight" : "ArrowLeft", f.other);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.parent);
      await userEvent.keyboard("{End}");
      expect(focused()).toBe(f.other);
      await userEvent.keyboard("{Home}");
      expect(focused()).toBe(f.first);
      await userEvent.keyboard("o");
      expect(focused()).toBe(f.other);
    },
  );

  it("preserves three ancestors, then retires only the replaced nested branch", async () => {
    const f = await fixture();
    await f.parent.openSubmenu();
    await f.middle.openSubmenu();
    await f.inner.openSubmenu();
    expect([f.parent.submenuOpen, f.middle.submenuOpen, f.inner.submenuOpen]).toEqual([
      true,
      true,
      true,
    ]);
    f.inner.disabled = true;
    await f.alternate.openSubmenu();
    expect(f.parent.submenuOpen).toBe(true);
    await hidden(f.middle, f.inner);
    expect(focused()).toBe(f.alternateLeaf);
    await back("ArrowLeft", f.alternate);
    await back("ArrowLeft", f.parent);
  });

  it("keeps the open child branch when an ancestor is opened repeatedly", async () => {
    const f = await fixture();
    await f.parent.openSubmenu();
    await f.middle.openSubmenu();
    await f.parent.openSubmenu();
    // A batched property reversal notifies again without actually closing the ancestor.
    f.parent.submenuOpen = false;
    f.parent.submenuOpen = true;
    await f.parent.updateComplete;
    await f.parent.openSubmenu();
    expect(f.middle.submenuOpen).toBe(true);
    await back("ArrowLeft", f.middle);
    await back("ArrowLeft", f.parent);
  });

  it.each(["method", "property", "hover"] as const)(
    "retires a standalone %s close before navigation",
    async (reason) => {
      const { page, userEvent } = await import("vitest/browser");
      const f = await fixture();
      await f.other.openSubmenu();
      if (reason === "method") {
        await f.other.closeSubmenu();
      } else if (reason === "property") {
        f.other.submenuOpen = false;
      } else {
        await page.elementLocator(f.outside).hover();
      }
      f.outside.focus();
      await hidden(f.other);
      expect(focused()).toBe(f.outside);
      f.other.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
    },
  );

  it.each(["ancestor", "root", "disconnect"] as const)(
    "closes disabled descendants on %s retirement and remount",
    async (reason) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      await f.parent.openSubmenu();
      await f.middle.openSubmenu();
      f.middle.disabled = true;
      if (reason === "ancestor") {
        f.parent.submenuOpen = false;
      } else if (reason === "root") {
        f.dropdown.open = false;
      } else {
        f.parent.remove();
      }
      f.outside.focus();
      await hidden(f.parent, f.middle);
      expect(focused()).toBe(f.outside);
      if (reason === "disconnect") {
        f.other.before(f.parent);
      }
      if (reason === "root") {
        await expect
          .poll(() => f.dropdown.shadowRoot?.querySelector("wa-popup")?.active)
          .toBe(false);
        f.dropdown.open = true;
        await expect.poll(() => focused()).toBe(f.first);
      }
      f.middle.disabled = false;
      await f.parent.openSubmenu();
      expect(focused()).toBe(f.middle);
      await back("ArrowLeft", f.parent);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.other);
    },
  );

  it("retires direct item disconnection before another submenu opens", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture();
    await f.other.openSubmenu();
    f.other.remove();
    await hidden(f.other);
    f.parent.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe(f.first);
    f.dropdown.append(f.other);
    await f.other.openSubmenu();
    await back("ArrowLeft", f.other);
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe(f.first);
  });

  it("navigates sibling submenus through forwarded slots inside a shadow caller", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture(true);
    // A slot in the caller's shadow tree forwards light-DOM children to the submenu.
    const forward = document.createElement("slot");
    forward.name = "forwarded";
    forward.slot = "submenu";
    f.parent.replaceChildren("More", forward);
    f.middle.slot = "forwarded";
    f.alternate.slot = "forwarded";
    f.host.append(f.middle, f.alternate);
    await f.parent.updateComplete;
    await f.parent.openSubmenu();
    expect(focused()).toBe(f.middle);
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe(f.inner);
    await f.alternate.openSubmenu();
    await hidden(f.middle);
    await back("ArrowLeft", f.alternate);
    await userEvent.keyboard("{Home}");
    expect(focused()).toBe(f.middle);
    await back("ArrowLeft", f.parent);
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe(f.other);
  });

  it("keeps the new sibling focused when replacement interrupts an opening animation", async () => {
    const f = await fixture();
    let replaced = false;
    f.parent.submenuElement.addEventListener(
      "animationstart",
      () => {
        expect(
          f.parent.submenuElement
            .getAnimations()
            .some((animation) => animation.playState === "running"),
        ).toBe(true);
        replaced = true;
        void f.other.openSubmenu();
      },
      { once: true },
    );
    await f.parent.openSubmenu();
    await expect.poll(() => replaced).toBe(true);
    await hidden(f.parent);
    await expect.poll(() => focused()).toBe(f.otherLeaf);
    await back("ArrowLeft", f.other);
  });

  it("does not let an interrupted close retire a reopened child branch", async () => {
    const f = await fixture();
    await f.parent.openSubmenu();
    await f.middle.openSubmenu();
    let reopened: Promise<unknown> | undefined;
    f.parent.submenuElement.addEventListener(
      "animationstart",
      () => {
        reopened = f.parent.openSubmenu().then(() => f.middle.openSubmenu());
      },
      { once: true },
    );
    await f.parent.closeSubmenu();
    await expect.poll(() => reopened !== undefined).toBe(true);
    await reopened;
    expect(f.parent.submenuElement.matches(":popover-open")).toBe(true);
    expect(f.middle.submenuElement.matches(":popover-open")).toBe(true);
    expect(focused()).toBe(f.inner);
    await back("ArrowLeft", f.middle);
    await back("ArrowLeft", f.parent);
  });

  it.each(["mouse", "touch", "pen"] as const)(
    "replaces siblings through %s input without hover opening on touch or pen",
    async (pointerType) => {
      const { page } = await import("vitest/browser");
      const f = await fixture();
      await f.parent.openSubmenu();
      if (pointerType === "mouse") {
        await page.elementLocator(f.other).hover();
      } else {
        f.other.dispatchEvent(new PointerEvent("pointerenter", { pointerType }));
        await f.other.updateComplete;
        expect(f.other.submenuOpen).toBe(false);
        f.other.click();
      }
      await hidden(f.parent);
      await expect.poll(() => focused()).toBe(f.otherLeaf);
      await back("ArrowLeft", f.other);
    },
  );

  it("rejects a pending child opening beneath a closing ancestor", async () => {
    const f = await fixture();
    await f.parent.openSubmenu();
    f.parent.submenuOpen = false;
    f.middle.submenuOpen = true;
    await hidden(f.parent, f.middle);
    await f.other.openSubmenu();
    expect(focused()).toBe(f.otherLeaf);
    await back("ArrowLeft", f.other);
  });

  it("returns to the surviving level before a property hide animation finishes", async () => {
    const f = await fixture();
    await f.other.openSubmenu();
    let navigation: { running: boolean; focused: Element | null } | undefined;
    f.other.submenuElement.addEventListener(
      "animationstart",
      () => {
        const running = f.other.submenuElement
          .getAnimations()
          .some((animation) => animation.playState === "running");
        f.other.focus();
        f.other.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true }),
        );
        navigation = { running, focused: focused() };
      },
      { once: true },
    );
    f.other.submenuOpen = false;
    await hidden(f.other);
    expect(navigation).toEqual({ running: true, focused: f.first });
  });

  it.each(["removal", "slot reassignment"] as const)(
    "retires an emptied submenu after last-child %s and supports restoration",
    async (change) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      await f.other.openSubmenu();
      const retiredSubmenu = f.other.submenuElement;
      if (change === "removal") {
        f.otherLeaf.remove();
      } else {
        f.otherLeaf.slot = "details";
      }
      await expect.poll(() => f.other.hasSubmenu).toBe(false);
      await expect.poll(() => retiredSubmenu.isConnected).toBe(false);
      f.other.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
      expect(f.other.submenuOpen).toBe(false);
      expect(retiredSubmenu.matches(":popover-open")).toBe(false);

      f.otherLeaf.slot = "submenu";
      if (change === "removal") {
        f.other.append(f.otherLeaf);
      }
      await expect.poll(() => f.other.submenuElement?.isConnected).toBe(true);
      await f.other.openSubmenu();
      expect(focused()).toBe(f.otherLeaf);
      expect(f.other.submenuElement.matches(":popover-open")).toBe(true);
      await back("ArrowLeft", f.other);
      await userEvent.keyboard("{ArrowDown}");
      expect(focused()).toBe(f.first);
    },
  );
});
