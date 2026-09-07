import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Activity summaries mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-activity-summaries");
  }
});

suite.define(() => {
  it("updates one visible tool summary from running to completed output", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 900, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { sessionKey: "main" });
        const startedAt = Date.now();

        await page.goto(`${suite.server.baseUrl}activity?view=live`);
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
          await writeFile(
            path.join(proofDir, "completed-tool-summary.png"),
            await takeControlUiViewportScreenshot(page, entry, [
              entry.getByText("Indexed 3 diagnostic sources.", { exact: true }),
            ]),
          );
        }
      },
    );
  });
});
