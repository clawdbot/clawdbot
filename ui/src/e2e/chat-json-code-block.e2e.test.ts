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
const proofStage = process.env.OPENCLAW_JSON_CODE_PROOF_STAGE ?? "after";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-json-code-block");

function fencedJson(lineCount: number): string {
  const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
  values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
  return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
}

const shortJson = `\`\`\`json
{
  "status": "ok",
  "items": [
    "alpha"
  ]
}
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

describeControlUiE2e("Control UI JSON code blocks", () => {
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
    "keeps short JSON visible and reserves one disclosure header for long JSON in %s mode",
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
            __openclaw: { id: "user-json-long", seq: 1 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: fencedJson(41) }],
            timestamp: Date.now() + 1,
            __openclaw: { id: "assistant-json-long", seq: 2 },
          },
          {
            role: "user",
            content: [{ type: "text", text: "Return the deployment receipt as JSON." }],
            timestamp: Date.now() + 2,
            __openclaw: { id: "user-json-short", seq: 3 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: shortJson }],
            timestamp: Date.now() + 3,
            __openclaw: { id: "assistant-json-short", seq: 4 },
          },
        ],
      });

      try {
        await page.goto(`${server.baseUrl}chat`);
        await setThemeMode(page, theme);
        const shortBubble = page.locator('[data-entry-id="assistant-json-short"]');
        const longBubble = page.locator('[data-entry-id="assistant-json-long"]');
        await shortBubble.waitFor({ state: "visible" });
        if (captureProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `${proofStage}-${theme}.png`),
          });
        }

        expect(await shortBubble.locator("details.json-collapse").count()).toBe(0);
        expect(await shortBubble.locator("pre code").isVisible()).toBe(true);

        const details = longBubble.locator("details.json-collapse");
        const summary = details.locator("summary");
        expect(await summary.textContent()).toContain("JSON · 41 lines");
        expect(await summary.locator(".code-block-copy").count()).toBe(1);
        expect(await details.locator(".code-block-header").count()).toBe(1);
        await summary.click();
        await expect.poll(() => details.getAttribute("open")).toBe("");
        await summary.locator(".code-block-copy").click();
        await expect.poll(() => details.getAttribute("open")).toBe("");
      } finally {
        await context.close();
      }
    },
  );
});
