import type { Page } from "playwright";

export async function openChatSidePanelType(page: Page, label: string): Promise<void> {
  const panel = page.locator(".sidebar-region__right-runtime .side-panel");
  if ((await panel.count()) === 0) {
    await page.locator(".chat-side-panel-toggle").click();
  }
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
    await menu
      .locator(".session-menu__text")
      .filter({ hasText: /^Panels$/ })
      .hover();
  }
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
