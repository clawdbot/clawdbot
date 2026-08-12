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
const transportPreviewLimit = 8_000;

const realisticFullAssistantContent = `# Refactor complete: one transcript-loading path

I finished the Control UI transcript refactor. Ordinary messages render exactly as before, but a long assistant response no longer leaves the operator behind a disclosure control when the complete Markdown is available.

## What was wrong

The transcript list already knew the session key and stable message id, while each message group separately derived enough state to render Markdown, copy text, and build reply context. When history contained a transport-limited preview, those consumers could disagree: the bubble showed the preview, Copy used cached text, and Reply rebuilt text from the original transcript entry.

The underlying problem was ownership. Full-message loading already belonged to the thread, but visibility was controlled farther down the render tree. That meant the UI could possess the complete response and still choose to show only the preview until someone clicked Show more.

## Files reviewed

### ui/src/pages/chat/chat-thread.ts

The page owns the session-scoped map of assistant message expansions. Each entry records a revision and a loading, loaded, or failed result. The revision participates in row memoization, so completing a request invalidates the affected row without rebuilding the entire transcript.

The cache key combines the active session and message id. Switching sessions therefore cannot leak loaded text into another conversation, even when deterministic fixtures reuse a local id.

~~~ts
type AssistantMessageExpansionState =
  | { status: "loading"; revision: number }
  | { status: "error"; revision: number }
  | { status: "loaded"; expanded: boolean; markdown: string; revision: number };
~~~

This state and the existing chat.message.get request remain unchanged. The UI adjustment only removes the separate assistant disclosure decision after the loaded Markdown is present.

### ui/src/pages/chat/components/chat-message-group.ts

The group is the shared boundary for bubble content and message actions. It already checks the gateway suffix and transcriptMeta.truncated, looks up the stable message id, and receives the existing full-message callback from the thread.

The group now starts that existing callback when it first sees an eligible entry instead of waiting for a button click. It does not introduce another cache, request type, retry timer, or transport flag. A loading or failed entry is left alone, which prevents render-driven request loops.

~~~ts
for (const details of messageActionDetails) {
  if (
    details?.shouldFetchFullMessage &&
    details.messageId &&
    !getAssistantMessageExpansion(details.messageId)
  ) {
    onToggleAssistantMessageExpanded(details.messageId);
  }
}
~~~

Once the existing loader resolves, the same selected Markdown flows to the bubble, inline Copy action, Reply action, and context menu. No consumer has to infer whether a loaded response should still look collapsed.

### ui/src/pages/chat/components/chat-message-markdown.ts

Assistant Markdown now renders directly. If the existing expansion record contains loaded text, that text is selected regardless of the old expanded boolean. Otherwise the transcript text is shown exactly as received.

Loaded text uses document rendering mode so the chat renderer does not apply its regular large-message preview limit to a response that was explicitly recovered in full. User-authored messages keep their separate local disclosure behavior; this change only removes the assistant control.

~~~ts
const markdown = disclosure?.expanded
  ? disclosure.markdown ?? previewMarkdown
  : previewMarkdown;

return renderMarkdownText(markdown, isStreaming, renderOptions);
~~~

There is no assistant footer, loading label, Show more button, Show less button, or inline failure banner. During the existing request, the transport text remains readable. When complete text arrives, the same bubble grows naturally to fit it.

## Request lifecycle

1. History supplies the transport representation of the assistant message.
2. The existing truncation check determines whether a stored full copy can be requested.
3. The group invokes the already-shipped full-message callback once.
4. The thread sends chat.message.get with the stable session and message identifiers.
5. A successful result replaces the visible Markdown in the existing bubble.
6. Copy and Reply immediately use the same complete Markdown.

The request shape remains the one already supported by the gateway:

~~~json
{
  "sessionKey": "main",
  "messageId": "assistant-refactor-report",
  "maxChars": 500000
}
~~~

Those names are deterministic fixture values. This scenario contains no production session identifiers, account data, credentials, channel addresses, provider keys, or access tokens.

## Failure behavior

If no complete stored message is available, the UI keeps the transcript text. It does not replace useful content with an error card or leave a dead control on screen. The existing failed state prevents the render pass from immediately issuing the same request again.

This matters during reconnects and partial history imports: the operator still sees the information that actually reached the browser. The UI does not invent missing prose, infer a synthetic ending, or claim that a transport-limited message is complete.

## Observable behavior covered

The focused component tests protect the user-facing boundary rather than the internal call order:

- eligible assistant text starts the existing full-message load without a click;
- loaded Markdown is visible even if an older cached expanded flag is false;
- the assistant bubble contains no Show more or Show less control;
- Copy and Reply use the complete loaded response;
- loading and failure continue to display the transcript text;
- mirrored tool replies and messages without a loader remain unchanged;
- user-message disclosure behavior stays separate and intact.

The thread test verifies that one render starts one request, that the complete response replaces the preview, and that later renders do not fetch it again. A second case rejects the request and confirms that the transport text stays readable with no disclosure or error UI.

## Browser proof

The browser scenario boots the real Control UI against a mocked Gateway WebSocket. History contains the first 8,000 characters of this report plus the existing truncation state, while chat.message.get returns this complete Markdown document.

The test waits for the final heading, checks the exact request parameters, confirms that no disclosure buttons exist, and exercises both inline and context-menu actions. Screenshots use a normal 1440×900 viewport in dark and light themes rather than zooming out to make the response look artificially short.

The before view ends in the middle of the refactor explanation because that is where the transport preview stops. The after view reaches the remaining failure notes, test coverage, scope checks, and final result in the same message bubble.

## Scope checks

No gateway handler, protocol type, persistence model, or transport limit changed. The full-message request, expansion cache, identifiers, and response extraction all predate this change. The production diff removes presentation branches instead of adding a second way to retrieve content.

The change also leaves user-authored long messages alone. Their local disclosure is a presentation choice for text the user submitted, while this assistant path is about showing the complete response once the existing loader has made it available.

## Manual review notes

I reviewed the transition at a normal desktop viewport and followed the text rather than relying only on request assertions. The preview remains selectable while loading, the existing headings and code blocks stay mounted, and the message grows in place when the remaining Markdown arrives.

In both themes, code blocks retain their contrast, long paths wrap without covering the message actions, and the final section remains reachable with ordinary scrolling. No spinner or temporary card shifts the reading position between the preview and the full response.

I also rejected the mocked full-message request and confirmed that the last received sentence stayed visible. A later host render did not create a tight retry loop, duplicate the message group, or expose an inactive assistant disclosure control.

## Verification result

The focused component suite and real-browser mocked-gateway scenario pass with the same structured response. The complete answer is always visible when available, message actions agree with the bubble, both themes remain readable, and the assistant UI exposes no manual expansion control.`;

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
    const truncatedPreview = `${fullAssistantContent.slice(0, transportPreviewLimit)}\n...(truncated)...`;
    expect(fullAssistantContent.length).toBeGreaterThan(transportPreviewLimit);
    const gateway = await installMockGateway(page, {
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
          content: [{ type: "text", text: truncatedPreview }],
          timestamp: Date.now() + 4,
          __openclaw: { id: "assistant-refactor-report", seq: 5 },
        },
      ],
      methodResponses: {
        "chat.message.get": {
          ok: true,
          message: { role: "assistant", content: fullAssistantContent },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await setThemeMode(page, "dark");
      const commandPaletteShortcut = process.platform === "darwin" ? "⌘K" : "Ctrl K";
      await expectHoverTooltip(page.getByRole("button", { name: "New session" }), "New session");
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
      await screenshot(page, "04-selected-text-context-menu.png");
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

      const fullTextBubble = page.locator(
        '.chat-bubble[data-entry-id="assistant-refactor-report"]',
      );
      const fullTextGroup = fullTextBubble.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-group ')]",
      );
      const fullMessageRequest = await gateway.waitForRequest("chat.message.get");
      expect(fullMessageRequest.params).toMatchObject({
        sessionKey: "main",
        messageId: "assistant-refactor-report",
        maxChars: 500_000,
      });
      const fullTail = fullTextBubble.getByRole("heading", { name: "Verification result" });
      await fullTail.waitFor({ state: "visible" });
      expect(await fullTextBubble.getByRole("button", { name: "Show more" }).count()).toBe(0);
      expect(await fullTextBubble.getByRole("button", { name: "Show less" }).count()).toBe(0);
      await fullTail.scrollIntoViewIfNeeded();
      await screenshot(page, "07-realistic-refactor-dark.png");

      await fullTextGroup.hover();
      await fullTextGroup.getByRole("button", { name: "Copy as markdown" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(fullAssistantContent);
      await fullTextGroup.getByRole("button", { name: "Reply to message" }).click();
      const fullTextReplyPreview = page.locator(".chat-reply-preview");
      await expect
        .poll(() => fullTextReplyPreview.locator(".chat-reply-preview__text").textContent())
        .toContain("# Refactor complete: one transcript-loading path");
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
        .toContain("# Refactor complete: one transcript-loading path");
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      await setThemeMode(page, "light");
      await fullTail.scrollIntoViewIfNeeded();
      await screenshot(page, "08-realistic-refactor-light.png");
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});
