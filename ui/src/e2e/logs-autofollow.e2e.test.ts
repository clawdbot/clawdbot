import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI logs auto-follow mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-live-log-tail");
  }
});

const logLines = Array.from({ length: 200 }, (_value, index) =>
  JSON.stringify({
    "0": JSON.stringify({ subsystem: "autofollow-e2e" }),
    "1": `log line ${index + 1}`,
    time: new Date(Date.UTC(2026, 6, 13, 12, 0, index)).toISOString(),
    _meta: { logLevelName: "info" },
  }),
);
const appendedLogLine = JSON.stringify({
  "0": JSON.stringify({ subsystem: "autofollow-e2e" }),
  "1": "log line 201",
  time: new Date(Date.UTC(2026, 6, 13, 12, 3, 20)).toISOString(),
  _meta: { logLevelName: "warn" },
});

suite.define(() => {
  it("returns to the newest line when auto-follow is re-enabled", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1_200 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 800, width: 1_200 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "logs.tail": {
              sequence: [
                {
                  cursor: logLines.length,
                  file: "/tmp/openclaw.log",
                  lines: logLines,
                  reset: true,
                },
                {
                  cursor: logLines.length + 1,
                  file: "/tmp/openclaw.log",
                  lines: [appendedLogLine],
                  reset: false,
                },
                {
                  cursor: logLines.length + 1,
                  file: "/tmp/openclaw.log",
                  lines: [],
                  reset: false,
                },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}logs`);
        try {
          await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);
        } finally {
          if (captureUiProof) {
            await writeFile(
              path.join(proofDir, "initial-tail.png"),
              await takeControlUiViewportScreenshot(page, page.locator(".logs-card"), [
                page.locator(".log-row").first(),
              ]),
            );
          }
        }
        expect((await gateway.getRequests("logs.tail"))[0]?.params).toEqual({
          limit: 500,
          maxBytes: 250_000,
        });
        await expect
          .poll(async () => (await gateway.getRequests("logs.tail")).length, { timeout: 5000 })
          .toBeGreaterThanOrEqual(2);
        expect((await gateway.getRequests("logs.tail"))[1]?.params).toEqual({
          cursor: logLines.length,
          limit: 500,
          maxBytes: 250_000,
        });
        await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length + 1);
        await page.locator(".log-row", { hasText: "log line 201" }).waitFor();

        const stream = page.locator(".log-stream");
        const autoFollow = page.locator("wa-switch.settings-toggle").filter({
          hasText: "Auto-follow",
        });
        await expect
          .poll(() => stream.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeGreaterThan(0);
        await expect
          .poll(() => autoFollow.evaluate((element) => Reflect.get(element, "checked")))
          .toBe(true);
        await autoFollow.click();
        await expect
          .poll(() => autoFollow.evaluate((element) => Reflect.get(element, "checked")))
          .toBe(false);
        await stream.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);

        await autoFollow.click();
        await expect
          .poll(() => autoFollow.evaluate((element) => Reflect.get(element, "checked")))
          .toBe(true);

        await expect
          .poll(() =>
            stream.evaluate(
              (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
            ),
          )
          .toBeLessThan(2);
        if (captureUiProof) {
          await writeFile(
            path.join(proofDir, "incremental-tail-and-autofollow.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".logs-card"), [
              stream.locator(".log-row", { hasText: "log line 201" }),
            ]),
          );
        }
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
