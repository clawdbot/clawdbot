import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
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
const proofDir = path.resolve(".artifacts/control-ui-e2e/control-ui-activity-summaries");

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Activity summaries mocked Gateway E2E", () => {
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

  it("updates one visible tool summary from running to completed output", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? { recordVideo: { dir: path.join(proofDir, "video"), size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { sessionKey: "main" });
    const startedAt = Date.now();

    try {
      await page.goto(`${server.baseUrl}activity`);
      await page.getByText("No activity yet.", { exact: true }).waitFor();

      await gateway.emitGatewayEvent("agent", {
        runId: "run-diagnostics",
        seq: 1,
        stream: "tool",
        ts: startedAt,
        sessionKey: "main",
        data: {
          phase: "start",
          name: "web_search",
          toolCallId: "tool-diagnostics",
          args: { query: "operator diagnostics" },
        },
      });

      const entry = page.locator(".activity-entry").filter({ hasText: "web_search" });
      await entry.waitFor();
      await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
      await entry.getByText("Running", { exact: true }).waitFor();
      await entry
        .locator(".activity-entry__summary .activity-entry__text")
        .getByText("1 argument hidden", { exact: true })
        .waitFor();

      await gateway.emitGatewayEvent("agent", {
        runId: "run-diagnostics",
        seq: 2,
        stream: "tool",
        ts: startedAt + 250,
        sessionKey: "main",
        data: {
          phase: "result",
          name: "web_search",
          toolCallId: "tool-diagnostics",
          result: {
            content: [{ type: "text", text: "Indexed 3 diagnostic sources." }],
          },
        },
      });

      await entry.getByText("Done", { exact: true }).waitFor();
      await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
      await page.getByText("1 of 1", { exact: true }).waitFor();
      await entry.locator("summary").click();
      await entry.getByText("Indexed 3 diagnostic sources.", { exact: true }).waitFor();
      await entry.getByText("Run: run-diagnostics", { exact: true }).waitFor();

      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "completed-tool-summary.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
