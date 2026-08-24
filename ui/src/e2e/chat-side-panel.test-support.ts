import type { Page } from "playwright";

export async function openChatSidePanelType(page: Page, label: string): Promise<void> {
  const panel = page.locator(".sidebar-region__right-runtime .side-panel");
  if ((await panel.count()) === 0) {
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
  const afterHide = menu.locator("wa-dropdown").evaluate(
    (dropdown) =>
      new Promise<void>((resolve) => {
        dropdown.addEventListener("wa-after-hide", () => resolve(), { once: true });
      }),
  );
  await action.click();
  await afterHide;
  await page.waitForFunction(() => {
    const dropdown = document.querySelector("openclaw-chat-header-session-menu wa-dropdown");
    return !dropdown || Reflect.get(dropdown, "open") !== true;
  });
}
