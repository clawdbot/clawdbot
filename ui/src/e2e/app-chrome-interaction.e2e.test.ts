// Control UI tests cover contextual scrollbars and native-style text selection.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "app-chrome-interaction",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function dragAcross(page: Page, locator: Locator): Promise<string> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected a visible text-selection target");
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(3, box.width - 2), y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
}

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, fileName),
  });
}

describeControlUiE2e("Control UI app chrome interaction mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("uses compact sidebar scrollbars and keeps selection in chat and inputs", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureUiProofEnabled
        ? { dir: path.join(uiProofArtifactDir, "video"), size: { height: 900, width: 1440 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Selectable transcript content" }],
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const transcript = page.getByText("Selectable transcript content", { exact: true });
      await transcript.waitFor();
      const chatStyles = await page.evaluate(() => {
        const sidebar = document.querySelector<HTMLElement>(".sidebar");
        const sessions = document.querySelector<HTMLElement>(".sidebar-shell__body");
        const thread = document.querySelector<HTMLElement>(".chat-thread");
        if (!sidebar || !sessions || !thread) {
          throw new Error("Missing chat interaction surface");
        }
        return {
          chatSelection: getComputedStyle(thread).userSelect,
          chatScrollbar: getComputedStyle(thread, "::-webkit-scrollbar").width,
          sidebarSelection: getComputedStyle(sidebar).userSelect,
          sidebarScrollbar: getComputedStyle(sessions, "::-webkit-scrollbar").width,
        };
      });
      expect(chatStyles).toEqual({
        chatSelection: "text",
        chatScrollbar: "12px",
        sidebarSelection: "none",
        sidebarScrollbar: "6px",
      });
      expect(await dragAcross(page, transcript)).toContain("Selectable transcript");
      await captureUiProof(page, "01-chat-selectable-transcript.png");

      await page.setViewportSize({ height: 650, width: 1440 });
      await page.goto(`${server.baseUrl}settings/general`);
      const settingsSidebar = page.locator(".settings-sidebar");
      const settingsTitle = settingsSidebar.locator(".settings-sidebar__title");
      const settingsSearch = settingsSidebar.locator(".settings-sidebar__search-input");
      const content = page.locator(".content");
      await settingsSidebar.waitFor();
      await expect
        .poll(() => content.evaluate((element) => element.scrollHeight))
        .toBeGreaterThan(await content.evaluate((element) => element.clientHeight));

      const settingsStyles = await page.evaluate(() => {
        const contentNode = document.querySelector<HTMLElement>(".content");
        const nav = document.querySelector<HTMLElement>(".settings-sidebar__nav");
        const search = document.querySelector<HTMLElement>(".settings-sidebar__search-input");
        const sidebar = document.querySelector<HTMLElement>(".settings-sidebar");
        if (!contentNode || !nav || !search || !sidebar) {
          throw new Error("Missing settings interaction surface");
        }
        return {
          contentScrollbar: getComputedStyle(contentNode, "::-webkit-scrollbar").width,
          contentSelection: getComputedStyle(contentNode).userSelect,
          inputSelection: getComputedStyle(search).userSelect,
          sidebarScrollbar: getComputedStyle(nav, "::-webkit-scrollbar").width,
          sidebarSelection: getComputedStyle(sidebar).userSelect,
        };
      });
      expect(settingsStyles).toEqual({
        contentScrollbar: "12px",
        contentSelection: "none",
        inputSelection: "text",
        sidebarScrollbar: "6px",
        sidebarSelection: "none",
      });

      await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
      expect(await dragAcross(page, settingsTitle)).toBe("");
      await settingsSearch.selectText();
      expect(
        await settingsSearch.evaluate(
          (element) =>
            element instanceof HTMLInputElement &&
            element.selectionStart === 0 &&
            element.selectionEnd === element.value.length,
        ),
      ).toBe(true);
      await content.evaluate((element) => {
        element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
      });
      await captureUiProof(page, "02-settings-contextual-scrollbars.png");
    } finally {
      await context.close();
    }
  });
});
