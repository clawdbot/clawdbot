import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  openSessionOwnershipMenu,
  sessionOwnershipList,
} from "./session-ownership.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session owner filter persistence",
});

let page: Page | undefined;

suite.define(() => {
  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  it("restores an owner filter after a full reload", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const allSessions = sessionOwnershipList(["profile-ada", "profile-bob"]);
    const gateway = await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:ada",
      methodResponses: { "sessions.list": allSessions },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await gateway.setMethodResponse("sessions.list", {
      ...allSessions,
      count: 1,
      sessions: allSessions.sessions.filter((session) => session.key === "agent:main:ada"),
    });
    const menu = await openSessionOwnershipMenu(currentPage);
    await menu.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value: "owner:profile-ada" } },
        }),
      ),
    );
    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);

    await currentPage.reload();
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).at(-1)?.params)
      .toMatchObject({ ownerId: "profile-ada" });
    const reloadedMenu = await openSessionOwnershipMenu(currentPage);
    await expectBrowser(reloadedMenu.locator('[value="owner:profile-ada"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
