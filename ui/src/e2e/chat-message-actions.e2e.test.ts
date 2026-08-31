// Real-browser proof for inline and context-menu chat message actions.
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
let artifactDir: string;
beforeEach(() => {
  if (captureUiProof) {
    artifactDir = createControlUiE2eArtifactDir("chat-message-actions");
  }
});

// Neutral filler line repeated to push the fixture past the transport
// preview limit without embedding stale implementation narrative; the
// heading, list, code block, and path sample below exercise Markdown
// rendering, while the repeated line only pads length.
const FULL_ASSISTANT_CONTENT_FILLER_LINE =
  "Repeat neutral filler text to exceed the transport preview limit while staying deterministic and readable.\n";

const realisticFullAssistantContent = `# Deployment report

## Summary

- service: payment-gateway
- environment: production
- status: completed

## Rollout steps

1. Build the release artifact and run smoke tests.
2. Deploy to the canary pool and watch the error budget.
3. Promote to the full fleet.

~~~ts
export function verifyRollout(serviceName: string): Promise<boolean> {
  return healthCheck(serviceName);
}
~~~

Reference: src/services/payment-gateway/deploy.ts:88

${FULL_ASSISTANT_CONTENT_FILLER_LINE.repeat(75)}
## Final verification

All health checks passed and the rollout is complete.`;

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, fileName: string): Promise<void> {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({ animations: "disabled", path: path.join(artifactDir, fileName) });
}

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
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
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps assistant actions hidden when the user message is last", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: "Earlier assistant reply.",
          timestamp: Date.now() - 4_000,
          __openclaw: { id: "earlier-assistant", seq: 1 },
        },
        {
          role: "user",
          content: "A question between replies.",
          timestamp: Date.now() - 3_000,
          __openclaw: { id: "middle-user", seq: 2 },
        },
        {
          role: "assistant",
          content: "Latest assistant lead-in.",
          timestamp: Date.now() - 2_000,
          __openclaw: { id: "latest-assistant", seq: 3 },
        },
        {
          role: "assistant",
          content: "Latest assistant reply.",
          timestamp: Date.now() - 1_500,
          __openclaw: { id: "latest-assistant-final", seq: 4 },
        },
        {
          role: "user",
          content: "A newer user follow-up.",
          timestamp: Date.now() - 1_000,
          __openclaw: { id: "latest-user", seq: 5 },
        },
      ],
    });

    const presentation = (group: Locator) =>
      group.evaluate((element) => {
        const footer = element.querySelector<HTMLElement>(".chat-group-footer");
        const action = element.querySelector<HTMLElement>(".chat-group-footer-actions button");
        return {
          actionOpacity: action ? getComputedStyle(action).opacity : null,
          actionPointerEvents: action ? getComputedStyle(action).pointerEvents : null,
          footerOpacity: footer ? getComputedStyle(footer).opacity : null,
          footerPointerEvents: footer ? getComputedStyle(footer).pointerEvents : null,
        };
      });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.mouse.move(0, 0);
      const assistantGroups = page.locator(".chat-group.assistant");
      await expect.poll(() => assistantGroups.count()).toBe(2);
      const earlierAssistant = assistantGroups.first();
      const latestAssistant = assistantGroups.last();
      await latestAssistant.getByText("Latest assistant reply.", { exact: true }).waitFor();
      const inlineAction = latestAssistant.locator(".chat-message-actions-row button").first();
      await expect.poll(() => inlineAction.count()).toBe(1);

      await screenshot(page, "user-last-assistant-actions-hidden-desktop.png");
      await expect
        .poll(() => presentation(earlierAssistant))
        .toEqual({
          actionOpacity: "0",
          actionPointerEvents: "none",
          footerOpacity: "0",
          footerPointerEvents: "none",
        });
      await expect
        .poll(() => presentation(latestAssistant))
        .toEqual({
          actionOpacity: "0",
          actionPointerEvents: "none",
          footerOpacity: "0",
          footerPointerEvents: "none",
        });
      await expect
        .poll(() =>
          inlineAction.evaluate((element) => ({
            opacity: getComputedStyle(element).opacity,
            pointerEvents: getComputedStyle(element).pointerEvents,
          })),
        )
        .toEqual({ opacity: "0", pointerEvents: "none" });

      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot(page, "latest-assistant-actions-resting-mobile.png");
      await expect
        .poll(() => presentation(latestAssistant))
        .toEqual({
          actionOpacity: "0",
          actionPointerEvents: "none",
          footerOpacity: "0",
          footerPointerEvents: "none",
        });
      await latestAssistant.locator(".chat-bubble").last().dispatchEvent("pointerup", {
        button: 0,
        pointerType: "touch",
      });
      await expect
        .poll(() => presentation(latestAssistant))
        .toEqual({
          actionOpacity: "1",
          actionPointerEvents: "auto",
          footerOpacity: "1",
          footerPointerEvents: "auto",
        });
      await expect
        .poll(() =>
          inlineAction.evaluate((element) => ({
            opacity: getComputedStyle(element).opacity,
            pointerEvents: getComputedStyle(element).pointerEvents,
          })),
        )
        .toEqual({ opacity: "1", pointerEvents: "auto" });
    } finally {
      await context.close();
    }
  });

  it("shares tooltip styling and dismissal across message metadata, actions, and file hints", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      hasTouch: true,
      locale: "en-US",
      recordVideo: captureUiProof
        ? { dir: path.join(artifactDir, "tooltips-video"), size: { height: 900, width: 1440 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Tooltip proof. See /workspace/tooltip-proof.txt." }],
          timestamp: Date.now() - 5 * 60_000,
          model: "openai/gpt-5.6-luna",
          usage: { input: 12_000, output: 300, cost: { total: 0.12 } },
          __openclaw: { id: "tooltip-proof", seq: 1 },
        },
      ],
    });
    const openTooltip = page.locator("wa-tooltip[open]");
    const popupStyle = () =>
      openTooltip.locator('[part="body"]').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.border,
          radius: style.borderRadius,
          padding: style.padding,
          fontSize: style.fontSize,
        };
      });
    try {
      await page.goto(`${server.baseUrl}chat`);
      const group = page.locator(".chat-group.assistant").filter({ hasText: "Tooltip proof." });
      await group
        .locator(".chat-text")
        .first()
        .tap({ position: { x: 4, y: 4 } });
      const timestamp = group.locator(".msg-meta__summary");
      await timestamp.hover();
      await expect.poll(() => openTooltip.count()).toBe(1);
      await group.locator(".msg-meta__details").waitFor({ state: "visible" });
      const metadataStyle = await popupStyle();
      expect(await group.locator(".msg-meta__details").textContent()).toContain("gpt-5.6-luna");
      expect(await group.locator(".msg-meta__cost").textContent()).toContain("$0.12");
      await screenshot(page, "tooltip-metadata.png");

      await timestamp.click();
      await page.mouse.move(0, 0);
      await expect.poll(() => openTooltip.count()).toBe(1);
      const reply = group.getByRole("button", { name: "Reply to message" });
      await expectHoverTooltip(reply, "Reply");
      await expect.poll(() => openTooltip.count()).toBe(1);
      expect(await popupStyle()).toEqual(metadataStyle);
      await screenshot(page, "tooltip-reply.png");
      await page.keyboard.press("Escape");
      await expect.poll(() => openTooltip.count()).toBe(0);

      const file = group.locator("a").filter({ hasText: "tooltip-proof.txt" });
      await file.hover();
      await expect.poll(() => openTooltip.count()).toBe(1);
      expect(await openTooltip.textContent()).toContain("/workspace/tooltip-proof.txt");
      expect(await popupStyle()).toEqual(metadataStyle);
      expect(await file.getAttribute("title")).toBe("");
      await screenshot(page, "tooltip-file-hint.png");

      await page.setViewportSize({ width: 390, height: 844 });
      await timestamp.tap();
      await expect.poll(() => openTooltip.count()).toBe(1);
      await group.locator(".msg-meta__details").waitFor({ state: "visible" });
      const bounds = await openTooltip.locator('[part="body"]').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await screenshot(page, "tooltip-mobile.png");
      await timestamp.tap();
      await expect.poll(() => openTooltip.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps oversized history notices consistent through recovery and message actions", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
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
    const fullAssistantContent = realisticFullAssistantContent;
    const rawOversizedMarker = "[chat.history omitted: message too large]";
    const oversizedNotice = "This message is too large to display here.";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.message.get"],
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
        {
          role: "user",
          content: [{ type: "text", text: "Keep the truncated message separate." }],
          timestamp: Date.now() + 3,
          __openclaw: { id: "user-truncated-separator", seq: 4 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: rawOversizedMarker }],
          timestamp: Date.now() + 4,
          __openclaw: {
            id: "assistant-full-message",
            seq: 5,
            truncated: true,
            reason: "oversized",
          },
        },
        {
          role: "user",
          content: [{ type: "text", text: rawOversizedMarker }],
          timestamp: Date.now() + 5,
          __openclaw: { id: "oversized-user", seq: 6, truncated: true, reason: "oversized" },
        },
        {
          role: "toolResult",
          toolCallId: "oversized-tool-call-1",
          toolName: "read_file",
          content: rawOversizedMarker,
          timestamp: Date.now() + 6,
          __openclaw: { id: "oversized-tool-1", seq: 7, truncated: true, reason: "oversized" },
        },
        {
          role: "toolResult",
          toolCallId: "oversized-tool-call-2",
          toolName: "run_command",
          content: rawOversizedMarker,
          timestamp: Date.now() + 7,
          __openclaw: { id: "oversized-tool-2", seq: 8, truncated: true, reason: "oversized" },
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await setThemeMode(page, "dark");
      const applePlatform = process.platform === "darwin";
      const commandPaletteShortcut = applePlatform ? "⌘K" : "Ctrl+K";
      const sidebarShortcut = applePlatform ? "⌘B" : "Ctrl+B";
      await expectHoverTooltip(
        page.locator(".sidebar-brand").getByRole("link", { name: "New session" }),
        "New session",
      );
      await expectHoverTooltip(
        page.getByRole("button", { name: "Open command palette" }),
        `Open command palette (${commandPaletteShortcut})`,
      );
      await expectHoverTooltip(
        page.getByRole("button", { name: "Collapse sidebar" }),
        `Collapse sidebar (${sidebarShortcut})`,
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
      ).toEqual(["Reply to message", "Copy as markdown"]);
      for (const button of await inlineActions.all()) {
        await expectHoverColor(button, "--accent");
      }
      const replyButton = group.getByRole("button", { name: "Reply to message" });
      await expectHoverTooltip(replyButton, "Reply");
      await screenshot(page, "01-inline-actions.png");

      await group.hover();
      await replyButton.click();
      const replyPreview = page.locator(".chat-reply-preview");
      await replyPreview.waitFor({ state: "visible" });
      expect(await replyPreview.locator(".chat-reply-preview__text").textContent()).toBe(
        messageText,
      );
      await screenshot(page, "03-reply-preview.png");
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
        "Copy as markdown",
      ]);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          }),
      );
      expect(await page.locator(".chat-selection-popup").count()).toBe(0);
      await screenshot(page, "04-selected-text-context-menu.png");
      await bubble.dispatchEvent("pointerup", {
        button: 0,
        ctrlKey: true,
        pointerType: "mouse",
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          }),
      );
      expect(await page.locator(".chat-selection-popup").count()).toBe(0);
      await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(selectedText);

      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await bubble.click({ button: "right" });
      await menu.waitFor({ state: "visible" });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Reply",
        "Copy as markdown",
      ]);
      expect(
        await menu.getByRole("menuitem", { name: "Reply to message" }).locator("svg").count(),
      ).toBe(0);
      await screenshot(page, "05-context-menu.png");

      await menu.getByRole("menuitem", { name: "Copy as markdown" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(messageText);

      const fullTextBubble = page.locator('.chat-bubble[data-entry-id="assistant-full-message"]');
      const fullTextGroup = fullTextBubble.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-group ')]",
      );
      const fullMessageRequest = await gateway.waitForRequest("chat.message.get");
      expect(fullMessageRequest.params).toMatchObject({
        sessionKey: "agent:main:main",
        messageId: "assistant-full-message",
        maxChars: 500_000,
      });
      await expect
        .poll(() => fullTextBubble.locator(".chat-text").textContent())
        .toContain(oversizedNotice);
      expect(await fullTextBubble.getAttribute("data-message-text")).toBe(oversizedNotice);
      expect(await page.locator("body").textContent()).not.toContain(rawOversizedMarker);
      await screenshot(page, "07-oversized-pending-dark.png");
      const fullTextReplyPreview = page.locator(".chat-reply-preview");
      await fullTextBubble.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Copy as markdown" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(oversizedNotice);
      await fullTextBubble.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Reply to message" }).click();
      await expect
        .poll(() => fullTextReplyPreview.locator(".chat-reply-preview__text").textContent())
        .toBe(oversizedNotice);
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();
      await gateway.resolveDeferred("chat.message.get", {
        ok: true,
        message: { role: "assistant", content: fullAssistantContent },
      });
      const fullTail = fullTextBubble.getByRole("heading", { name: "Final verification" });
      await fullTail.waitFor({ state: "visible" });
      expect(await fullTextBubble.getByRole("button", { name: "Show more" }).count()).toBe(0);
      expect(await fullTextBubble.getByRole("button", { name: "Show less" }).count()).toBe(0);
      await fullTail.scrollIntoViewIfNeeded();
      await screenshot(page, "08-oversized-resolved-dark.png");

      await fullTextGroup.hover();
      await fullTextGroup.getByRole("button", { name: "Copy as markdown" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(fullAssistantContent);
      await fullTextGroup.getByRole("button", { name: "Reply to message" }).click();
      await expect
        .poll(() => fullTextReplyPreview.locator(".chat-reply-preview__text").textContent())
        .toContain("# Deployment report");
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      await fullTextBubble.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Copy as markdown" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(fullAssistantContent);
      await fullTextBubble.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Reply to message" }).click();
      await expect
        .poll(() => fullTextReplyPreview.locator(".chat-reply-preview__text").textContent())
        .toContain("# Deployment report");
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      const userOversizedBubble = page.locator('.chat-bubble[data-entry-id="oversized-user"]');
      expect(await userOversizedBubble.getAttribute("data-message-text")).toBe(oversizedNotice);
      await expect
        .poll(() => userOversizedBubble.locator(".chat-text").textContent())
        .toContain(oversizedNotice);

      const activitySummary = page.locator(".chat-activity-group__summary").last();
      await activitySummary.click();
      const groupedToolBubble = page.locator('.chat-bubble[data-entry-id="oversized-tool-1"]');
      await groupedToolBubble.waitFor({ state: "visible" });
      expect(await groupedToolBubble.getAttribute("data-message-text")).toBe(oversizedNotice);
      await groupedToolBubble.click({ button: "right" });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Reply"]);
      await screenshot(page, "09-oversized-tool-actions.png");
      await menu.getByRole("menuitem", { name: "Reply to message" }).click();
      await expect
        .poll(() => fullTextReplyPreview.locator(".chat-reply-preview__text").textContent())
        .toBe(oversizedNotice);
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      await setThemeMode(page, "light");
      await fullTail.scrollIntoViewIfNeeded();
      await screenshot(page, "10-oversized-resolved-light.png");
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});
