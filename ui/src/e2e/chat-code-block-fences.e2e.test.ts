import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofStage = process.env.OPENCLAW_CODE_FENCE_PROOF_STAGE ?? "after";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-code-block-fences");

function fencedJson(lineCount: number): string {
  const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
  values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
  return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
}

const shortFence = `\`\`\`json
{
  "status": "ok",
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
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(["dark", "light"] as const)(
    "previews long fences, reveals them, and wraps overflowing lines in %s mode",
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
          {
            role: "user",
            content: [{ type: "text", text: "Show the full diagnostic payload." }],
            timestamp: Date.now(),
            __openclaw: { id: "user-fence-long", seq: 1 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: fencedJson(41) }],
            timestamp: Date.now() + 1,
            __openclaw: { id: "assistant-fence-long", seq: 2 },
          },
          {
            role: "user",
            content: [{ type: "text", text: "Return the deployment receipt." }],
            timestamp: Date.now() + 2,
            __openclaw: { id: "user-fence-short", seq: 3 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: shortFence }],
            timestamp: Date.now() + 3,
            __openclaw: { id: "assistant-fence-short", seq: 4 },
          },
          {
            role: "user",
            content: [{ type: "text", text: "Show the launch command." }],
            timestamp: Date.now() + 4,
            __openclaw: { id: "user-fence-wide", seq: 5 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: wideFence }],
            timestamp: Date.now() + 5,
            __openclaw: { id: "assistant-fence-wide", seq: 6 },
          },
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
      } finally {
        await context.close();
      }
    },
  );
});
