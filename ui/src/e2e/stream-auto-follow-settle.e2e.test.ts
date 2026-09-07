import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI stream auto-follow settle mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-stream-autofollow-settle");
  }
});

type LateRowGrowthOptions = {
  containerSelector: string;
  rowSelector: string;
  triggerRowCount: number;
  growPxPerFrame?: number;
  growFrames?: number;
};

declare global {
  interface Window {
    settleGrowthStarted?: boolean;
    settleGrowthDone?: boolean;
  }
}

/**
 * Simulates the virtualizer's late row re-measurement: once the trigger row
 * connects, one near-bottom row grows by a fixed amount per animation frame.
 * The growth starts around the follow scroll and outlasts it by several
 * frames, which is exactly the sequence that bounced the single-shot scroll.
 */
async function installLateRowGrowth(page: Page, options: LateRowGrowthOptions): Promise<void> {
  await page.addInitScript((opts: LateRowGrowthOptions) => {
    window.settleGrowthStarted = false;
    window.settleGrowthDone = false;
    const growPxPerFrame = opts.growPxPerFrame ?? 60;
    const growFrames = opts.growFrames ?? 10;
    const startGrowth = (container: Element) => {
      if (window.settleGrowthStarted) {
        return;
      }
      window.settleGrowthStarted = true;
      const rows = container.querySelectorAll(opts.rowSelector);
      const target = rows[Math.max(0, rows.length - 3)];
      if (!(target instanceof HTMLElement)) {
        window.settleGrowthDone = true;
        return;
      }
      let frame = 0;
      const step = () => {
        frame += 1;
        const current = Number.parseFloat(target.style.paddingBottom || "0");
        target.style.paddingBottom = `${current + growPxPerFrame}px`;
        if (frame < growFrames) {
          requestAnimationFrame(step);
        } else {
          window.settleGrowthDone = true;
        }
      };
      requestAnimationFrame(step);
    };
    const observer = new MutationObserver(() => {
      const container = document.querySelector(opts.containerSelector);
      if (
        container &&
        container.querySelectorAll(opts.rowSelector).length >= opts.triggerRowCount
      ) {
        startGrowth(container);
      }
    });
    // Init scripts run before documentElement exists; document itself does.
    observer.observe(document, { childList: true, subtree: true });
  }, options);
}

function distanceFromBottom(stream: Locator): Promise<number> {
  return stream.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

async function expectPinnedAfterSettle(page: Page, stream: Locator): Promise<void> {
  await page.waitForFunction(() => window.settleGrowthDone === true);
  // The settle loop chases late growth back to the bottom within its bounded
  // window; give the poll enough room for the full 12-frame chase.
  await expect.poll(() => distanceFromBottom(stream)).toBeLessThan(2);
  // Pinned must be a steady state, not a frame the next growth undoes.
  await page.waitForTimeout(700);
  expect(await distanceFromBottom(stream)).toBeLessThan(2);
}

const logLines = Array.from({ length: 200 }, (_value, index) =>
  JSON.stringify({
    "0": JSON.stringify({ subsystem: "autofollow-settle-e2e" }),
    "1": `log line ${index + 1}`,
    time: new Date(Date.UTC(2026, 6, 13, 12, 0, index)).toISOString(),
    _meta: { logLevelName: "info" },
  }),
);
const appendedLogLine = JSON.stringify({
  "0": JSON.stringify({ subsystem: "autofollow-settle-e2e" }),
  "1": "log line 201",
  time: new Date(Date.UTC(2026, 6, 13, 12, 3, 20)).toISOString(),
  _meta: { logLevelName: "warn" },
});

suite.define(() => {
  it("keeps the logs stream pinned while rows settle after an append", async () => {
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
        await installLateRowGrowth(page, {
          containerSelector: ".log-stream",
          rowSelector: ".log-row",
          triggerRowCount: logLines.length + 1,
        });
        await installMockGateway(page, {
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
        const stream = page.locator(".log-stream");
        await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);
        await expect.poll(() => distanceFromBottom(stream)).toBeLessThan(2);

        // The appended line triggers both the follow scroll and, via the
        // mutation observer, ten frames of late row growth (+600px total).
        await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length + 1);
        await expectPinnedAfterSettle(page, stream);

        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "logs-stream-pinned-after-settle.png"),
          });
        }
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it("keeps the activity stream pinned while rows settle after an append", async () => {
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
        const initialEntries = 40;
        await installLateRowGrowth(page, {
          containerSelector: ".activity-stream",
          rowSelector: ".activity-entry",
          triggerRowCount: initialEntries + 1,
        });
        const gateway = await installMockGateway(page, { sessionKey: "main" });
        const startedAt = Date.now();

        await page.goto(`${suite.server.baseUrl}activity?view=live`);
        await page.getByText("No activity yet.", { exact: true }).waitFor();

        const emitToolStart = async (index: number) => {
          await gateway.emitGatewayEvent("agent", {
            runId: "run-settle",
            seq: index + 1,
            stream: "tool",
            ts: startedAt + index * 50,
            sessionKey: "main",
            data: {
              phase: "start",
              name: "settle_probe",
              toolCallId: `tool-settle-${index}`,
              args: { index },
            },
          });
        };
        for (let index = 0; index < initialEntries; index += 1) {
          await emitToolStart(index);
        }

        const stream = page.locator(".activity-stream");
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(initialEntries);
        await expect
          .poll(() => stream.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeGreaterThan(0);
        // The burst's own late layout can leave the stream off the bottom;
        // take it to the end explicitly so the append starts from a pinned
        // viewport with atBottom engaged (a user scroll-to-end gesture).
        await page.waitForTimeout(1_000);
        await stream.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event("scroll"));
        });
        await expect.poll(() => distanceFromBottom(stream)).toBeLessThan(2);

        // Entry 41 triggers the follow scroll and the late row growth.
        await emitToolStart(initialEntries);
        await expect.poll(() => page.locator(".activity-entry").count()).toBe(initialEntries + 1);
        await expectPinnedAfterSettle(page, stream);

        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "activity-stream-pinned-after-settle.png"),
          });
        }
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
