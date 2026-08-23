// Control UI tests cover contextual scrollbars and native-style text selection.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI app chrome interaction mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "app-chrome-interaction",
);

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

async function readFocusOutline(locator: Locator) {
  return locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    const colorProbe = document.createElement("span");
    colorProbe.style.color = "var(--muted-strong)";
    document.body.append(colorProbe);
    const mutedStrongColor = getComputedStyle(colorProbe).color;
    colorProbe.remove();
    return {
      focusVisible: element.matches(":focus-visible"),
      mutedStrongColor,
      outlineColor: styles.outlineColor,
      outlineOffset: styles.outlineOffset,
      outlineStyle: styles.outlineStyle,
      outlineWidth: styles.outlineWidth,
    };
  });
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

suite.define(() => {
  it("uses compact sidebar scrollbars and keeps selection in chat and inputs", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: path.join(uiProofArtifactDir, "video"), size: { height: 900, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Selectable transcript content" }],
            },
          ],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
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
        const thread = page.locator(".chat-thread");
        expect(await readFocusOutline(thread)).toMatchObject({
          focusVisible: false,
          outlineStyle: "none",
        });
        await captureUiProof(page, "01-chat-selectable-transcript.png");

        await thread.focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => thread.evaluate((element) => element !== document.activeElement))
          .toBe(true);
        await page.keyboard.press("Shift+Tab");
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element === document.activeElement && element.matches(":focus-visible"),
            ),
          )
          .toBe(true);
        const focusedOutline = await readFocusOutline(thread);
        expect(focusedOutline).toMatchObject({
          focusVisible: true,
          outlineOffset: "-2px",
          outlineStyle: "solid",
          outlineWidth: "2px",
        });
        expect(focusedOutline.outlineColor).toBe(focusedOutline.mutedStrongColor);
        await captureUiProof(page, "02-chat-thread-keyboard-focus.png");

        await page.setViewportSize({ height: 650, width: 1440 });
        // Appearance renders schema-independent theme/UI sections that overflow
        // 650px even against the mock gateway's tiny config fixture; General
        // became short enough to fit once the host panel moved to Gateway.
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
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
        await captureUiProof(page, "03-settings-contextual-scrollbars.png");
      },
    );
  });
});
