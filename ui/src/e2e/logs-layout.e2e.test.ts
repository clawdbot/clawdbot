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

const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const proofLabel = process.env.OPENCLAW_UI_E2E_PROOF_LABEL?.trim() || "logs-layout";
const viewport = { height: 584, width: 863 };

let browser: Browser;
let server: ControlUiE2eServer;

const logLines = Array.from({ length: 40 }, (_value, index) =>
  JSON.stringify({
    "0": JSON.stringify({ subsystem: "native-layout-e2e" }),
    "1": `log line ${index + 1}`,
    time: new Date(Date.UTC(2026, 6, 21, 12, 0, index)).toISOString(),
    _meta: { logLevelName: "info" },
  }),
);

describeControlUiE2e("Control UI logs native app layout E2E", () => {
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

  it("keeps wrapped filters inside their rows in the macOS dashboard viewport", async () => {
    if (artifactDir) {
      await mkdir(path.join(artifactDir, proofLabel, "video"), { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(artifactDir
        ? { recordVideo: { dir: path.join(artifactDir, proofLabel, "video"), size: viewport } }
        : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem(
        "openclaw.control.settings.v1:ws://127.0.0.1:18789",
        JSON.stringify({ textScale: 125, themeMode: "dark" }),
      );
      const nativeWindow = window as Window & {
        __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
        __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
      };
      nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
      nativeWindow["__OPENCLAW_NATIVE_HISTORY__"] = {
        canGoBack: false,
        canGoForward: false,
      };
      const stamp = () =>
        document.documentElement.classList.add(
          "openclaw-native-macos",
          "openclaw-native-web-chrome",
        );
      if (document.documentElement) {
        stamp();
      } else {
        document.addEventListener("DOMContentLoaded", stamp);
      }
    });
    await installMockGateway(page, {
      methodResponses: {
        "logs.tail": {
          cursor: logLines.length,
          file: "/tmp/openclaw/openclaw-2026-07-21.log",
          lines: logLines,
          reset: true,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/general`);
      await page.locator('.settings-sidebar__item[href="/logs"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/logs");
      await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, proofLabel, "logs-layout.png"),
          fullPage: true,
        });
      }

      const metrics = await page.locator(".logs-card").evaluate((card) => {
        const rows = [...card.querySelectorAll<HTMLElement>(":scope > .settings-row")];
        const stream = card.querySelector<HTMLElement>(":scope > .log-stream");
        return {
          cardDisplay: getComputedStyle(card).display,
          rows: rows.map((row) => {
            const bounds = row.getBoundingClientRect();
            return {
              bottom: bounds.bottom,
              clientHeight: row.clientHeight,
              scrollHeight: row.scrollHeight,
              top: bounds.top,
            };
          }),
          streamFlexGrow: stream ? getComputedStyle(stream).flexGrow : "",
          streamTop: stream?.getBoundingClientRect().top ?? Number.NaN,
        };
      });

      expect(metrics.cardDisplay).toBe("flex");
      expect(metrics.streamFlexGrow).toBe("1");
      expect(metrics.rows).toHaveLength(2);
      const [firstRow, secondRow] = metrics.rows;
      if (!firstRow || !secondRow) {
        throw new Error(`Expected two log control rows, received ${metrics.rows.length}.`);
      }
      for (const row of metrics.rows) {
        expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight + 1);
      }
      expect(firstRow.bottom).toBeLessThanOrEqual(secondRow.top + 1);
      expect(secondRow.bottom).toBeLessThanOrEqual(metrics.streamTop + 1);
    } finally {
      await context.close();
    }
  });
});
