// Control UI tests cover form controls behavior.
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

type MobileFixture = {
  browser: Browser;
  page: Page;
};

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/config.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/usage.css",
    "ui/src/styles/chat/layout.css",
  ];
  return files.map((file) => readStyleSheet(file)).join("\n");
}

function controlsHtml() {
  return `
    <main>
      <label class="field"><input type="text" value="field input" /></label>
      <label class="field"><textarea>field textarea</textarea></label>
      <label class="field"><select><option>field select</option></select></label>
      <label class="field checkbox"><input type="checkbox" /><span>field checkbox</span></label>
      <label class="field checkbox"><input type="radio" /><span>field radio</span></label>
      <input class="config-search__input" value="search" />
      <input class="settings-sidebar__search-input" value="settings search" />
      <input class="settings-theme-import__input" value="theme" />
      <label class="config-raw-field"><textarea>raw config</textarea></label>
      <input class="cfg-input" value="config input" />
      <input class="cfg-input cfg-input--sm" value="small config input" />
      <textarea class="cfg-textarea">config textarea</textarea>
      <textarea class="cfg-textarea cfg-textarea--sm">small config textarea</textarea>
      <label class="cfg-number"><input class="cfg-number__input" value="1" /></label>
      <select class="cfg-select"><option>config select</option></select>
      <input class="usage-date-input" value="2026-05-31" />
      <select class="usage-select"><option>usage select</option></select>
      <input class="usage-query-input" value="usage query" />
      <div class="usage-filters-inline">
        <select><option>inline usage select</option></select>
        <input type="text" value="inline usage input" />
      </div>
      <div class="agent-chat__composer-combobox"><textarea>chat composer</textarea></div>
    </main>
  `;
}

async function openMobileFixture(): Promise<MobileFixture> {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  let page: Page | undefined;
  try {
    page = await browser.newPage({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    await page.setContent(
      `<!doctype html><html data-theme-mode="light"><head><style>${readUiCss()}</style></head><body>${controlsHtml()}</body></html>`,
    );
    return { browser, page };
  } catch (error) {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeMobileFixture(fixture: MobileFixture): Promise<void> {
  await fixture.page.close().catch(() => {});
  await fixture.browser.close().catch(() => {});
}

describeBrowserLayout("touch-primary form controls", () => {
  it("keeps text-entry controls large enough to avoid mobile focus zoom", async () => {
    const fixture = await openMobileFixture();
    const { page } = fixture;
    try {
      const metrics = await page.evaluate(() => {
        const selectors = [
          ".field input",
          ".field textarea",
          ".field select",
          ".config-search__input",
          ".settings-sidebar__search-input",
          ".settings-theme-import__input",
          ".config-raw-field textarea",
          ".cfg-input",
          ".cfg-input--sm",
          ".cfg-textarea",
          ".cfg-textarea--sm",
          ".cfg-number__input",
          ".cfg-select",
          ".usage-date-input",
          ".usage-select",
          ".usage-query-input",
          '.usage-filters-inline input[type="text"]',
          ".usage-filters-inline select",
          ".agent-chat__composer-combobox > textarea",
        ];
        return {
          touchPrimary: matchMedia("(hover: none) and (pointer: coarse)").matches,
          sizes: selectors.map((selector) => {
            const node = document.querySelector(selector);
            if (!(node instanceof HTMLElement)) {
              throw new Error(`Missing control ${selector}`);
            }
            return {
              selector,
              fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
            };
          }),
        };
      });

      expect(metrics.touchPrimary).toBe(true);
      for (const size of metrics.sizes) {
        expect(size.fontSize, size.selector).toBeGreaterThanOrEqual(16);
      }
    } finally {
      await closeMobileFixture(fixture);
    }
  });

  it("keeps native select affordances visible in light mode", async () => {
    const fixture = await openMobileFixture();
    const { page } = fixture;
    try {
      const selects = await page.locator(".cfg-select, .field select").evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            image: style.backgroundImage,
            paddingRight: Number.parseFloat(style.paddingRight),
            repeat: style.backgroundRepeat,
          };
        }),
      );

      expect(selects).toHaveLength(2);
      for (const select of selects) {
        expect(select.image).not.toBe("none");
        expect(select.paddingRight).toBeGreaterThanOrEqual(32);
        expect(select.repeat).toContain("no-repeat");
      }
    } finally {
      await closeMobileFixture(fixture);
    }
  });

  it("aligns text controls without stretching checkbox and radio inputs", async () => {
    const fixture = await openMobileFixture();
    const { page } = fixture;
    try {
      const dimensions = await page.evaluate(() => {
        const height = (selector: string) => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            throw new Error(`Missing control ${selector}`);
          }
          return node.getBoundingClientRect().height;
        };
        return {
          checkbox: height('.field input[type="checkbox"]'),
          radio: height('.field input[type="radio"]'),
          select: height(".field select"),
          text: height('.field input[type="text"]'),
        };
      });

      expect(dimensions.text).toBe(38);
      expect(dimensions.select).toBe(38);
      expect(dimensions.checkbox).toBeLessThan(38);
      expect(dimensions.radio).toBeLessThan(38);
    } finally {
      await closeMobileFixture(fixture);
    }
  });
});
