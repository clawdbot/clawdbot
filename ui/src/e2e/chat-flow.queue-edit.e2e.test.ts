import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const QUEUED = ["review the migration", "then update the docs", "finally run the smoke"] as const;

/** Vertical centre of each control on the composer's input row, in page pixels. */
const COMPOSER_ROW_CONTROLS = [
  ".agent-chat__input-btn--attach",
  ".agent-chat__composer-edit",
  ".agent-chat__composer-combobox textarea",
  ".agent-chat__composer-actions",
] as const;

suite.define(() => {
  it("edits a queued message in the composer and returns it to its place", async () => {
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

      // Offline holds the queue still, so the round-trip stays observable.
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }
      const queueText = () => page.locator(".chat-queue__item .chat-queue__text").allTextContents();
      expect(await queueText()).toEqual([...QUEUED]);

      // Double-click is the shortcut; the pencil on the row is the visible path.
      await page.locator(".chat-queue__item").nth(1).dblclick();

      await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe(QUEUED[1]);
      await page.locator(".agent-chat__composer-edit").waitFor({ timeout: 10_000 });
      // The row stays where it is, marked as the one being edited.
      expect(await queueText()).toEqual([...QUEUED]);
      expect(await page.locator(".chat-queue__item--editing").count()).toBe(1);
      expect(
        await page.locator(".chat-queue__item").nth(1).locator(".chat-queue__badge").textContent(),
      ).toBe("Editing");

      // The marker is a new child of a bottom-aligned row, so prove the row still
      // resolves to one axis instead of trusting that it looks right.
      const centres = await page.evaluate(
        (selectors) => {
          const row = document.querySelector(".agent-chat__composer-input-row");
          return selectors.map((selector) => {
            const box = row?.querySelector(selector)?.getBoundingClientRect();
            return box ? box.top + box.height / 2 : Number.NaN;
          });
        },
        COMPOSER_ROW_CONTROLS as unknown as string[],
      );
      expect(centres.some(Number.isNaN)).toBe(false);
      expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);

      await composer.fill("then update the docs and the changelog");
      await composer.press("Enter");

      await expect
        .poll(queueText, { timeout: 10_000 })
        .toEqual([QUEUED[0], "then update the docs and the changelog", QUEUED[2]]);
      expect(await page.locator(".agent-chat__composer-edit").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("puts the row back untouched when the edit is cancelled", async () => {
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
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      const row = page.locator(".chat-queue__item").nth(1);
      await row.locator(".chat-queue__edit").click();
      await page.locator(".agent-chat__composer-edit").waitFor({ timeout: 10_000 });
      await composer.fill("a replacement the operator abandons");

      await page.locator(".agent-chat__composer-edit-cancel").click();

      await expect
        .poll(() => page.locator(".chat-queue__item .chat-queue__text").allTextContents(), {
          timeout: 10_000,
        })
        .toEqual([...QUEUED]);
      expect(await composer.inputValue()).toBe("");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
