import type { Locator, Page } from "playwright";

type ReadyControlUiSettingsSidebar = {
  search: Locator;
  sidebar: Locator;
};

/** A sent connect request is not the delivered Gateway handshake. */
export async function waitForControlUiGatewayReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & { runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } } })
      | null;
    return app?.runtime?.context?.gateway?.snapshot?.phase === "connected";
  });
}

/** Wait for the lazy terminal itself before exercising a real keyboard shortcut. */
export async function waitForControlUiTerminalReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (
        document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { available?: boolean })
          | null
      )?.available === true,
  );
}

/** Settings owns the navigation only after its old app sidebar has yielded. */
export async function waitForControlUiSettingsSidebar(
  page: Page,
  previousAppSidebar?: Locator,
): Promise<ReadyControlUiSettingsSidebar> {
  if (previousAppSidebar) {
    await previousAppSidebar.waitFor({ state: "hidden" });
  }
  const sidebar = page.locator(".settings-sidebar");
  const search = sidebar.getByRole("searchbox", { name: "Search settings" });
  await sidebar.waitFor({ state: "visible" });
  await search.waitFor({ state: "visible" });
  return { search, sidebar };
}
