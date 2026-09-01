import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofStage = process.env.OPENCLAW_CODE_FENCE_PROOF_STAGE ?? "after";
let artifactDir: string;
beforeEach(() => {
  if (captureProof) {
    artifactDir = createControlUiE2eArtifactDir("chat-code-block-fences");
  }
});

function fencedJson(lineCount: number): string {
  const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
  values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
  return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
}

function fencedProse(language: "text" | "md" | "markdown"): string {
  return `\`\`\`${language}\n${`${language} prose line\n`.repeat(20)}\`\`\``;
}

const shortFence = `\`\`\`json
{
  "status": "${"ready-for-staging-".repeat(4)}",
  "items": [
    "alpha"
  ]
}
\`\`\``;

const wideFence = `\`\`\`bash
openclaw gateway start ${"--flag value ".repeat(40)}
\`\`\``;

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
}

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI fenced code blocks", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("highlights a streamed code fence only after its closing marker arrives", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").fill("show TypeScript");
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      const openFence = "```ts\nconst value = 1 < 2;";
      const emitDelta = async (text: string, deltaText: string) => {
        await gateway.emitGatewayEvent("chat", {
          deltaText,
          message: {
            content: [{ text, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "delta",
        });
      };

      await emitDelta(openFence, openFence);
      const streamingCode = page.locator(".chat-bubble.streaming code.language-ts");
      await expect.poll(() => streamingCode.textContent()).toContain("const value = 1 < 2;");
      expect(await streamingCode.locator("span").count()).toBe(0);
      expect(await streamingCode.evaluate((code) => code.classList.contains("hljs"))).toBe(false);
      expect(await page.locator(".chat-bubble.streaming .code-block-copy").count()).toBe(1);
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "stream-open-unhighlighted.png") });
      }

      const completedFence = `${openFence}\n\`\`\``;
      await emitDelta(completedFence, "\n```");
      await expect.poll(() => streamingCode.getAttribute("class")).toContain("hljs");
      expect(await streamingCode.locator("span").count()).toBeGreaterThan(0);
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "stream-closed-highlighted.png") });
      }

      await gateway.emitChatFinal({ runId, text: completedFence });
      await expect.poll(() => page.locator(".chat-thread code.language-ts.hljs").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it.each(["dark", "light"] as const)(
    "keeps code controls correct through disclosure, resize, and virtual remount in %s mode",
    async (theme) => {
      const context = await browser.newContext({
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(server.baseUrl).origin,
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        historyMessages: [
          ...Array.from({ length: 40 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text: `Earlier diagnostic turn ${index}` }],
            timestamp: Date.now() - 40 + index,
            __openclaw: { id: `earlier-diagnostic-${index}`, seq: index + 1 },
          })),
          {
            role: "user",
            content: [{ type: "text", text: "Show the full diagnostic payload." }],
            timestamp: Date.now(),
            __openclaw: { id: "user-fence-long", seq: 41 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: fencedJson(41) }],
            timestamp: Date.now() + 1,
            __openclaw: { id: "assistant-fence-long", seq: 42 },
          },
          {
            role: "user",
            content: [{ type: "text", text: "Return the deployment receipt." }],
            timestamp: Date.now() + 2,
            __openclaw: { id: "user-fence-short", seq: 43 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: shortFence }],
            timestamp: Date.now() + 3,
            __openclaw: { id: "assistant-fence-short", seq: 44 },
          },
          {
            role: "user",
            content: [{ type: "text", text: "Show the launch command." }],
            timestamp: Date.now() + 4,
            __openclaw: { id: "user-fence-wide", seq: 45 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: wideFence }],
            timestamp: Date.now() + 5,
            __openclaw: { id: "assistant-fence-wide", seq: 46 },
          },
          ...(["text", "md", "markdown"] as const).map((language, index) => ({
            role: "assistant",
            content: [{ type: "text", text: fencedProse(language) }],
            timestamp: Date.now() + 6 + index,
            __openclaw: { id: `assistant-fence-${language}`, seq: 47 + index },
          })),
        ],
      });

      try {
        await page.goto(`${server.baseUrl}chat`);
        await setThemeMode(page, theme);
        const shortBubble = page.locator('[data-entry-id="assistant-fence-short"]');
        const longBubble = page.locator('[data-entry-id="assistant-fence-long"]');
        const wideBubble = page.locator('[data-entry-id="assistant-fence-wide"]');
        await wideBubble.waitFor({ state: "visible" });
        if (captureProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `${proofStage}-${theme}.png`),
          });
        }

        // A fence at or under the preview budget stays whole and offers no reveal.
        expect(await shortBubble.locator(".code-block-wrapper.is-collapsible").count()).toBe(0);
        expect(await shortBubble.locator(".code-block-expand").count()).toBe(0);
        expect(await shortBubble.locator("pre code").isVisible()).toBe(true);

        for (const language of ["text", "md", "markdown"] as const) {
          const proseBubble = page.locator(`[data-entry-id="assistant-fence-${language}"]`);
          expect(await proseBubble.locator(".code-block-wrapper.is-collapsible").count()).toBe(0);
          expect(await proseBubble.locator(".code-block-expand").count()).toBe(0);
          expect(await proseBubble.locator("pre code").textContent()).toContain(
            `${language} prose line`,
          );
        }

        const longWrapper = longBubble.locator(".code-block-wrapper");
        const expand = longWrapper.locator(".code-block-expand");
        expect(await expand.textContent()).toContain("34 hidden lines");
        const clippedHeight = await longWrapper
          .locator(".code-block-viewport")
          .evaluate((viewport) => viewport.clientHeight);
        await expand.click();
        await expect.poll(() => longWrapper.getAttribute("class")).toContain("is-expanded");
        expect(await expand.isVisible()).toBe(false);
        expect(
          await longWrapper
            .locator(".code-block-viewport")
            .evaluate((viewport) => viewport.clientHeight),
        ).toBeGreaterThan(clippedHeight);

        // The wrap control only appears once a line measurably overflows, and it
        // reverses; the transcript itself must never grow a horizontal scrollbar.
        const wideWrapper = wideBubble.locator(".code-block-wrapper");
        await expect
          .poll(() => wideWrapper.getAttribute("class"))
          .toContain("has-horizontal-overflow");
        const wrapButton = wideWrapper.locator(".code-block-wrap");
        expect(await wrapButton.isVisible()).toBe(true);
        await wrapButton.click();
        await expect.poll(() => wideWrapper.getAttribute("class")).toContain("is-wrapped");
        expect(
          await wideWrapper
            .locator(".code-block-viewport")
            .evaluate((viewport) => viewport.scrollWidth - viewport.clientWidth),
        ).toBeLessThanOrEqual(1);
        await wrapButton.click();
        await expect.poll(() => wideWrapper.getAttribute("class")).not.toContain("is-wrapped");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);

        // Resize must update existing code controls without another chat message.
        const shortWrapper = shortBubble.locator(".code-block-wrapper");
        const shortWrap = shortWrapper.locator(".code-block-wrap");
        await shortBubble.scrollIntoViewIfNeeded();
        expect(await shortWrap.isVisible()).toBe(false);
        await page.setViewportSize({ width: 560, height: 900 });
        await shortBubble.scrollIntoViewIfNeeded();
        await expect.poll(() => shortWrap.isVisible()).toBe(true);
        await page.setViewportSize({ width: 1440, height: 900 });
        await shortBubble.scrollIntoViewIfNeeded();
        await expect.poll(() => shortWrap.isVisible()).toBe(false);

        // Virtualization must initialize replacement DOM in an otherwise quiet transcript.
        const thread = page.locator(".chat-thread");
        // Focused rows stay mounted offscreen; move focus out of the wrap control first.
        await page.locator(".agent-chat__composer-combobox textarea").click();
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
        await expect.poll(() => wideBubble.count()).toBe(0);
        await page.mouse.wheel(0, 100_000);
        await wideBubble.waitFor({ state: "visible" });
        await expect.poll(() => wideWrapper.locator(".code-block-wrap").isVisible()).toBe(true);
        expect(await shortWrapper.locator(".code-block-wrap").isVisible()).toBe(false);
      } finally {
        await context.close();
      }
    },
  );
});
