import type { Page } from "playwright";

export async function failNextDeviceIdentityMint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let identityMintFailed = false;
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value(array: Uint8Array<ArrayBuffer>) {
        if (!identityMintFailed) {
          identityMintFailed = true;
          throw new Error("device identity unavailable");
        }
        Object.defineProperty(globalThis.crypto, "getRandomValues", {
          configurable: true,
          value: getRandomValues,
        });
        getRandomValues(array);
        return array;
      },
    });
  });
}

export async function openChatSidePanelType(page: Page, label: string): Promise<void> {
  const panel = page.locator(".sidebar-region__right-runtime .side-panel");
  if (
    !(await panel.locator('[data-region-header="side"]').isVisible()) &&
    !(await panel.locator(".side-panel-empty--selector").isVisible())
  ) {
    await page.locator(".chat-side-panel-toggle").click();
  }
  // An empty panel offers its type list; a populated one offers the header "+" menu,
  // and only one of the two ever exists. The toggle above renders asynchronously, so
  // settle on whichever surface arrives before branching — probing first would read
  // an unrendered panel as populated and then wait forever for a "+" that never comes.
  await panel.locator(".side-panel-empty__types, .side-panel__header-tabs").first().waitFor();
  const emptyChoice = panel.locator(".side-panel-empty__type").filter({ hasText: label });
  if ((await emptyChoice.count()) > 0) {
    await emptyChoice.click();
    return;
  }
  await panel.getByRole("button", { name: "Add side panel tab" }).click();
  await panel.locator("wa-dropdown-item").filter({ hasText: label }).click();
}

export async function focusChatSidePanel(page: Page): Promise<void> {
  await page.locator(".chat-panel-swap").click();
  await page
    .locator(".chat-pane__header")
    .getByRole("button", { name: "Focus", exact: true })
    .click();
  await page.getByRole("button", { name: "Restore split", exact: true }).waitFor();
}

export async function restoreChatAsMain(page: Page): Promise<void> {
  const side = page.locator('[data-region-header="side"]');
  await side.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.locator(".chat-panel-swap").click();
  await page.locator('.sidebar-region__primary[data-region="main"]').waitFor();
}

export async function dockChatSidePanel(
  page: Page,
  dock: "left" | "right" | "bottom",
): Promise<void> {
  const menu = page.locator(".chat-panel-layout-menu");
  await menu.getByRole("button", { name: "Layout", exact: true }).click();
  await menu.locator(`wa-dropdown-item[value="${dock}"]`).click();
  await page.locator(`.sidebar-region--${dock}`).waitFor();
}

export async function activateChatHeaderPanelAction(page: Page, label: string): Promise<void> {
  await page.locator(".chat-header-session-menu__trigger").click();
  const menu = page.locator("openclaw-chat-header-session-menu");
  const action = menu
    .locator('wa-dropdown-item[value^="quick:panels:"]')
    .filter({ hasText: label });
  if (!(await action.isVisible())) {
    const panels = menu.locator(".session-menu__text").filter({ hasText: /^Panels$/ });
    if ((await menu.locator("wa-dropdown.chat-header-session-menu--compact").count()) > 0) {
      await panels.click();
    } else {
      await panels.hover();
    }
  }
  await action.waitFor({ state: "visible" });
  await action.click();
  await page.waitForFunction(() => {
    const dropdown = document.querySelector("openclaw-chat-header-session-menu wa-dropdown");
    // Web Awesome clears `open` before its hide animation; reopening while the popup is active
    // skips showMenu setup and can let the previous close hide the newly opened submenu.
    const popup = dropdown?.shadowRoot?.querySelector("wa-popup");
    return (
      (!dropdown || Reflect.get(dropdown, "open") !== true) &&
      (!popup || !Reflect.get(popup, "active"))
    );
  });
  await action.waitFor({ state: "hidden" });
}
