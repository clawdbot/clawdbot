// Control UI tests cover form controls behavior.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeBrowserLayout = chromiumAvailable ? describe : describe.skip;

type MobileFixture = {
  page: Page;
};

let browser: Browser;
let desktopContext: BrowserContext;
let mobileContext: BrowserContext;

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/config.css",
    "ui/src/styles/settings.css",
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
      <label class="field"><select class="settings-select"><option>field settings select</option></select></label>
      <label class="field checkbox"><input type="checkbox" /><span>field checkbox</span></label>
      <label class="field checkbox"><input type="radio" /><span>field radio</span></label>
      <input class="settings-sidebar__search-input" value="settings search" />
      <input class="settings-theme-import__input" value="theme" />
      <label class="config-raw-field"><textarea>raw config</textarea></label>
      <input class="settings-input" value="config input" />
      <div class="settings-row__control"><textarea class="settings-input">config textarea</textarea></div>
      <select class="settings-select"><option>settings select</option></select>
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

function mediaDeviceRowsHtml() {
  return `
    <main style="width: 100%; max-width: 900px">
      <div class="settings-row">
        <div class="settings-row__text"><span class="settings-row__title">Microphone input</span></div>
        <div class="settings-row__control">
          <select class="settings-select settings-select--media-device">
            <option>MacBook Pro Microphone (Built-in)</option>
          </select>
          <button class="btn btn--sm btn--icon" type="button">↻</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row__text"><span class="settings-row__title">Camera</span></div>
        <div class="settings-row__control">
          <select class="settings-select settings-select--media-device">
            <option>System default</option>
          </select>
          <button class="btn btn--sm btn--icon" type="button">↻</button>
        </div>
      </div>
    </main>
  `;
}

async function openMobileFixture(): Promise<MobileFixture> {
  let page: Page | undefined;
  try {
    page = await mobileContext.newPage();
    await page.setContent(
      `<!doctype html><html data-theme-mode="light"><head><style>${readUiCss()}</style></head><body>${controlsHtml()}</body></html>`,
    );
    return { page };
  } catch (error) {
    await page?.close().catch(() => {});
    throw error;
  }
}

async function closeMobileFixture(fixture: MobileFixture): Promise<void> {
  await fixture.page.close().catch(() => {});
}

beforeAll(async () => {
  if (!chromiumAvailable) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  try {
    [desktopContext, mobileContext] = await Promise.all([
      browser.newContext(),
      browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      }),
    ]);
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
});

afterAll(async () => {
  await Promise.all([
    desktopContext?.close().catch(() => {}),
    mobileContext?.close().catch(() => {}),
  ]);
  await browser?.close().catch(() => {});
});

describeBrowserLayout("settings media device controls", () => {
  it("keeps paired selectors the same width across device labels and viewports", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.setContent(
        `<!doctype html><html data-theme-mode="light"><head><style>${readUiCss()}</style></head><body>${mediaDeviceRowsHtml()}</body></html>`,
      );

      const measure = () =>
        page.locator(".settings-row").evaluateAll((rows) =>
          rows.map((row) => {
            const select = row.querySelector(".settings-select--media-device");
            const button = row.querySelector(".btn--icon");
            if (!(select instanceof HTMLElement) || !(button instanceof HTMLElement)) {
              throw new Error("Missing media device controls");
            }
            const selectRect = select.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            return {
              selectWidth: selectRect.width,
              selectTop: selectRect.top,
              buttonTop: buttonRect.top,
            };
          }),
        );

      const desktop = await measure();
      expect(desktop.map((row) => row.selectWidth)).toEqual([340, 340]);
      expect(desktop.every((row) => row.selectTop === row.buttonTop)).toBe(true);

      await page.setViewportSize({ width: 390, height: 800 });
      await page.locator("main").evaluate((main) => {
        main.style.width = "285px";
      });
      const mobile = await measure();
      expect(mobile[0]?.selectWidth).toBeCloseTo(mobile[1]?.selectWidth ?? 0, 5);
      expect(mobile[0]?.selectWidth).toBeLessThan(340);
      expect(mobile.every((row) => row.selectTop === row.buttonTop)).toBe(true);
    } finally {
      await page.close().catch(() => {});
    }
  });
});

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
          ".settings-sidebar__search-input",
          ".settings-theme-import__input",
          ".config-raw-field textarea",
          "input.settings-input",
          ".settings-row__control > textarea.settings-input",
          ".settings-select",
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

  it("keeps settings select affordances visible in light mode", async () => {
    const fixture = await openMobileFixture();
    const { page } = fixture;
    try {
      const selects = await page.locator(".field select.settings-select").evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            image: style.backgroundImage,
            paddingRight: Number.parseFloat(style.paddingRight),
            positionX: style.backgroundPositionX,
            repeat: style.backgroundRepeat,
          };
        }),
      );

      expect(selects).toHaveLength(1);
      for (const select of selects) {
        expect(select.image).not.toBe("none");
        expect(select.paddingRight).toBeGreaterThanOrEqual(32);
        expect(select.positionX).toBe("calc(100% - 10px)");
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

describeBrowserLayout("mount fallback cursor", () => {
  it("uses the default cursor for its controls and the pointer for its real link", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setContent(readStyleSheet("ui/index.html"));
      const cursors = await page.evaluate(() => {
        const cursor = (selector: string) => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            throw new Error(`Missing cursor fixture ${selector}`);
          }
          return getComputedStyle(node).cursor;
        };
        return {
          retry: cursor("#openclaw-mount-retry"),
          wait: cursor("#openclaw-mount-wait"),
          docs: cursor('.mount-fallback__panel a[href^="https://"]'),
        };
      });

      expect(cursors).toEqual({
        retry: "default",
        wait: "default",
        docs: "pointer",
      });
    } finally {
      await page.close().catch(() => {});
    }
  });
});

describeBrowserLayout("app chrome interaction styles", () => {
  it("keeps sidebars compact while preserving normal content scroll and text entry", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.setContent(`
        <!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <aside class="settings-sidebar">
              <nav class="settings-sidebar__nav">
                <span class="settings-sidebar__item-label">Settings row</span>
              </nav>
              <input class="settings-sidebar__search-input" value="editable settings search" />
            </aside>
            <aside class="sidebar">
              <div class="sidebar-shell__body">Recent session</div>
            </aside>
            <main class="content" style="height: 100px">
              <div class="settings-card">App chrome tile</div>
              <div style="height: 200px"></div>
            </main>
            <section class="chat-thread" style="height: 100px">Selectable transcript</section>
          </body>
        </html>
      `);

      const metrics = await page.evaluate(() => {
        const style = (selector: string) => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            throw new Error(`Missing interaction fixture ${selector}`);
          }
          return getComputedStyle(node);
        };
        const scrollbarWidth = (selector: string) => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            throw new Error(`Missing scrollbar fixture ${selector}`);
          }
          return getComputedStyle(node, "::-webkit-scrollbar").width;
        };
        return {
          chatSelection: style(".chat-thread").userSelect,
          chromeSelection: style(".settings-card").userSelect,
          contentScrollbar: scrollbarWidth(".content"),
          inputSelection: style(".settings-sidebar__search-input").userSelect,
          regularSidebarScrollbar: scrollbarWidth(".sidebar-shell__body"),
          regularSidebarSelection: style(".sidebar-shell__body").userSelect,
          settingsSidebarScrollbar: scrollbarWidth(".settings-sidebar__nav"),
          settingsSidebarSelection: style(".settings-sidebar__nav").userSelect,
        };
      });

      expect(metrics).toEqual({
        chatSelection: "text",
        chromeSelection: "none",
        contentScrollbar: "12px",
        inputSelection: "text",
        regularSidebarScrollbar: "6px",
        regularSidebarSelection: "none",
        settingsSidebarScrollbar: "6px",
        settingsSidebarSelection: "none",
      });
    } finally {
      await page.close().catch(() => {});
    }
  });
});
