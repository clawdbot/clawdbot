// Control UI E2E tests cover Codex final-answer candidate Activity rendering.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Codex answer candidates",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "codex-answer-candidates",
);

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

suite.define(() => {
  it("shows superseded and authoritative selected answers only in Activity", async () => {
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { sessionKey: "main" });

        await page.goto(`${suite.server.baseUrl}activity`);
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

        await page.goto(`${suite.server.baseUrl}chat`);
        await expect
          .poll(() => page.getByText("Authoritative bounded answer.", { exact: true }).count())
          .toBe(0);
        await page.goto(`${suite.server.baseUrl}activity`);
        await page.getByText("No activity yet.", { exact: true }).waitFor();
      },
    );
  });
});
