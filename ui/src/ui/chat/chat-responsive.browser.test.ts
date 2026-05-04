import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VIEWPORTS = [
  [320, 568],
  [375, 812],
  [430, 932],
  [768, 1024],
  [1024, 768],
  [1366, 900],
  [1440, 900],
] as const;
const TOUCH_TARGET_MIN_PX = 43.5;
const describeBrowserLayout = existsSync(chromium.executablePath()) ? describe : describe.skip;

let browser: Browser;

function readUiCss(): string {
  const roots = [process.cwd(), resolve(process.cwd(), "ui")];
  const files = [
    "src/styles/base.css",
    "src/styles/layout.css",
    "src/styles/layout.mobile.css",
    "src/styles/components.css",
    "src/styles/chat/layout.css",
    "src/styles/chat/text.css",
    "src/styles/chat/grouped.css",
    "src/styles/chat/tool-cards.css",
    "src/styles/chat/sidebar.css",
  ];
  return files
    .map((file) => {
      const path = roots
        .map((root) => resolve(root, file))
        .find((candidate) => existsSync(candidate));
      expect(path, `Missing CSS fixture ${file}`).toBeTruthy();
      return readFileSync(path!, "utf8");
    })
    .join("\n");
}

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function chatControlsHtml(opts: { agent?: boolean } = {}) {
  const showAgent = opts.agent !== false;
  return `
    <div class="chat-mobile-controls-wrapper">
      <button class="btn btn--sm btn--icon chat-controls-mobile-toggle" aria-expanded="true" aria-controls="chat-mobile-controls-dropdown">${iconSvg()}</button>
      <div id="chat-mobile-controls-dropdown" class="chat-controls-dropdown open">
        <div class="chat-controls">
          <div class="chat-controls__session-row${showAgent ? "" : " chat-controls__session-row--single-agent"}">
            ${
              showAgent
                ? `<label class="field chat-controls__session chat-controls__agent">
                    <select data-chat-agent-filter="true" aria-label="Filter sessions by agent"><option>Alpha</option><option>Beta</option></select>
                  </label>`
                : ""
            }
            <label class="field chat-controls__session chat-controls__session-picker">
              <select data-chat-session-select="true" aria-label="Chat session"><option>Daily planning</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__model">
              <select data-chat-model-select="true" aria-label="Chat model"><option>Default (gpt-5)</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__thinking-select">
              <select class="chat-controls__thinking-select-full" data-chat-thinking-select="true" aria-label="Chat thinking level"><option>Default (high)</option></select>
            </label>
          </div>
          <div class="chat-controls__thinking">
            <button class="btn btn--sm btn--icon active">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active">${iconSvg()}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function chatHeaderControlsHtml(hidden = false) {
  return `
    <main class="content content--chat" data-chat-header-responsive-fixture>
      <section class="content-header${hidden ? " content-header--chat-hidden" : ""}"${hidden ? ' inert aria-hidden="true"' : ""}>
        <div>
          <div class="chat-controls__session-row">
            <label class="field chat-controls__session chat-controls__agent">
              <select data-chat-agent-filter="true" aria-label="Filter sessions by agent"><option>Valentina</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__session-picker">
              <select data-chat-session-select="true" aria-label="Chat session"><option>main</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__model">
              <select data-chat-model-select="true" aria-label="Chat model"><option>gpt-5.5</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__thinking-select">
              <select class="chat-controls__thinking-select-full" data-chat-thinking-select="true" aria-label="Chat thinking level"><option>Default (high)</option></select>
            </label>
          </div>
        </div>
        <div class="page-meta">
          <div class="chat-controls">
            <button class="btn btn--sm btn--icon" aria-label="Refresh chat data">${iconSvg()}</button>
            <span class="chat-controls__separator">|</span>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle assistant thinking">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle tool calls">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon" aria-label="Toggle focus mode">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active" aria-label="Show cron sessions">${iconSvg()}</button>
          </div>
        </div>
      </section>
      <section class="card chat"></section>
    </main>
  `;
}

function chatHtml(opts: { sideResult?: boolean; singleAgent?: boolean } = {}) {
  return `
    <div class="shell shell--chat" data-chat-responsive-fixture>
      <header class="topbar">
        <div class="topnav-shell">
          <div class="topnav-shell__actions">
            <button class="topbar-search"><span class="topbar-search__label">Search</span><kbd class="topbar-search__kbd">K</kbd></button>
            <div class="topbar-status">${chatControlsHtml({ agent: !opts.singleAgent })}</div>
          </div>
        </div>
      </header>
      <main class="content content--chat">
        <section class="card chat">
          <div class="chat-split-container">
            <div class="chat-main">
              <div class="chat-thread" role="log">
                <div class="chat-thread-inner">
                  <div class="chat-group user">
                    <div class="chat-avatar user">V</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">Please keep every control visible at the smallest viewport.</div></div>
                    </div>
                  </div>
                  <div class="chat-group assistant">
                    <div class="chat-avatar assistant">A</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble has-copy">
                        <div class="chat-text">
                          <p>The chat shell should stay compact and readable.</p>
                          <pre><code>const importantLongIdentifier = "control-ui-chat-responsive-regression-fixture-keeps-code-scrollable"; console.log(importantLongIdentifier);</code></pre>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          ${
            opts.sideResult
              ? `<section class="chat-side-result" role="status" aria-live="polite">
                  <div class="chat-side-result__header">
                    <div class="chat-side-result__label-row"><span class="chat-side-result__label">BTW</span><span class="chat-side-result__meta">Not saved to chat history</span></div>
                    <button class="btn chat-side-result__dismiss">${iconSvg()}</button>
                  </div>
                  <div class="chat-side-result__question">What should I check next?</div>
                  <div class="chat-side-result__body"><p>Inspect the responsive controls and keep the transcript usable.</p></div>
                </section>`
              : ""
          }
          <div class="agent-chat__input">
            <div class="agent-chat__composer-combobox">
              <textarea rows="1">Queued follow-up for the active operator session</textarea>
            </div>
            <div class="agent-chat__toolbar">
              <div class="agent-chat__toolbar-left">
                <button class="agent-chat__input-btn">${iconSvg()}</button>
                <button class="agent-chat__input-btn">${iconSvg()}</button>
                <span class="agent-chat__token-count">8</span>
              </div>
              <div class="agent-chat__toolbar-right">
                <button class="btn btn--ghost">${iconSvg()}</button>
                <button class="btn btn--ghost">${iconSvg()}</button>
                <button class="chat-send-btn">${iconSvg()}</button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}

async function openFixture(
  width: number,
  height: number,
  opts: { sideResult?: boolean; singleAgent?: boolean } = {},
) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts)}</body></html>`,
  );
  return page;
}

async function openHeaderFixture(width: number, height: number, opts: { hidden?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHeaderControlsHtml(Boolean(opts.hidden))}</body></html>`,
  );
  return page;
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.html).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

describeBrowserLayout("chat responsive browser layout", () => {
  it.each([
    [1120, 740],
    [1366, 900],
    [1440, 900],
  ] as const)("keeps desktop chat controls in one row at %sx%s", async (width, height) => {
    const page = await openHeaderFixture(width, height);
    try {
      await expectNoHorizontalOverflow(page);
      const controls = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector(selector);
          const rect = node?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        };
        return {
          session: rectFor('[data-chat-session-select="true"]'),
          agent: rectFor('[data-chat-agent-filter="true"]'),
          model: rectFor('[data-chat-model-select="true"]'),
          thinking: rectFor('[data-chat-thinking-select="true"]'),
          action: rectFor(".page-meta .btn--icon"),
        };
      });
      const rowY = [
        controls.session?.y,
        controls.agent?.y,
        controls.model?.y,
        controls.thinking?.y,
        controls.action?.y,
      ].filter((value): value is number => typeof value === "number");
      expect(rowY.length).toBe(5);
      expect(Math.max(...rowY) - Math.min(...rowY)).toBeLessThanOrEqual(4);
      expect(controls.agent!.x).toBeLessThan(controls.session!.x);
      expect(controls.session!.width / controls.agent!.width).toBeGreaterThan(1.25);
      expect(controls.session!.width / controls.agent!.width).toBeLessThan(1.55);
    } finally {
      await page.close();
    }
  });

  it("collapses the desktop chat controls row when scroll state hides it", async () => {
    const page = await openHeaderFixture(1366, 900, { hidden: true });
    try {
      const hiddenState = await page.evaluate(() => {
        const header = document.querySelector(".content-header") as HTMLElement | null;
        const rect = header?.getBoundingClientRect();
        const style = header ? getComputedStyle(header) : null;
        return {
          height: rect?.height ?? -1,
          opacity: style?.opacity ?? "",
          pointerEvents: style?.pointerEvents ?? "",
        };
      });
      expect(hiddenState.height).toBeLessThanOrEqual(1);
      expect(hiddenState.opacity).toBe("0");
      expect(hiddenState.pointerEvents).toBe("none");
    } finally {
      await page.close();
    }
  });

  it.each(VIEWPORTS)("keeps the chat shell inside the viewport at %sx%s", async (width, height) => {
    const page = await openFixture(width, height);
    try {
      await expectNoHorizontalOverflow(page);
      const code = await page.locator(".chat-text pre").boundingBox();
      expect(code).not.toBeNull();
      expect(code!.x + code!.width).toBeLessThanOrEqual(width + 1);
    } finally {
      await page.close();
    }
  });

  it.each(["dark", "light"] as const)(
    "keeps mobile controls inside the viewport with touch targets in %s mode",
    async (themeMode) => {
      const page = await openFixture(320, 568);
      try {
        await page.evaluate(
          (mode) => document.documentElement.setAttribute("data-theme-mode", mode),
          themeMode,
        );
        const dropdown = await page.locator(".chat-controls-dropdown.open").boundingBox();
        expect(dropdown).not.toBeNull();
        expect(dropdown!.x).toBeGreaterThanOrEqual(8);
        expect(dropdown!.x + dropdown!.width).toBeLessThanOrEqual(312);
        await expectNoHorizontalOverflow(page);
        const mobileControls = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLSelectElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              text: node.options[node.selectedIndex]?.textContent?.trim() ?? "",
              display: getComputedStyle(node).display,
            };
          };
          return {
            agent: rectFor('[data-chat-agent-filter="true"]'),
            session: rectFor('[data-chat-session-select="true"]'),
            thinkingFull: rectFor('[data-chat-thinking-select="true"]'),
            compactCount: document.querySelectorAll('[data-chat-thinking-select-compact="true"]')
              .length,
          };
        });
        expect(mobileControls.agent).not.toBeNull();
        expect(mobileControls.session).not.toBeNull();
        expect(mobileControls.session!.y).toBe(mobileControls.agent!.y);
        expect(mobileControls.agent!.x).toBeLessThan(mobileControls.session!.x);
        expect(mobileControls.session!.width / mobileControls.agent!.width).toBeGreaterThan(1.25);
        expect(mobileControls.session!.width / mobileControls.agent!.width).toBeLessThan(1.55);
        expect(mobileControls.thinkingFull?.display).not.toBe("none");
        expect(mobileControls.thinkingFull?.text).toBe("Default (high)");
        expect(mobileControls.compactCount).toBe(0);

        const sizes = await page
          .locator(".chat-controls-mobile-toggle, .chat-controls-dropdown .btn--icon")
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = (node as HTMLElement).getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            }),
          );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) {
          expect(size.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(size.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        }
      } finally {
        await page.close();
      }
    },
  );

  it("keeps composer actions touch-sized on phones", async () => {
    const page = await openFixture(320, 568);
    try {
      const sizes = await page
        .locator(".agent-chat__input-btn, .agent-chat__toolbar .btn--ghost, .chat-send-btn")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = (node as HTMLElement).getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }),
        );
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) {
        expect(size.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        expect(size.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      }
    } finally {
      await page.close();
    }
  });

  it("uses the compact mobile grid when the agent filter is not rendered", async () => {
    const page = await openFixture(320, 568, { singleAgent: true });
    try {
      await expectNoHorizontalOverflow(page);
      expect(await page.locator('[data-chat-agent-filter="true"]').count()).toBe(0);
      const session = await page.locator('[data-chat-session-select="true"]').boundingBox();
      const model = await page.locator('[data-chat-model-select="true"]').boundingBox();
      const thinking = await page.locator('[data-chat-thinking-select="true"]').boundingBox();
      expect(session).not.toBeNull();
      expect(model).not.toBeNull();
      expect(thinking).not.toBeNull();
      expect(thinking!.x).toBeGreaterThan(session!.x);
      expect(model!.y).toBeGreaterThan(session!.y);
      expect(model!.width).toBeGreaterThan(session!.width);
    } finally {
      await page.close();
    }
  });

  it("renders BTW side results as a mobile overlay without horizontal overflow", async () => {
    const page = await openFixture(320, 568, { sideResult: true });
    try {
      await expectNoHorizontalOverflow(page);
      const position = await page
        .locator(".chat-side-result")
        .evaluate((node) => getComputedStyle(node).position);
      expect(position).toBe("fixed");
    } finally {
      await page.close();
    }
  });
});
