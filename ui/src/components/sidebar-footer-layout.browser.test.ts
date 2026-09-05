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
  beforeAll(async () => {
    if (!chromiumAvailable) {
      return;
    }
    await page.setContent(`
      <!doctype html>
      <html data-theme-mode="light">
        <head>
          <style>${readUiCss()}</style>
          <style>
            .footer-layout-fixture {
              display: flex;
              width: 576px;
              height: 220px;
            }
            .footer-layout-fixture > * {
              width: 288px;
              min-height: 0;
            }
          </style>
        </head>
        <body>
          <main class="shell footer-layout-fixture">
            <section class="sidebar-shell">
              <div class="sidebar-shell__content"></div>
              <div class="sidebar-shell__footer">
                <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
                  <button class="sidebar-identity-card" type="button">
                    <span class="viewer-avatar viewer-avatar--footer is-fallback">
                      <span class="viewer-avatar__fallback">M</span>
                    </span>
                    <span class="sidebar-identity-card__text">
                      <span class="sidebar-identity-card__name">Mason</span>
                    </span>
                  </button>
                  <span class="sidebar-footer-actions">
                    <button class="sidebar-issues-button" type="button">
                      <span class="sidebar-issues-button__icon"></span>
                    </button>
                  </span>
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
  });

  it("lands both sidebar footers on one divider line", async () => {
    // Height parity alone stayed true while the main divider sat a shell
    // gutter higher, so the takeover jumped: measure from the sidebar edge.
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const shell = box(".sidebar-shell");
      const shellFooter = box(".sidebar-shell__footer");
      const settings = box(".settings-sidebar");
      const settingsFooter = box(".settings-sidebar__footer");
      if (!(shell && shellFooter && settings && settingsFooter)) {
        return null;
      }
      return {
        mainHeight: shellFooter.height,
        settingsHeight: settingsFooter.height,
        mainDividerFromBottom: shell.bottom - shellFooter.top,
        settingsDividerFromBottom: settings.bottom - settingsFooter.top,
        mainOverhang: shell.bottom - shellFooter.bottom,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry?.settingsHeight).toBeCloseTo(geometry?.mainHeight ?? 0, 2);
    // The strip is chrome: it bleeds to the sidebar edge instead of sitting on
    // the shell's bottom content gutter.
    expect(geometry?.mainOverhang).toBeCloseTo(0, 2);
    expect(geometry?.settingsDividerFromBottom).toBeCloseTo(
      geometry?.mainDividerFromBottom ?? 0,
      2,
    );
  });

  it("centers the account row between the divider and the sidebar edge", async () => {
    const centering = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const shell = box(".sidebar-shell");
      const footer = box(".sidebar-shell__footer");
      const card = box(".sidebar-identity-card");
      const action = box(".sidebar-issues-button");
      if (!(shell && footer && card && action)) {
        return null;
      }
      const dividerWidth = Number.parseFloat(
        getComputedStyle(document.querySelector(".sidebar-shell__footer") as Element)
          .borderBlockStartWidth,
      );
      return {
        above: card.top - (footer.top + dividerWidth),
        below: shell.bottom - card.bottom,
        cardCenterY: (card.top + card.bottom) / 2,
        actionCenterY: (action.top + action.bottom) / 2,
        leadingInset: card.left - shell.left,
        trailingInset: shell.right - action.right,
      };
    });

    expect(centering).not.toBeNull();
    // Measured from the divider's inner edge, the band splits evenly.
    expect(centering?.above).toBeCloseTo(centering?.below ?? 0, 2);
    expect(centering?.actionCenterY).toBeCloseTo(centering?.cardCenterY ?? 0, 2);
    expect(centering?.trailingInset).toBeCloseTo(centering?.leadingInset ?? 0, 2);
  });
});
