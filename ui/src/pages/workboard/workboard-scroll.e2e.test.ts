import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import {
  cardFitsWithinWorkboardContent,
  createMobileScrollCards,
  expectedMobileScrollGeometry,
  readMobileScrollGeometry,
} from "./workboard-scroll.e2e.test-support.ts";
import { workboardUi } from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard mobile scroll E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const baseTime = Date.parse("2026-06-01T18:00:00.000Z");

function workboardConfigSnapshot() {
  const config = { plugins: { entries: { workboard: { enabled: true } } } };
  return {
    config,
    hash: "workboard-mobile-scroll-e2e-config",
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config),
    resolved: config,
    sourceConfig: config,
  };
}

suite.define(() => {
  it("scrolls the toolbar and cards together at the mobile breakpoint", async () => {
    await suite.withPage({}, async ({ page }) => {
      const cards = createMobileScrollCards(baseTime);
      await page.setViewportSize({ height: 700, width: 390 });
      await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": {
            count: 0,
            defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
            path: "",
            sessions: [],
            ts: baseTime,
          },
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": {
            boards: [
              {
                id: "default",
                total: cards.length,
                active: cards.length,
                archived: 0,
                byStatus: {},
              },
            ],
            cards,
            statuses: [
              "triage",
              "backlog",
              "todo",
              "scheduled",
              "ready",
              "running",
              "review",
              "blocked",
              "done",
            ],
          },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}workboard`))?.status()).toBe(200);
      const content = page.locator(".content--workboard");
      const board = page.locator(".workboard-board");
      const toolbar = page.locator(".workboard-toolbar");
      const lastCard = page
        .locator(".workboard-column--todo .workboard-card", {
          hasText: "Mobile workboard card 6",
        })
        .first();
      await lastCard.waitFor({ state: "attached" });

      expect(await readMobileScrollGeometry(content, "Mobile workboard card 6")).toEqual(
        expectedMobileScrollGeometry,
      );
      const initialToolbarTop = await toolbar.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await content.hover();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await cardFitsWithinWorkboardContent(lastCard)) {
          break;
        }
        const previousScrollTop = await content.evaluate((element) => element.scrollTop);
        await page.mouse.wheel(0, 320);
        await expect
          .poll(() => content.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(previousScrollTop);
      }
      await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await cardFitsWithinWorkboardContent(lastCard)).toBe(true);
      expect(await toolbar.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(
        initialToolbarTop,
      );
      expect(await board.evaluate((element) => element.scrollTop)).toBe(0);
    });
  });
});
