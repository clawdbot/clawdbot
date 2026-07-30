// Control UI E2E tests cover Codex final-answer candidate Activity rendering.
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "codex-answer-candidates",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

describeControlUiE2e("Control UI Codex answer candidates", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows superseded and authoritative selected answers only in Activity", async () => {
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { sessionKey: "main" });

    try {
      await page.goto(`${server.baseUrl}activity`);
      await page.getByText("No activity yet.", { exact: true }).waitFor();
      await screenshot(page, "01-before-empty-activity.png");

      const emitCandidate = async (
        seq: number,
        itemId: string,
        status: "candidate" | "superseded" | "selected",
        progressText: string,
      ) => {
        await gateway.emitGatewayEvent("agent", {
          runId: "run-proof",
          seq,
          stream: "item",
          ts: Date.now(),
          sessionKey: "main",
          data: { kind: "answer_candidate", itemId, progressText, status },
        });
      };

      await emitCandidate(1, "answer-1", "candidate", "Initial bounded answer.");
      await emitCandidate(2, "answer-1", "superseded", "Initial bounded answer.");
      await emitCandidate(3, "answer-2", "candidate", "Authoritative bounded answer.");
      await emitCandidate(4, "answer-2", "selected", "Authoritative bounded answer.");

      await expect.poll(() => page.locator(".activity-entry").count()).toBe(2);
      await page.getByText("Superseded answer", { exact: true }).waitFor();
      await page.getByText("Selected answer", { exact: true }).waitFor();
      const selected = page.locator(".activity-entry").filter({ hasText: "Selected answer" });
      await selected.locator("summary").click();
      await selected.getByText("Authoritative bounded answer.", { exact: true }).waitFor();
      await screenshot(page, "02-after-selected-answer.png");

      await page.goto(`${server.baseUrl}chat`);
      await expect
        .poll(() => page.getByText("Authoritative bounded answer.", { exact: true }).count())
        .toBe(0);
      await page.goto(`${server.baseUrl}activity`);
      await page.getByText("No activity yet.", { exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });
});
