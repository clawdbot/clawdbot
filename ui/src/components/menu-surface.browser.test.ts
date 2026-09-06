import { afterEach, describe, expect, it } from "vitest";
import "../test-helpers/load-styles.ts";
import "./menu-surface.ts";
import "./resizable-divider.ts";
import "./web-awesome.ts";

// Real-browser regression for the sidebar menu z-order bug: the nav column is
// a stacking context (.shell-nav z-index 10) painted below the sidebar
// resizer (.sidebar-resizer z-index 20), so a fixed-position menu rendered
// inside the nav is overdrawn by the divider unless it is promoted to the
// popover top layer. Plain overlays use openclaw-menu-surface; Web Awesome
// dropdowns already own their popup and must not nest inside that surface.
//
// The repo-level test shard also collects *.browser.test.ts under jsdom,
// which has neither the Popover API nor real layout; the paint-order
// assertions only mean anything in the Chromium lane, so skip elsewhere.
const hasPopoverApi = typeof HTMLElement.prototype.showPopover === "function";

afterEach(() => {
  document.body.replaceChildren();
});

// The default browser-lane viewport (414px) triggers the mobile drawer
// layout, which hides the resizer entirely; the bug only exists on the
// desktop grid. Dynamic import keeps jsdom collection from touching the
// browser-only context module.
async function useDesktopViewport() {
  const { page } = await import("vitest/browser");
  await page.viewport(1280, 800);
}

function mountShell() {
  const shell = document.createElement("div");
  shell.className = "shell";
  // The shell entry animation animates the whole grid; skip it so fixed
  // positioning and hit-testing are stable at assertion time.
  shell.style.animation = "none";
  const nav = document.createElement("div");
  nav.className = "shell-nav";
  const divider = document.createElement("resizable-divider");
  divider.className = "sidebar-resizer";
  const content = document.createElement("main");
  content.className = "content";
  shell.append(nav, divider, content);
  document.body.append(shell);
  return { nav, divider };
}

function createSortMenu() {
  const menu = document.createElement("div");
  menu.className = "sidebar-session-sort-menu";
  const item = document.createElement("button");
  item.type = "button";
  item.className = "sidebar-session-sort-menu__item";
  item.textContent = "Created";
  menu.append(item);
  return menu;
}

/** Places the menu so it straddles the divider, then hit-tests on the divider line. */
function hitTestOnDivider(menu: HTMLElement, divider: HTMLElement): Element | null {
  const dividerBounds = divider.getBoundingClientRect();
  menu.style.left = `${Math.round(dividerBounds.left) - 120}px`;
  menu.style.top = "100px";
  const menuBounds = menu.getBoundingClientRect();
  expect(menuBounds.right).toBeGreaterThan(dividerBounds.left);
  const x = dividerBounds.left + dividerBounds.width / 2;
  const y = menuBounds.top + menuBounds.height / 2;
  return document.elementFromPoint(x, y);
}

describe.skipIf(!hasPopoverApi)("sidebar menu stacking", () => {
  it("overdraws a plain fixed menu inside the nav with the resizer divider (the bug shape)", async () => {
    await useDesktopViewport();
    const { nav, divider } = mountShell();
    const menu = createSortMenu();
    nav.append(menu);

    expect(hitTestOnDivider(menu, divider)).toBe(divider);
  });

  it("paints a plain menu hosted in openclaw-menu-surface above the resizer divider", async () => {
    await useDesktopViewport();
    const { nav, divider } = mountShell();
    const surface = document.createElement("openclaw-menu-surface");
    const menu = createSortMenu();
    surface.append(menu);
    nav.append(surface);

    expect(surface.matches(":popover-open")).toBe(true);
    const hit = hitTestOnDivider(menu, divider);
    expect(hit).not.toBeNull();
    expect(menu.contains(hit)).toBe(true);
  });

  it("paints a Web Awesome dropdown above the divider through its own popover", async () => {
    await useDesktopViewport();
    const { nav, divider } = mountShell();
    const dividerBounds = divider.getBoundingClientRect();
    const dropdown = document.createElement("wa-dropdown");
    dropdown.className = "sidebar-session-sort-menu";
    const trigger = document.createElement("button");
    trigger.slot = "trigger";
    trigger.style.position = "fixed";
    trigger.style.left = `${Math.round(dividerBounds.left) - 120}px`;
    trigger.style.top = "100px";
    const item = document.createElement("wa-dropdown-item");
    item.className = "sidebar-session-sort-menu__item";
    item.textContent = "Created";
    dropdown.append(trigger, item);
    nav.append(dropdown);
    // Popover membership precedes positioning; hit-test only after the completed show.
    const shown = new Promise<Event>((resolve) => {
      dropdown.addEventListener("wa-after-show", resolve, { once: true });
    });
    dropdown.open = true;
    await shown;

    const popup = dropdown.shadowRoot?.querySelector<HTMLElement>("wa-popup");
    const popupSurface = popup?.shadowRoot?.querySelector<HTMLElement>('[part="popup"]');
    await expect.poll(() => popupSurface?.matches(":popover-open")).toBe(true);
    expect(dropdown.closest("openclaw-menu-surface")).toBeNull();

    const menu = dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
    expect(menu).not.toBeNull();
    const menuBounds = menu!.getBoundingClientRect();
    expect(menuBounds.right).toBeGreaterThan(dividerBounds.left);
    const hit = document.elementFromPoint(
      dividerBounds.left + dividerBounds.width / 2,
      menuBounds.top + menuBounds.height / 2,
    );
    expect(hit).not.toBeNull();
    expect(dropdown.contains(hit)).toBe(true);
  });
});

describe.skipIf(!hasPopoverApi)("agent picker surface", () => {
  it("stays opaque while the Web Awesome menu animates open", async () => {
    await useDesktopViewport();
    const dropdown = document.createElement("wa-dropdown") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    dropdown.className = "agent-select";
    const trigger = document.createElement("button");
    trigger.slot = "trigger";
    trigger.textContent = "Agent";
    const item = document.createElement("wa-dropdown-item");
    item.textContent = "All agents";
    dropdown.append(trigger, item);
    document.body.append(dropdown);
    await dropdown.updateComplete;

    const menu = dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
    expect(menu).not.toBeNull();
    menu!.style.setProperty("--show-duration", "1s");
    trigger.click();
    await expect.poll(() => menu!.getAnimations().length).toBe(1);

    const animation = menu!.getAnimations()[0];
    if (!animation) {
      throw new Error("expected the agent picker menu to be animating");
    }
    animation.pause();
    animation.currentTime = 500;
    expect(getComputedStyle(menu!).opacity).toBe("1");
    expect(getComputedStyle(menu!).scale).not.toBe("1");
  });
});

describe.skipIf(!hasPopoverApi)("submenu parent highlight", () => {
  it.each([
    ["session-menu__item", "keyboard"],
    ["session-menu__item", "pointer"],
    ["sidebar-customize-menu__item", "keyboard"],
    ["sidebar-customize-menu__item", "pointer"],
  ])("keeps %s highlighted during %s submenu navigation", async (className, input) => {
    await useDesktopViewport();
    const { page, userEvent } = await import("vitest/browser");
    const dropdown = document.createElement("wa-dropdown");
    const trigger = document.createElement("button");
    trigger.slot = "trigger";
    trigger.textContent = "Actions";
    const parent = document.createElement("wa-dropdown-item");
    parent.className = className;
    parent.append("Parent");
    const child = document.createElement("wa-dropdown-item");
    child.className = className;
    child.slot = "submenu";
    child.textContent = "Child";
    parent.append(child);
    const sibling = document.createElement("wa-dropdown-item");
    sibling.className = className;
    sibling.textContent = "Other action";
    dropdown.append(trigger, parent, sibling);
    document.body.append(dropdown);
    const swatch = document.createElement("div");
    swatch.style.backgroundColor = "var(--bg-hover)";
    document.body.append(swatch);
    const highlight = getComputedStyle(swatch).backgroundColor;

    await page.elementLocator(trigger).click();
    await expect.poll(() => document.activeElement).toBe(parent);
    if (input === "keyboard") {
      await userEvent.keyboard("{ArrowRight}");
    } else {
      await page.elementLocator(parent).hover();
      await page.elementLocator(child).hover();
    }
    await expect.poll(() => document.activeElement).toBe(child);
    await expect.poll(() => parent.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => getComputedStyle(parent).backgroundColor).toBe(highlight);

    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => document.activeElement).toBe(parent);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(sibling);
    await expect.poll(() => parent.getAttribute("aria-expanded")).toBe("false");
    // Hover highlights independently of submenu expansion and keyboard focus.
    await page.elementLocator(sibling).hover();
    await expect.poll(() => parent.matches(":hover")).toBe(false);
    await expect.poll(() => getComputedStyle(parent).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });
});
