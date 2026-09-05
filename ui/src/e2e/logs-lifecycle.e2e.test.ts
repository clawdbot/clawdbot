import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { resetLogger, setLoggerOverride } from "../../../src/logging.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI logs lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() || ".artifacts/control-ui-e2e",
  "logs-lifecycle",
);
const viewport = { height: 900, width: 1_440 };

function logLine(message: string, level: "error" | "info" | "warn", second: number) {
  return JSON.stringify({
    "0": JSON.stringify({ subsystem: "logs-lifecycle-proof" }),
    "1": message,
    message,
    time: new Date(Date.UTC(2026, 7, 15, 12, 0, second)).toISOString(),
    _meta: { logLevelName: level },
  });
}

async function capture(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".logs-card"), [
      page.locator(".log-message").first(),
    ]),
  );
}

async function visibleMessages(page: Page) {
  return page.locator(".log-message").allTextContents();
}

suite.define(() => {
  it("replaces a changed log source and preserves visible recovery through reconnect", async (context) => {
    let fixture: OpenClawTestState | undefined;
    let gateway: Promise<GatewayServer> | undefined;
    let loggerConfigured = false;
    await suite.runScenario(context, {
      retainedState: () => fixture?.root,
      close: async () => {
        const server = await gateway;
        await server?.close({ reason: "logs lifecycle e2e cleanup" });
        if (loggerConfigured) {
          resetLogger();
        }
      },
      release: async () => {
        await fixture?.cleanup();
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        const state = await createOpenClawTestState({
          label: "control-ui-logs-lifecycle",
          layout: "home",
          env: {
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        fixture = state;
        signal.throwIfAborted();
        const sourceA = state.path("source-a.log");
        const sourceB = state.path("source-b.log");
        const readFailure = state.path("read-failure");
        const lineA = logLine("source A only", "info", 1);
        const messageBPrefix = `source B prefix ${"x".repeat(Buffer.byteLength(lineA))}`;
        const lineBPrefix = logLine(messageBPrefix, "info", 2);
        const lineBTail = logLine("source B tail", "error", 3);
        const lineBAppended = logLine("source B appended", "warn", 4);
        const messageBRestartPrefix = `source B restart prefix ${"y".repeat(
          Buffer.byteLength(`${lineBPrefix}\n${lineBTail}\n${lineBAppended}\n`),
        )}`;
        const lineBRestartPrefix = logLine(messageBRestartPrefix, "info", 5);
        const lineBRestartTail = logLine("source B restart tail", "error", 6);
        const lineBAfterReconnect = logLine("source B after reconnect", "warn", 7);
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        signal.throwIfAborted();
        await writeFile(sourceA, `${lineA}\n`, "utf8");
        signal.throwIfAborted();
        await writeFile(sourceB, `${lineBPrefix}\n${lineBTail}\n`, "utf8");
        signal.throwIfAborted();
        await mkdir(readFailure);
        signal.throwIfAborted();
        await state.writeConfig({
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            port,
          },
        });
        signal.throwIfAborted();
        loggerConfigured = true;
        setLoggerOverride({ consoleLevel: "silent", file: sourceA, level: "silent" });
        gateway = startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        const server = await gateway;
        signal.throwIfAborted();

        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport,
            ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
          },
          async ({ page }) => {
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            const url = new URL("logs", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
            await waitForControlUiGatewayReady(page);
            await expect.poll(() => visibleMessages(page)).toEqual(["source A only"]);

            setLoggerOverride({ consoleLevel: "silent", file: sourceB, level: "silent" });
            await expect
              .poll(() => page.locator(".logs-card .settings-row").first().textContent())
              .toContain(sourceB);
            await expect
              .poll(() => visibleMessages(page))
              .toEqual([messageBPrefix, "source B tail"]);
            await capture(page, "01-source-b-complete.png");

            const filter = page.getByRole("textbox", { name: "Filter" });
            await filter.fill("source B tail");
            await expect.poll(() => visibleMessages(page)).toEqual(["source B tail"]);
            const downloadPromise = page.waitForEvent("download");
            await page.getByRole("button", { name: "Export filtered" }).click();
            const download = await downloadPromise;
            expect(download.suggestedFilename()).toMatch(/^openclaw-logs-filtered-.*\.log$/);
            const downloadStream = await download.createReadStream();
            if (!downloadStream) {
              throw new Error("filtered log export did not provide a readable download");
            }
            expect(await text(downloadStream)).toBe(`${lineBTail}\n`);

            await filter.fill("");
            await page.locator("label.log-chip.info input").uncheck();
            await expect.poll(() => visibleMessages(page)).toEqual(["source B tail"]);
            await page.locator("label.log-chip.info input").check();
            await appendFile(sourceB, `${lineBAppended}\n`, "utf8");
            await expect
              .poll(() => visibleMessages(page))
              .toEqual([messageBPrefix, "source B tail", "source B appended"]);

            setLoggerOverride({ consoleLevel: "silent", file: readFailure, level: "silent" });
            const error = page.locator(".logs-refresh-status[role=alert]");
            await expect.poll(() => error.isVisible()).toBe(true);
            await expect.poll(() => error.textContent()).toContain("log read failed");
            await expect.poll(() => error.textContent()).toContain("Showing stale data");
            await expect
              .poll(() => visibleMessages(page))
              .toEqual([messageBPrefix, "source B tail", "source B appended"]);
            await capture(page, "02-read-error-stale-lines-visible.png");

            setLoggerOverride({ consoleLevel: "silent", file: sourceB, level: "silent" });
            await expect.poll(() => error.count()).toBe(0);
            await expect.poll(() => visibleMessages(page)).toHaveLength(3);

            await server.close({ reason: "logs lifecycle reconnect proof" });
            gateway = undefined;
            signal.throwIfAborted();
            await page.waitForFunction(() => {
              const app = document.querySelector("openclaw-app") as
                | (HTMLElement & {
                    runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } };
                  })
                | null;
              return app?.runtime?.context?.gateway?.snapshot?.phase === "reconnecting";
            });
            await expect
              .poll(() => page.locator(".sidebar-footer-bar__status").textContent())
              .toContain("Reconnecting…");
            await expect.poll(() => visibleMessages(page)).toHaveLength(3);
            signal.throwIfAborted();
            await writeFile(sourceB, `${lineBRestartPrefix}\n${lineBRestartTail}\n`, "utf8");
            signal.throwIfAborted();
            gateway = startGatewayServer(port, {
              auth: { mode: "none" },
              bind: "loopback",
              controlUiEnabled: false,
              sidecarStartup: "defer",
            });
            await gateway;
            signal.throwIfAborted();
            await waitForControlUiGatewayReady(page);
            await expect
              .poll(() => visibleMessages(page))
              .toEqual([messageBRestartPrefix, "source B restart tail"]);
            await appendFile(sourceB, `${lineBAfterReconnect}\n`, "utf8");
            await expect
              .poll(() => visibleMessages(page))
              .toEqual([
                messageBRestartPrefix,
                "source B restart tail",
                "source B after reconnect",
              ]);
            await capture(page, "03-reconnected-tail-complete.png");
            expect(pageErrors).toEqual([]);
          },
        );
      },
    });
  });
});
