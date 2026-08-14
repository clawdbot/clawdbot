import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const QUEUED = ["review the migration", "then update the docs", "finally run the smoke"] as const;

suite.define(() => {
  it("reorders offline queued messages from the keyboard-focused handle", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 });

      // Offline is the honest way to hold a queue still: nothing drains while
      // the Gateway is gone, so the rows stay observable.
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      const queueText = () => page.locator(".chat-queue__item .chat-queue__text").allTextContents();
      expect(await queueText()).toEqual([...QUEUED]);

      // One handle per movable row, and it is the whole reorder surface.
      expect(await page.locator(".chat-queue__grip").count()).toBe(QUEUED.length);

      // Keyboard path: focus the last row's handle and walk it up the queue.
      await page.locator(".chat-queue__item").nth(2).locator(".chat-queue__grip").focus();
      await page.keyboard.press("ArrowUp");

      await expect.poll(queueText, { timeout: 10_000 }).toEqual([QUEUED[0], QUEUED[2], QUEUED[1]]);

      // Focus follows the moved row, so a second press keeps moving the same one.
      await page.keyboard.press("ArrowUp");

      await expect.poll(queueText, { timeout: 10_000 }).toEqual([QUEUED[2], QUEUED[0], QUEUED[1]]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
