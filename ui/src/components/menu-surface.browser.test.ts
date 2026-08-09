import { afterEach, describe, expect, it } from "vitest";
import "../test-helpers/load-styles.ts";
import "./menu-surface.ts";
import "./resizable-divider.ts";

// Real-browser regression for the sidebar menu z-order bug: the nav column is
// a stacking context (.shell-nav z-index 10) painted below the sidebar
// resizer (.sidebar-resizer z-index 20), so a fixed-position menu rendered
// inside the nav is overdrawn by the divider unless it is promoted to the
// popover top layer via openclaw-menu-surface.
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
  const { page } = await import("@vitest/browser/context");
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

  it("paints a menu hosted in openclaw-menu-surface above the resizer divider", async () => {
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
});
