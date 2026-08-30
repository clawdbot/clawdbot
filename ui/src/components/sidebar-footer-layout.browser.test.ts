// Control UI sidebar footer tests cover cross-route layout parity.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeBrowserLayout = chromiumAvailable ? describe : describe.skip;

let browser: Browser;
let page: Page;

function readUiCss(): string {
  return ["base.css", "components.css", "layout.css"]
    .map((file) => readStyleSheet(`ui/src/styles/${file}`))
    .join("\n");
}

beforeAll(async () => {
  if (!chromiumAvailable) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 800, height: 400 } });
});

afterAll(async () => {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
});

describeBrowserLayout("sidebar footer layout", () => {
  it("keeps the settings footer the same height as the main sidebar footer", async () => {
    await page.setContent(`
      <!doctype html>
      <html data-theme-mode="light">
        <head>
          <style>${readUiCss()}</style>
          <style>
            .footer-layout-fixture {
              display: grid;
              grid-template-columns: 288px 288px;
              width: 576px;
              height: 180px;
            }
            .footer-layout-fixture > * {
              min-height: 0;
            }
          </style>
        </head>
        <body>
          <main class="shell footer-layout-fixture">
            <section class="sidebar-shell">
              <div class="sidebar-shell__content"></div>
              <div class="sidebar-shell__footer">
                <div class="sidebar-footer-bar">
                  <div class="sidebar-agent-card">
                    <button class="sidebar-agent-card__main" type="button">
                      <span class="sidebar-agent-card__avatar"></span>
                      <span class="sidebar-agent-card__name">Mason</span>
                    </button>
                  </div>
                  <div class="sidebar-footer-actions">
                    <button class="sidebar-brand__icon sidebar-footer-bar__custodian" type="button">
                      Inbox
                    </button>
                  </div>
                </div>
              </div>
            </section>
            <aside class="settings-sidebar">
              <div class="sidebar-shell__content"></div>
              <footer class="settings-sidebar__footer">
                <openclaw-settings-save-indicator></openclaw-settings-save-indicator>
                <span class="sidebar-footer-build">2026.8.1 · git@5328856</span>
              </footer>
            </aside>
          </main>
        </body>
      </html>
    `);

    const heights = await page.evaluate(() => ({
      main: document.querySelector(".sidebar-shell__footer")?.getBoundingClientRect().height,
      settings: document.querySelector(".settings-sidebar__footer")?.getBoundingClientRect().height,
    }));

    expect(heights.main).toBeDefined();
    expect(heights.settings).toBeDefined();
    expect(heights.settings).toBeCloseTo(heights.main ?? 0, 2);
  });
});
