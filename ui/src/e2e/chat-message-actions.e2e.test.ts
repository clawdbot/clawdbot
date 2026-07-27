// Real-browser proof for inline and context-menu chat message actions.
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-message-actions");

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, fileName: string): Promise<void> {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({ animations: "disabled", path: path.join(artifactDir, fileName) });
}

async function expectHoverTooltip(button: Locator, text: string): Promise<void> {
  await button.hover();
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const tooltip = element
          .closest("openclaw-tooltip")
          ?.shadowRoot?.querySelector<
            HTMLElement & { anchor?: Element | null; popup?: { active?: boolean } }
          >("wa-tooltip");
        const body = tooltip?.shadowRoot?.querySelector<HTMLElement>('[part="body"]');
        const bounds = body?.getBoundingClientRect();
        return {
          anchorMatches: tooltip?.anchor === element,
          height: bounds?.height ?? 0,
          hidden: body?.hidden ?? true,
          open: tooltip?.hasAttribute("open") ?? false,
          popupActive: tooltip?.popup?.active ?? false,
          text: tooltip?.textContent?.trim() ?? "",
          width: bounds?.width ?? 0,
        };
      }),
    )
    .toMatchObject({
      anchorMatches: true,
      hidden: false,
      open: true,
      popupActive: true,
      text,
    });
  const bounds = await button.evaluate((element) => {
    const body = element
      .closest("openclaw-tooltip")
      ?.shadowRoot?.querySelector<HTMLElement>("wa-tooltip")
      ?.shadowRoot?.querySelector<HTMLElement>('[part="body"]');
    const slot = body?.querySelector<HTMLSlotElement>("slot");
    const textNode = slot?.assignedNodes().find((node) => node.textContent?.trim());
    const range = textNode ? document.createRange() : null;
    if (range && textNode) {
      range.selectNodeContents(textNode);
    }
    const bodyRect = body?.getBoundingClientRect();
    const textRect = range?.getBoundingClientRect();
    return {
      height: bodyRect?.height ?? 0,
      textTopInset: bodyRect && textRect ? textRect.top - bodyRect.top : Number.POSITIVE_INFINITY,
      width: bodyRect?.width ?? 0,
    };
  });
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.textTopInset).toBeLessThan(12);
}

async function expectHoverColor(
  button: Locator,
  colorVariable: "--accent" | "--danger",
): Promise<void> {
  const restingColor = await button.evaluate((element) => getComputedStyle(element).color);
  const hoverColor = await button.evaluate((_, cssVariable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${cssVariable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, colorVariable);
  expect(restingColor).not.toBe(hoverColor);
  await button.hover();
  await expect
    .poll(() => button.evaluate((element) => getComputedStyle(element).color))
    .toBe(hoverColor);
}

describeControlUiE2e("Control UI chat message actions", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    if (captureUiProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("offers Reply inline and mirrors every assistant action in the context menu", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureUiProof
        ? { dir: path.join(artifactDir, "video"), size: { height: 900, width: 1440 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(server.baseUrl).origin,
    });
    const page = await context.newPage();
    const messageText = "Reply and context menu action proof.";
    const privateThinking = "private reply reasoning";
    const visibleThinkingAnswer = "Visible reply context only.";
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: messageText }],
          timestamp: Date.now(),
          __openclaw: { id: "assistant-action-proof", seq: 1 },
        },
        {
          role: "user",
          content: [{ type: "text", text: "Keep the next assistant message separate." }],
          timestamp: Date.now() + 1,
          __openclaw: { id: "user-action-separator", seq: 2 },
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `<thinking>${privateThinking}</thinking>${visibleThinkingAnswer}`,
            },
          ],
          timestamp: Date.now() + 2,
          __openclaw: { id: "assistant-thinking-proof", seq: 3 },
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.evaluate(() => document.documentElement.setAttribute("data-theme-mode", "dark"));
      const commandPaletteShortcut = process.platform === "darwin" ? "⌘K" : "Ctrl K";
      await expectHoverTooltip(page.getByRole("button", { name: "New thread" }), "New thread");
      await expectHoverTooltip(
        page.getByRole("button", { name: "Open command palette" }),
        `Open command palette (${commandPaletteShortcut})`,
      );
      await expectHoverTooltip(
        page.getByRole("button", { name: "Collapse sidebar" }),
        "Collapse sidebar (⌘B)",
      );
      await expectHoverTooltip(
        page.getByRole("button", { name: "Open split view" }),
        "Open split view",
      );
      await page.evaluate(() => {
        const tooltip = document.createElement("openclaw-tooltip");
        tooltip.setAttribute("content", "First line\nSecond line");
        const trigger = document.createElement("button");
        trigger.textContent = "Multiline tooltip probe";
        trigger.style.position = "fixed";
        trigger.style.inset = "80px auto auto 280px";
        trigger.style.zIndex = "10000";
        tooltip.append(trigger);
        document.body.append(tooltip);
      });
      const multilineTooltipButton = page.getByRole("button", {
        name: "Multiline tooltip probe",
      });
      await expectHoverTooltip(multilineTooltipButton, "First line\nSecond line");
      expect(
        await multilineTooltipButton.evaluate((element) => {
          const content = element
            .closest("openclaw-tooltip")
            ?.shadowRoot?.querySelector<HTMLElement>(".tooltip-content");
          if (!content) {
            return 0;
          }
          const range = document.createRange();
          range.selectNodeContents(content);
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        }),
      ).toBe(2);
      await multilineTooltipButton.evaluate((element) =>
        element.closest("openclaw-tooltip")?.remove(),
      );
      await screenshot(page, "00-header-tooltips.png");
      const group = page.locator(".chat-group.assistant").filter({ hasText: messageText });
      const bubble = group.locator(".chat-bubble");
      await bubble.waitFor({ state: "visible" });

      const thinkingGroup = page
        .locator(".chat-group.assistant")
        .filter({ hasText: visibleThinkingAnswer });
      await thinkingGroup.hover();
      await thinkingGroup.getByRole("button", { name: "Reply to message" }).click();
      const thinkingReplyPreview = page.locator(".chat-reply-preview");
      await thinkingReplyPreview.waitFor({ state: "visible" });
      expect(await thinkingReplyPreview.locator(".chat-reply-preview__text").textContent()).toBe(
        visibleThinkingAnswer,
      );
      expect(await thinkingReplyPreview.textContent()).not.toContain(privateThinking);
      await thinkingReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      await group.hover();

      const inlineActions = group.locator(".chat-group-footer-actions button");
      expect(
        await inlineActions.evaluateAll((buttons) => buttons.map((button) => button.ariaLabel)),
      ).toEqual(["Reply to message", "Hide message", "Open in canvas", "Copy as markdown"]);
      for (const button of await inlineActions.all()) {
        const label = await button.getAttribute("aria-label");
        await expectHoverColor(button, label === "Hide message" ? "--danger" : "--accent");
      }
      const replyButton = group.getByRole("button", { name: "Reply to message" });
      await expectHoverTooltip(replyButton, "Reply");
      await screenshot(page, "01-inline-actions.png");

      await replyButton.click();
      const replyPreview = page.locator(".chat-reply-preview");
      await replyPreview.waitFor({ state: "visible" });
      expect(await replyPreview.locator(".chat-reply-preview__text").textContent()).toBe(
        messageText,
      );
      await screenshot(page, "02-reply-preview.png");
      await replyPreview.getByRole("button", { name: "Cancel reply" }).click();

      const menu = page.locator(".chat-reply-context-menu");
      const selectedText = "context menu";
      await bubble.evaluate((element, text) => {
        const selection = window.getSelection();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let textNode: Text | null = null;
        let start = -1;
        while (walker.nextNode()) {
          const candidate = walker.currentNode;
          const candidateText = candidate.textContent ?? "";
          const candidateStart = candidateText.indexOf(text);
          if (candidate instanceof Text && candidateStart >= 0) {
            textNode = candidate;
            start = candidateStart;
            break;
          }
        }
        if (!textNode) {
          throw new Error(`Could not find selectable text: ${text}`);
        }
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, start + text.length);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }, selectedText);
      await bubble.click({ button: "right" });
      await menu.waitFor({ state: "visible" });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Copy",
        "Reply",
        "Hide message",
        "Open in canvas",
        "Copy as markdown",
      ]);
      await screenshot(page, "03-selected-text-context-menu.png");
      await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(selectedText);

      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await bubble.click({ button: "right" });
      await menu.waitFor({ state: "visible" });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Reply",
        "Hide message",
        "Open in canvas",
        "Copy as markdown",
      ]);
      expect(
        await menu.getByRole("menuitem", { name: "Reply to message" }).locator("svg").count(),
      ).toBe(0);
      await screenshot(page, "04-context-menu.png");

      await menu.getByRole("menuitem", { name: "Copy as markdown" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(messageText);

      await bubble.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open in canvas" }).click();
      const markdownSidebar = page.locator(".sidebar-markdown");
      await markdownSidebar.getByText(messageText, { exact: true }).waitFor({ state: "visible" });

      await bubble.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Hide message" }).click();
      await page.locator(".chat-delete-confirm").getByRole("button", { name: "Hide" }).click();
      await expect.poll(() => group.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
