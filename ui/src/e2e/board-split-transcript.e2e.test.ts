// Regression: the chat transcript must repaint after a dashboard -> split face
// switch re-stamps it into the sidebar region (issue: virtualizer stayed
// detached until an unrelated re-render, painting a blank pane).
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const sessionKey = "agent:main:board-split-transcript";
const proofDir = path.resolve(".artifacts/control-ui-e2e/dashboard-side-chat-tabs");

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

async function showDashboard(page: Page) {
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
}

async function expectSidePanelTabs(page: Page, expected: string[]) {
  const labels = page.locator(".side-panel > .side-panel__header .tabstrip-tab__label");
  await expect
    .poll(() => labels.allTextContents().then((values) => values.toSorted()))
    .toEqual(expected.toSorted());
  await labels.first().waitFor({ state: "visible" });
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

    await showDashboard(page);
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

  it("closes and reopens the whole multi-tab dashboard side panel", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      terminalEnabled: true,
      featureMethods: [
        "board.get",
        "board.update",
        "browser.request",
        "chat.metadata",
        "chat.startup",
        "terminal.open",
      ],
      methodResponses: {
        "board.get": boardSnapshot("right"),
        "board.update": boardSnapshot("right", 2),
        "browser.request": {
          cases: [
            { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
          ],
        },
      },
    });
    await showDashboard(page);
    await page.locator(".side-panel").waitFor();
    await openChatSidePanelType(page, "Browser");
    await openChatSidePanelType(page, "Terminal");

    const board = page.locator(".board-session-surface__board");
    const sidePanel = page.locator(".side-panel");
    await sidePanel.waitFor();
    const expectedTabLabels = ["Board chat", "Browser", "Terminal"];
    await expectSidePanelTabs(page, expectedTabLabels);
    await sidePanel
      .locator(".side-panel-type-menu wa-dropdown-item")
      .first()
      .waitFor({ state: "hidden" });
    const widthBeforeClose = await board.evaluate(
      (element) => element.getBoundingClientRect().width,
    );

    await sidePanel.getByRole("button", { name: "Close", exact: true }).click();

    await expect.poll(() => sidePanel.count()).toBe(0);
    await expect
      .poll(() => board.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(widthBeforeClose);
    expect(await gateway.getRequests("board.update")).toEqual([]);

    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await sidePanel.waitFor();
    await expectSidePanelTabs(page, expectedTabLabels);
    expect(await sidePanel.locator('[data-panel-slot="chat"]').count()).toBe(1);
    expect(await gateway.getRequests("board.update")).toEqual([]);
  }, 120_000);

  it("activates Side chat from a split dashboard panel", async () => {
    const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    if (recordProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      ...(recordProof
        ? { recordVideo: { dir: proofDir, size: { width: 1400, height: 900 } } }
        : {}),
    });
    contexts.add(context);
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "board.update",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "sessions.companion.ask",
      ],
      methodResponses: {
        "board.get": boardSnapshot("right"),
        "board.update": boardSnapshot("right", 2),
      },
      historyMessages: [
        { role: "user", content: "Keep the dashboard visible while I open a side chat." },
        { role: "assistant", content: "The board chat is currently active." },
      ],
    });

    try {
      await showDashboard(page);
      const sidePanel = page.locator(".side-panel");
      await sidePanel.waitFor();
      await openChatSidePanelType(page, "Side chat");
      await expectSidePanelTabs(page, ["Board chat", "Side chat"]);
      if (recordProof) {
        await page.screenshot({ path: path.join(proofDir, "01-side-chat-added.png") });
      }

      await sidePanel.locator("wa-tab").filter({ hasText: "Side chat" }).click();
      await sidePanel.locator('[data-panel-slot="companion"]:not([hidden])').waitFor();
      await expect
        .poll(() =>
          sidePanel
            .locator('[data-panel-slot="chat"]')
            .evaluate((panel) => panel.hasAttribute("hidden")),
        )
        .toBe(true);
      if (recordProof) {
        await page.screenshot({ path: path.join(proofDir, "02-side-chat-active.png") });
      }
    } finally {
      const video = page.video();
      await context.close();
      contexts.delete(context);
      if (recordProof && video) {
        await video.saveAs(path.join(proofDir, "dashboard-side-chat-tabs.webm"));
      }
    }
  }, 120_000);

  it("closes and reopens sole projected Board chat from either close control", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.get", "board.update", "chat.metadata", "chat.startup"],
      methodResponses: {
        "board.get": boardSnapshot("right"),
        "board.update": boardSnapshot("right", 2),
      },
    });
    await showDashboard(page);

    const sidePanel = page.locator(".side-panel");
    const headerToggle = page.locator(".chat-side-panel-toggle").first();
    await sidePanel.waitFor();
    await expectSidePanelTabs(page, ["Board chat"]);
    await expect.poll(() => headerToggle.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => headerToggle.getAttribute("aria-label")).toBe("Minimize side panel");

    await sidePanel.getByRole("button", { name: "Close", exact: true }).click();

    await expect.poll(() => sidePanel.count()).toBe(0);
    expect(await headerToggle.getAttribute("aria-expanded")).toBe("false");
    expect(await headerToggle.getAttribute("aria-label")).toBe("Side panel");
    expect(await gateway.getRequests("board.update")).toEqual([]);

    await headerToggle.click();
    await sidePanel.waitFor();
    await expectSidePanelTabs(page, ["Board chat"]);
    expect(await headerToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await gateway.getRequests("board.update")).toEqual([]);

    await headerToggle.click();
    await expect.poll(() => sidePanel.count()).toBe(0);
    expect(await headerToggle.getAttribute("aria-expanded")).toBe("false");
    expect(await gateway.getRequests("board.update")).toEqual([]);

    await headerToggle.click();
    await sidePanel.waitFor();
    await expectSidePanelTabs(page, ["Board chat"]);
  }, 120_000);
});
