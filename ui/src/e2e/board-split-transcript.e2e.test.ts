// Regression: the chat transcript must repaint after a dashboard -> split face
// switch re-stamps it into the sidebar region (issue: virtualizer stayed
// detached until an unrelated re-render, painting a blank pane).
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const sessionKey = "agent:main:board-split-transcript";

let browser: Browser;
let controlUi: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();

function boardSnapshot(chatDock: "right" | "hidden", revision = 1) {
  return {
    sessionKey,
    revision,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock }],
    widgets: [],
  };
}

async function visibleTranscriptState(page: Page) {
  return await page.evaluate(() => {
    const inner = [...document.querySelectorAll<HTMLElement>(".chat-thread-inner--virtual")].find(
      (candidate) => {
        const cachePane = candidate.closest(".chat-pane-cache__pane");
        return !cachePane || cachePane.classList.contains("chat-pane-cache__pane--visible");
      },
    );
    const scroller = inner?.parentElement;
    if (!inner || !scroller) {
      return { present: false, intersectingRows: 0 };
    }
    const rect = scroller.getBoundingClientRect();
    const intersectingRows = [...inner.querySelectorAll<HTMLElement>(".chat-virtual-row")].filter(
      (row) => {
        const rowRect = row.getBoundingClientRect();
        return rowRect.bottom > rect.top && rowRect.top < rect.bottom;
      },
    ).length;
    return { present: true, intersectingRows };
  });
}

describeControlUiE2e("Board split transcript restore", () => {
  beforeAll(async () => {
    controlUi = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    for (const context of contexts) {
      await context.close();
    }
    await browser?.close();
    await controlUi?.close();
  });

  it("repaints the docked transcript after dashboard -> split", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    contexts.add(context);
    const page = await context.newPage();
    const now = Date.now();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "board.update",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "sessions.patch",
      ],
      methodResponses: {
        "board.get": boardSnapshot("right"),
        "board.update": {
          sequence: [boardSnapshot("hidden", 2), boardSnapshot("right", 3)],
        },
      },
      historyMessages: Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Message number ${index}: the quick brown fox jumps over the lazy dog to give this bubble a realistic height.`,
        timestamp: now - (40 - index) * 60_000,
      })),
    });

    const settingsKey = controlUiBundledSettingsStorageKey(controlUi.baseUrl);
    await page.addInitScript(
      ({ key, storageKey }) => {
        const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
          string,
          unknown
        >;
        settings.boardSessionViews = { [key]: { activeTabId: "main" } };
        localStorage.setItem(storageKey, JSON.stringify(settings));
      },
      { key: sessionKey, storageKey: settingsKey },
    );
    await page.goto(`${controlUi.baseUrl}dashboard`);
    await page.locator(".board-session-surface").waitFor();
    await page.getByText("Message number 39:").first().waitFor({ timeout: 15_000 });

    const mode = (value: "split" | "dashboard") =>
      page.locator(`wa-radio.settings-segmented__btn[value="${value}"]`);

    // Defer each dock update so the pane render that stamps the transcript into
    // the sidebar region arrives alone, as it does against a remote gateway.
    // With instant responses the click-time renders coalesce and mask the bug.
    await gateway.deferNext("board.update");
    await mode("dashboard").click();
    await page.waitForTimeout(200);
    await gateway.resolveDeferred("board.update");
    await expect
      .poll(async () => (await visibleTranscriptState(page)).present, { timeout: 5_000 })
      .toBe(false);

    await gateway.deferNext("board.update");
    await mode("split").click();
    await page.waitForTimeout(200);
    await gateway.resolveDeferred("board.update");

    // The transcript must repaint promptly from the dock-restore render itself,
    // without waiting for an unrelated state change to re-render the pane.
    await expect
      .poll(async () => await visibleTranscriptState(page), { timeout: 2_000 })
      .toMatchObject({ present: true, intersectingRows: expect.any(Number) });
    await expect
      .poll(async () => (await visibleTranscriptState(page)).intersectingRows, { timeout: 2_000 })
      .toBeGreaterThan(0);
    await page
      .getByText("Message number 39:")
      .first()
      .waitFor({ state: "visible", timeout: 2_000 });
  }, 120_000);
});
