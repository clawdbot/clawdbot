// Control UI tests cover chat responsive behavior.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

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
// Real-app cases boot through a cold Vite dev server that transforms the whole
// Control UI module graph on first request; with 6 Vitest workers sharing an
// 8vCPU CI runner that first render can starve well past 10s. Budget the
// first-render waits for contention while staying inside the 60s testTimeout.
const APP_FIRST_RENDER_TIMEOUT_MS = 30_000;
const FULL_APP_TEST_OPTIONS = {
  // These cases cold-boot Vite through one shared Chromium/server pair. Keep them
  // as a sequential barrier so concurrent layout pages cannot starve navigation.
  concurrent: false,
  timeout: 60_000,
} as const;
const LONG_SIDE_CHAT_BODY = Array.from(
  { length: 80 },
  (_, index) => `<p>Line ${index + 1}: keep the complete side result readable.</p>`,
).join("");
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

let sharedBrowser: Browser | null = null;
let realChatServer: ControlUiE2eServer | null = null;

type ControlRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  clientHeight?: number;
  scrollHeight?: number;
  scrollTop?: number;
  text?: string;
  display?: string;
};

type ChatFixtureOptions = {
  composerAttachment?: boolean;
  direct?: boolean;
  sideChatBody?: string;
  singleAgent?: boolean;
  slashMenu?: boolean;
};

function expectFiniteRect(rect: Pick<ControlRect, "x" | "y" | "width" | "height">) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Number.isFinite(rect[key])).toBe(true);
  }
}

async function getBoundingBox(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`Expected bounding box for ${selector}`);
  }
  expectFiniteRect(box);
  return box;
}

function expectControlRect(rect: ControlRect | null, label: string): ControlRect {
  if (rect === null) {
    throw new Error(`Expected ${label} control rect`);
  }
  expectFiniteRect(rect);
  return rect;
}

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/layout.mobile.css",
    "ui/src/styles/components.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/text.css",
    "ui/src/styles/chat/grouped.css",
    "ui/src/styles/chat/tool-cards.css",
    "ui/src/styles/chat/question-card.css",
    "ui/src/styles/chat/sidebar.css",
  ];
  return files.map((file) => readStyleSheet(file)).join("\n");
}

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function activityAlignmentHtml() {
  return `
    <div class="chat-thread" role="log">
      <div class="chat-thread-inner">
        <div class="chat-group tool chat-group--activity">
          <div class="chat-avatar tool">A</div>
          <div class="chat-group-messages">
            <div class="chat-activity-group is-open">
              <button class="chat-activity-group__summary chat-activity-group__summary--error" type="button">
                <span class="chat-activity-group__icon">${iconSvg()}</span>
                <span class="chat-activity-group__label">Activity: 2 tools</span>
              </button>
              <div class="chat-activity-group__body">
                <div class="chat-bubble chat-bubble--tool-shell" data-activity-call-row>
                  <div class="chat-tools-inline">
                    <div class="chat-tool-msg-collapse">
                      <button class="chat-tool-msg-summary" type="button">
                        <span class="chat-tool-msg-summary__icon">${iconSvg()}</span>
                        <span class="chat-tool-msg-summary__label">Bash</span>
                        <span class="chat-tool-msg-summary__names">search a deliberately long workspace path without extra card chrome</span>
                      </button>
                    </div>
                  </div>
                </div>
                <div class="chat-bubble chat-bubble--tool-shell">
                  <div class="chat-tool-msg-collapse">
                    <button class="chat-tool-msg-summary chat-tool-msg-summary--error" type="button">
                      <span class="chat-tool-msg-summary__icon">${iconSvg()}</span>
                      <span class="chat-tool-msg-summary__label">Tool error</span>
                      <span class="chat-tool-msg-summary__names">Bash</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function chatFooterActionsHtml() {
  return `
    <div class="chat-group-footer-actions">
      <button class="chat-expand-btn" type="button" aria-label="Open in canvas">
        <span class="chat-expand-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>
      <button class="chat-copy-btn" type="button" aria-label="Copy as markdown">
        <span class="chat-copy-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>
    </div>
  `;
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
              <select data-chat-session-select="true" aria-label="Chat thread"><option>Daily planning</option></select>
            </label>
            <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
              <summary class="chat-controls__inline-select-trigger" data-chat-model-select="true" data-chat-thinking-select="true" data-chat-select-value="" data-chat-thinking-value="" aria-label="Chat model">gpt-5 · High</summary>
            </details>
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

function composerControlsHtml() {
  return `
    <div class="agent-chat__composer-controls">
      <div class="chat-view-menu-wrapper">
        <wa-dropdown class="chat-view-menu" aria-label="View">
          <button slot="trigger" class="chat-view-menu-trigger" type="button" aria-label="View">
            ${iconSvg()}
          </button>
          <wa-dropdown-item class="chat-view-menu__item" type="checkbox">Reasoning</wa-dropdown-item>
        </wa-dropdown>
      </div>
      <div class="chat-composer-model-control">
        <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
          <summary class="chat-controls__inline-select-trigger" data-chat-composer-model="true" aria-label="Chat model">
            <span class="chat-controls__inline-select-label">Default model · Off</span>
            <span class="chat-controls__inline-select-icon">${iconSvg()}</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined">
            <div class="chat-controls__combined-model-list">
              <button class="chat-controls__inline-select-option chat-controls__combined-model-option chat-controls__inline-select-option--selected">Default model</button>
              <button class="chat-controls__inline-select-option chat-controls__combined-model-option">gpt-5.5</button>
              <button class="chat-controls__inline-select-option chat-controls__combined-model-option">claude-sonnet-4-6</button>
            </div>
            <div class="chat-controls__reasoning-panel">Reasoning</div>
          </div>
        </details>
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
              <select data-chat-session-select="true" aria-label="Chat thread"><option>main</option></select>
            </label>
            <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
              <summary class="chat-controls__inline-select-trigger" data-chat-model-select="true" data-chat-thinking-select="true" data-chat-select-value="gpt-5.5" data-chat-thinking-value="" aria-label="Chat model">gpt-5.5 · High</summary>
            </details>
          </div>
        </div>
        <div class="page-meta">
          <div class="chat-controls">
            <button class="btn btn--sm btn--icon" aria-label="Refresh chat data">${iconSvg()}</button>
            <span class="chat-controls__separator">|</span>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle assistant thinking">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle tool calls">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active" aria-label="Show cron sessions">${iconSvg()}</button>
          </div>
        </div>
      </section>
      <section class="card chat"></section>
    </main>
  `;
}

function chatHtml(opts: ChatFixtureOptions = {}, mobileNavLayout = false) {
  return `
    <div class="shell shell--chat${mobileNavLayout ? " shell--mobile-nav" : ""}" data-chat-responsive-fixture>
      <header class="topbar">
        <div class="topnav-shell">
          <div class="topnav-shell__actions">
            <button class="topbar-search">${iconSvg()}</button>
            <div>${chatControlsHtml({ agent: !opts.singleAgent })}</div>
          </div>
        </div>
      </header>
      <main class="content content--chat">
        <section class="card chat">
          <div class="chat-split-container">
            <div class="chat-main" style="flex: 1 1 100%">
              <div class="chat-thread${opts.direct ? " chat-thread--direct" : ""}" role="log">
                <div class="chat-thread-inner">
                  <div class="chat-group user">
                    <div class="chat-avatar user">V</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">Keep this visible.</div></div>
                    </div>
                  </div>
                  <div class="chat-group assistant chat-group--with-footer">
                    <div class="chat-avatar assistant">A</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">It stays readable.</div></div>
                      <div class="chat-bubble">
                        <div class="chat-text">
                          <p>The chat shell should stay compact and readable.</p>
                          <pre><code>const importantLongIdentifier = "control-ui-chat-responsive-regression-fixture-keeps-code-scrollable"; console.log(importantLongIdentifier);</code></pre>
                        </div>
                      </div>
                    </div>
                    <div class="chat-group-footer">
                      <div class="chat-group-footer__meta">
                        <span class="chat-sender-name">Assistant</span>
                        <span class="chat-group-timestamp">9:41 PM</span>
                      </div>
                      ${chatFooterActionsHtml()}
                    </div>
                  </div>
                </div>
              </div>
              ${
                opts.sideChatBody !== undefined
                  ? `<section class="chat-side-chat" role="dialog" aria-label="Side chat">
                      <header class="chat-side-chat__header">
                        <div class="chat-side-chat__heading">
                          <h2 class="chat-side-chat__title">Side chat</h2>
                          <span class="chat-side-chat__meta">Not saved to chat history</span>
                        </div>
                        <div class="chat-side-chat__actions">
                          <button class="btn btn--ghost btn--icon chat-icon-btn">${iconSvg()}</button>
                          <button class="btn btn--ghost btn--icon chat-icon-btn">${iconSvg()}</button>
                        </div>
                      </header>
                      <div class="chat-side-chat__scroll">
                        <article class="chat-side-chat__turn">
                          <div class="chat-side-chat__question">What should I check next?</div>
                          <div class="chat-side-chat__answer">${opts.sideChatBody}</div>
                        </article>
                      </div>
                      <footer class="chat-side-chat__composer">
                        <div class="chat-side-chat__prompt">
                          <input class="chat-side-chat__input" type="text" placeholder="Follow up…" />
                          <button class="btn btn--ghost btn--icon chat-icon-btn chat-side-chat__send">${iconSvg()}</button>
                        </div>
                      </footer>
                    </section>`
                  : ""
              }
              <div class="agent-chat__composer-shell">
                <div class="agent-chat__input">
                  ${
                    opts.slashMenu
                      ? `<div class="slash-menu" role="listbox" aria-label="Command suggestions">
                      <div class="slash-menu-group">
                        <div class="slash-menu-group__label">Commands</div>
                        <div class="slash-menu-item slash-menu-item--active" role="option" aria-selected="true">
                          <span class="slash-menu-icon">${iconSvg()}</span>
                          <span class="slash-menu-name">/plan</span>
                          <span class="slash-menu-desc">Create a plan</span>
                        </div>
                        <div class="slash-menu-item" role="option">
                          <span class="slash-menu-icon">${iconSvg()}</span>
                          <span class="slash-menu-name">/review</span>
                          <span class="slash-menu-desc">Review changes</span>
                        </div>
                        <div class="slash-menu-item" role="option">
                          <span class="slash-menu-icon">${iconSvg()}</span>
                          <span class="slash-menu-name">/fix</span>
                          <span class="slash-menu-desc">Fix current issue</span>
                        </div>
                      </div>
                    </div>`
                      : ""
                  }
                  ${
                    opts.composerAttachment
                      ? `<div class="chat-attachments-preview">
                      <div class="chat-attachment-thumb chat-attachment-thumb--file">
                        <div class="chat-attachment-file">
                          <span class="chat-attachment-file__icon">${iconSvg()}</span>
                          <span class="chat-attachment-file__name">landscape-proof-attachment.txt</span>
                        </div>
                        <button class="chat-attachment-remove" type="button" aria-label="Remove attachment">&times;</button>
                      </div>
                    </div>`
                      : ""
                  }
                  <div class="agent-chat__composer-status-stack"> </div>
                  <div class="agent-chat__composer-input-row">
                    <details class="agent-chat__attach-menu">
                      <summary class="agent-chat__input-btn agent-chat__input-btn--attach" aria-label="Add attachment">${iconSvg()}</summary>
                      <div class="agent-chat__attach-menu-popover" role="menu">
                        <button class="agent-chat__attach-menu-option" role="menuitem">${iconSvg()}<span>Camera</span></button>
                        <button class="agent-chat__attach-menu-option" role="menuitem">${iconSvg()}<span>Photo</span></button>
                        <button class="agent-chat__attach-menu-option" role="menuitem">${iconSvg()}<span>File</span></button>
                      </div>
                    </details>
                    <div class="agent-chat__composer-combobox">
                      <textarea rows="1">Queued follow-up for the active operator session</textarea>
                    </div>
                    <div class="agent-chat__composer-actions">
                      <button class="chat-send-btn chat-send-btn--voice" aria-label="Start voice input">${iconSvg()}</button>
                    </div>
                  </div>
                  <div class="agent-chat__composer-footer">
                    ${composerControlsHtml()}
                    <div class="agent-chat__composer-meta">
                      <div class="context-usage">
                        <details>
                          <summary class="context-ring" role="status" aria-label="Thread context usage: 46k/200k (23%)">
                            <svg class="context-ring__dial" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                              <circle class="context-ring__track" cx="8" cy="8" r="6.5"></circle>
                              <circle class="context-ring__fill" cx="8" cy="8" r="6.5"></circle>
                            </svg>
                          </summary>
                          <section class="context-usage__popover">
                            <div class="context-usage__section-label context-usage__plan-header">
                              <span>Plan usage</span>
                              <a class="context-usage__plan-link" href="/usage" data-chat-provider-usage="true">
                                <span class="context-usage__plan-badge">Max (20x)</span>${iconSvg()}
                              </a>
                            </div>
                            <div class="context-usage__limits">
                              <div class="context-usage__limit">
                                <div class="context-usage__limit-head">
                                  <span class="context-usage__limit-label">Weekly · all models</span>
                                  <span class="context-usage__limit-meta"><strong>72%</strong></span>
                                </div>
                                <div class="context-usage__limit-bar"><span style="width: 72%"></span></div>
                              </div>
                            </div>
                          </section>
                        </details>
                      </div>
                      <span class="agent-chat__token-count">8</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}

async function openFixture(width: number, height: number, opts: ChatFixtureOptions = {}) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts, width <= 1100)}</body></html>`,
    );
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function openBrowserPage(width: number, height: number): Promise<Page> {
  sharedBrowser ??= await chromium.launch({
    executablePath: chromiumExecutablePath,
    headless: true,
  });
  return await sharedBrowser.newPage({ viewport: { width, height } });
}

async function closeBrowserPage(page: Page): Promise<void> {
  await page.close().catch(() => {});
}

async function waitForLayoutSettled(page: Page): Promise<void> {
  // Raw DOM mutations skip Playwright's actionability wait. Allow style invalidation
  // to land, then observe one stable frame before measuring viewport bounds.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function getRect(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const bounds = (node as HTMLElement).getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expectFiniteRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return rect;
}

async function getTextContentRect(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const bounds = range.getBoundingClientRect();
    range.detach();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expectFiniteRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return rect;
}

function rectsOverlap(
  first: Pick<ControlRect, "x" | "y" | "width" | "height">,
  second: Pick<ControlRect, "x" | "y" | "width" | "height">,
) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

async function openHeaderFixture(width: number, height: number, opts: { hidden?: boolean } = {}) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHeaderControlsHtml(Boolean(opts.hidden))}</body></html>`,
    );
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
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

describeBrowserLayout.concurrent("chat responsive browser layout", () => {
  beforeAll(async () => {
    sharedBrowser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      headless: true,
    });
    realChatServer = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await realChatServer?.close();
    realChatServer = null;
    await sharedBrowser?.close();
    sharedBrowser = null;
  });

  it.each([
    [320, 568],
    [1366, 900],
    [1440, 1400],
  ] as const)("keeps the first message clear of the topbar at %sx%s", async (width, height) => {
    const page = await openFixture(width, height);
    try {
      const spacing = await page.evaluate(() => {
        const thread = document.querySelector<HTMLElement>(".chat-thread");
        const firstMessage = document.querySelector<HTMLElement>(
          ".chat-thread-inner > .chat-group",
        );
        if (!thread || !firstMessage) {
          return null;
        }
        return {
          inset: firstMessage.getBoundingClientRect().top - thread.getBoundingClientRect().top,
          paddingTop: Number.parseFloat(getComputedStyle(thread).paddingTop),
        };
      });

      expect(spacing).not.toBeNull();
      expect(spacing?.paddingTop).toBeGreaterThanOrEqual(20);
      expect(spacing?.inset).toBeCloseTo(spacing?.paddingTop ?? 0, 0);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [430, 720],
    [1366, 900],
  ] as const)("right-aligns activity rows with call bubbles at %sx%s", async (width, height) => {
    const page = await openBrowserPage(width, height);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${activityAlignmentHtml()}</body></html>`,
      );

      await expectNoHorizontalOverflow(page);
      const callRow = await getRect(page, "[data-activity-call-row]");
      const errorSummary = await getRect(page, ".chat-tool-msg-summary--error");
      expect(Math.abs(callRow.right - errorSummary.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(callRow.height - errorSummary.height)).toBeLessThanOrEqual(1);
      const styles = await page.evaluate(() => {
        const call = document.querySelector<HTMLElement>("[data-activity-call-row]")!;
        return {
          activity: getComputedStyle(
            document.querySelector<HTMLElement>(".chat-activity-group__summary")!,
          ).userSelect,
          callBackground: getComputedStyle(call).backgroundColor,
          tool: getComputedStyle(document.querySelector<HTMLElement>(".chat-tool-msg-summary")!)
            .userSelect,
        };
      });
      expect(styles).toEqual({
        activity: "text",
        callBackground: "rgba(0, 0, 0, 0)",
        tool: "text",
      });
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("applies configured chat width to tool rows and composer without changing defaults", async () => {
    const page = await openBrowserPage(1600, 900);
    const renderFixture = async (configured: boolean) => {
      const style = configured
        ? 'style="--chat-thread-max-width: 82%; --chat-message-max-width: 100%"'
        : "";
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="card chat" ${style}>
          <div class="chat-thread chat-thread--direct" role="log">
            <div class="chat-thread-inner">
              <div class="chat-group tool">
                <div class="chat-avatar tool">A</div>
                <div class="chat-group-messages" data-tool-lane>
                  <div class="chat-bubble chat-bubble--tool-shell" data-tool-shell>
                    <div class="chat-tool-msg-collapse">Tool output</div>
                  </div>
                </div>
              </div>
              <div class="chat-group tool chat-group--activity">
                <div class="chat-avatar tool">A</div>
                <div class="chat-group-messages" data-activity-lane>
                  <div class="chat-activity-group">Activity</div>
                </div>
              </div>
            </div>
          </div>
          <div class="chat-prs" data-chat-prs>Pull requests</div>
          <div class="agent-chat__composer-shell" data-composer>
            <div class="agent-chat__input">Composer</div>
          </div>
        </section>
      </body></html>`);
      return await page.evaluate(() => {
        const rect = (selector: string) => {
          const bounds = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return { center: bounds.x + bounds.width / 2, width: bounds.width };
        };
        return {
          activity: rect("[data-activity-lane]"),
          composer: rect("[data-composer]"),
          prs: rect("[data-chat-prs]"),
          shell: rect("[data-tool-shell]"),
          thread: rect(".chat-thread-inner"),
          tool: rect("[data-tool-lane]"),
        };
      });
    };

    try {
      const defaults = await renderFixture(false);
      expect(defaults.thread.width).toBeCloseTo(768, 0);
      expect(defaults.composer.width).toBeCloseTo(defaults.thread.width, 0);
      expect(defaults.prs.width).toBeCloseTo(defaults.thread.width, 0);
      expect(defaults.tool.width).toBeCloseTo(defaults.thread.width, 0);
      expect(defaults.shell.width).toBeCloseTo(760, 0);
      expect(defaults.activity.width).toBeCloseTo(760, 0);

      const configured = await renderFixture(true);
      for (const key of ["activity", "shell", "tool"] as const) {
        expect(configured[key].width).toBeCloseTo(configured.thread.width, 0);
      }
      expect(configured.composer.width).toBeCloseTo(configured.prs.width, 0);
      for (const rect of Object.values(configured)) {
        expect(rect.center).toBeCloseTo(configured.thread.center, 0);
      }
      expect(configured.thread.width).toBeGreaterThan(defaults.thread.width);
      expect(configured.composer.width).toBeGreaterThan(defaults.composer.width);
    } finally {
      await closeBrowserPage(page);
    }
  });
  it("keeps wrapped message footers inside measured virtual rows", async () => {
    const page = await openBrowserPage(1366, 900);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" style="width: 220px; height: 400px;">
            <div class="chat-thread-inner chat-thread-inner--virtual" style="width: 220px;">
              <div class="chat-virtual-sizer" style="height: 400px;">
                <div class="chat-virtual-row" data-first-row style="transform: translateY(0px);">
                  <div
                    class="chat-group assistant chat-group--with-footer"
                    style="--chat-message-max-width: 120px;"
                  >
                    <div class="chat-avatar assistant">A</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">A narrow assistant message.</div></div>
                    </div>
                    <div class="chat-group-footer">
                      <div class="chat-group-footer__meta">
                        <span class="chat-sender-name">Assistant</span>
                        <span class="chat-group-timestamp">9:41 PM</span>
                      </div>
                      <div class="chat-group-footer-actions">
                        <button type="button">${iconSvg()}</button>
                        <button type="button">${iconSvg()}</button>
                        <button type="button">${iconSvg()}</button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="chat-virtual-row" data-second-row>
                  <div class="chat-group user"><div class="chat-group-messages">Next row</div></div>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const layout = await page.evaluate(() => {
        const first = document.querySelector<HTMLElement>("[data-first-row]")!;
        const second = document.querySelector<HTMLElement>("[data-second-row]")!;
        const avatar = first.querySelector<HTMLElement>(".chat-avatar")!;
        const bubble = first.querySelector<HTMLElement>(".chat-bubble")!;
        const footer = first.querySelector<HTMLElement>(".chat-group-footer")!;
        second.style.transform = `translateY(${first.getBoundingClientRect().height}px)`;
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        const avatarRect = avatar.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        return {
          avatarBottom: avatarRect.bottom,
          bubbleBottom: bubbleRect.bottom,
          firstBottom: firstRect.bottom,
          footerBottom: footerRect.bottom,
          footerHeight: footerRect.height,
          secondTop: secondRect.top,
        };
      });

      expect(layout.footerHeight).toBeGreaterThan(24);
      expect(layout.bubbleBottom - layout.avatarBottom).toBeCloseTo(4, 0);
      expect(layout.footerBottom).toBeLessThanOrEqual(layout.firstBottom + 1);
      expect(layout.secondTop).toBeGreaterThanOrEqual(layout.firstBottom - 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps attached images within narrow message lanes", async () => {
    const page = await openBrowserPage(320, 568);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div data-image-lane style="width: 180px;">
            <div class="chat-message-images">
              <img
                class="chat-message-image"
                width="600"
                height="100"
                alt="Wide attachment"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='100'%3E%3C/svg%3E"
              />
            </div>
          </div>
        </body></html>`,
      );
      await page.locator(".chat-message-image").waitFor();

      const lane = await getRect(page, "[data-image-lane]");
      const image = await getRect(page, ".chat-message-image");
      expect(image.width).toBeLessThanOrEqual(lane.width + 1);
      expect(image.width / image.height).toBeCloseTo(6, 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("wraps long question and approval metadata inside narrow cards", async () => {
    const page = await openBrowserPage(320, 568);
    try {
      const longToken = `workspace${"x".repeat(240)}session`;
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div data-narrow-card style="width: 220px;">
            <div class="chat-question-panel__heading">
              <span class="chat-question-panel__progress">1/1</span>
              <span class="chat-question-panel__prompt">${longToken}</span>
            </div>
            <div class="exec-approval-meta">
              <div class="exec-approval-meta-row"><span>Session</span><span>${longToken}</span></div>
            </div>
          </div>
        </body></html>`,
      );

      const metrics = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("[data-narrow-card]")!;
        const heading = document.querySelector<HTMLElement>(".chat-question-panel__heading")!;
        const row = document.querySelector<HTMLElement>(".exec-approval-meta-row")!;
        return {
          cardRight: card.getBoundingClientRect().right,
          headingRight: heading.getBoundingClientRect().right,
          promptRight: document
            .querySelector<HTMLElement>(".chat-question-panel__prompt")!
            .getBoundingClientRect().right,
          rowRight: row.getBoundingClientRect().right,
          valueRight: row.lastElementChild!.getBoundingClientRect().right,
        };
      });

      expect(metrics.promptRight).toBeLessThanOrEqual(metrics.headingRight + 1);
      expect(metrics.valueRight).toBeLessThanOrEqual(metrics.rowRight + 1);
      expect(metrics.headingRight).toBeLessThanOrEqual(metrics.cardRight + 1);
      expect(metrics.rowRight).toBeLessThanOrEqual(metrics.cardRight + 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("reserves command text space for flush tool-card actions", async () => {
    const page = await openBrowserPage(320, 568);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-tool-card chat-tool-card--flush" style="width: 220px;">
            <div class="chat-tool-card__actions">
              <button class="chat-tool-card__action-btn" type="button">${iconSvg()}</button>
            </div>
            <div class="chat-tool-term">
              <div class="chat-tool-term__cmd"><span class="chat-tool-term__prompt">$</span><code>command with a long first line</code></div>
            </div>
          </div>
        </body></html>`,
      );

      const layout = await page.evaluate(() => {
        const command = document.querySelector<HTMLElement>(".chat-tool-term__cmd")!;
        const actions = document.querySelector<HTMLElement>(".chat-tool-card__actions")!;
        const commandRect = command.getBoundingClientRect();
        return {
          actionLeft: actions.getBoundingClientRect().left,
          commandContentRight:
            commandRect.right - Number.parseFloat(getComputedStyle(command).paddingRight),
        };
      });

      expect(layout.commandContentRight).toBeLessThanOrEqual(layout.actionLeft + 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it(
    "remeasures a populated composer when the viewport width changes",
    FULL_APP_TEST_OPTIONS,
    async () => {
      if (!realChatServer) {
        throw new Error("Expected the Control UI server to be ready");
      }
      const page = await openBrowserPage(900, 800);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      try {
        await installMockGateway(page);
        await page.goto(`${realChatServer.baseUrl}chat`, {
          waitUntil: "domcontentloaded",
          timeout: APP_FIRST_RENDER_TIMEOUT_MS,
        });
        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        await textarea.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        await textarea.fill(
          "Resize this populated draft across a narrow pane so its wrapped lines change height without waiting for another input event. ".repeat(
            2,
          ),
        );
        await waitForLayoutSettled(page);
        const wideHeight = (await textarea.boundingBox())?.height ?? 0;

        await page.setViewportSize({ width: 430, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height > previousHeight + 1;
        }, wideHeight);
        const narrowHeight = (await textarea.boundingBox())?.height ?? 0;
        expect(narrowHeight).toBeGreaterThan(wideHeight + 1);

        await page.setViewportSize({ width: 900, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height < previousHeight - 1;
        }, narrowHeight);
        expect(pageErrors.filter((message) => message.includes("ResizeObserver loop"))).toEqual([]);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it(
    "reveals, pins, and dismisses message context from the timestamp",
    FULL_APP_TEST_OPTIONS,
    async () => {
      if (!realChatServer) {
        throw new Error("Expected the Control UI server to be ready");
      }
      const page = await openBrowserPage(1366, 900);
      try {
        await installMockGateway(page, {
          assistantName: "Claw",
          historyMessages: [
            {
              content: [{ text: "Context hover regression fixture.", type: "text" }],
              model: "openai/gpt-5.5",
              role: "assistant",
              timestamp: Date.UTC(2026, 6, 5, 9, 51),
              usage: { cacheRead: 2_400, input: 19_600, output: 126 },
            },
          ],
        });
        await page.goto(`${realChatServer.baseUrl}chat`, {
          waitUntil: "domcontentloaded",
          timeout: APP_FIRST_RENDER_TIMEOUT_MS,
        });
        await page
          .getByText("Context hover regression fixture.")
          .waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });

        const details = page.locator("details.msg-meta");
        const context = page.locator(".msg-meta__details");
        const initialLayout = await page.evaluate(() => {
          const footer = document.querySelector<HTMLElement>(".chat-group-footer")!;
          const group = document.querySelector<HTMLElement>(".chat-group")!;
          return {
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: group.getBoundingClientRect().height,
          };
        });
        expect(await context.isVisible()).toBe(false);

        // Travel like a real pointer: the footer overlay is pointer-gated until
        // the group is hovered, so enter through the message body first.
        await page.locator(".chat-text").first().hover();
        await page.locator(".msg-meta__summary").hover();
        // The reveal is state-driven, so the re-render can lag the hover event
        // under CPU contention; poll instead of a one-shot visibility read.
        await context.waitFor({ state: "visible", timeout: 10_000 });
        const hoverLayout = await page.evaluate(() => {
          const footer = document.querySelector<HTMLElement>(".chat-group-footer")!;
          const group = document.querySelector<HTMLElement>(".chat-group")!;
          const summary = document.querySelector<HTMLElement>(".msg-meta__summary")!;
          const detailsOverlay = document.querySelector<HTMLElement>(".msg-meta__details")!;
          return {
            contextBottom: detailsOverlay.getBoundingClientRect().bottom,
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: group.getBoundingClientRect().height,
            summaryTop: summary.getBoundingClientRect().top,
          };
        });
        expect(hoverLayout.footerHeight).toBeCloseTo(initialLayout.footerHeight, 2);
        expect(hoverLayout.groupHeight).toBeCloseTo(initialLayout.groupHeight, 2);
        expect(hoverLayout.contextBottom).toBeLessThanOrEqual(hoverLayout.summaryTop + 4);

        await page.mouse.move(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });

        await page.locator(".chat-text").first().hover();
        await page.locator(".msg-meta__summary").hover();
        // Escape only owns pinned disclosures; it must not corrupt an active
        // hover preview before the click converts that preview into a pin.
        await page.keyboard.press("Escape");
        await page.locator(".msg-meta__summary").click();
        await page.mouse.move(0, 0);
        // Click-to-open must survive the pointer leaving the message group.
        await context.waitFor({ state: "visible", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBe("");

        await page.mouse.click(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBeNull();

        await page.locator(".chat-text").first().hover();
        await page.locator(".msg-meta__summary").click();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        await page.keyboard.press("Escape");
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBeNull();
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it(
    "renders encoded media extensions from assistant output and transcript fields",
    FULL_APP_TEST_OPTIONS,
    async () => {
      if (!realChatServer) {
        throw new Error("Expected the Control UI server to be ready");
      }
      const imageUrl = "https://cdn.example/render%2Epng?download=1";
      const videoUrl = "https://cdn.example/clip%2Emp4?download=1";
      const page = await openBrowserPage(1366, 900);
      try {
        await page.route("https://cdn.example/**", (route) => route.abort());
        await installMockGateway(page, {
          historyMessages: [
            {
              content: `MEDIA:${imageUrl}`,
              role: "assistant",
              timestamp: Date.UTC(2026, 6, 9, 10, 0),
            },
            {
              content: "Encoded transcript video",
              MediaPath: videoUrl,
              role: "user",
              timestamp: Date.UTC(2026, 6, 9, 10, 1),
            },
          ],
        });
        await page.goto(`${realChatServer.baseUrl}chat`, {
          waitUntil: "domcontentloaded",
          timeout: APP_FIRST_RENDER_TIMEOUT_MS,
        });

        const image = page.locator("img.chat-message-image");
        const video = page.locator("video");
        // First wait absorbs the cold-app render; both elements land in the same
        // history render pass, so the video follows immediately after.
        await image.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        await video.waitFor({ timeout: 10_000 });
        expect(await image.getAttribute("src")).toBe(imageUrl);
        expect(await video.getAttribute("src")).toBe(videoUrl);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [393, 852],
    [1366, 900],
  ] as const)(
    "anchors received bubbles left and sent bubbles right at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height);
      try {
        const roles = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
          };
          return {
            assistantLane: rectFor(".chat-group.assistant .chat-group-messages"),
            assistantBubble: rectFor(".chat-group.assistant .chat-bubble:first-child"),
            userLane: rectFor(".chat-group.user .chat-group-messages"),
            userBubble: rectFor(".chat-group.user .chat-bubble:first-child"),
          };
        });

        const assistantLane = expectControlRect(roles.assistantLane, "assistant message lane");
        const assistantBubble = expectControlRect(roles.assistantBubble, "assistant bubble");
        const userLane = expectControlRect(roles.userLane, "user message lane");
        const userBubble = expectControlRect(roles.userBubble, "user bubble");

        expect(Math.abs(assistantBubble.x - assistantLane.x)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(userBubble.x + userBubble.width - (userLane.x + userLane.width)),
        ).toBeLessThanOrEqual(1);
        expect(userLane.x).toBeGreaterThan(assistantLane.x);
        expect(userBubble.width).toBeLessThan(userLane.width);
        expect(assistantBubble.width).toBeLessThan(assistantLane.width);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [1366, 900],
    [1920, 1080],
  ] as const)(
    "centers overflowing direct messages on the composer axis at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height, { direct: true });
      try {
        await page.evaluate(() => {
          const thread = document.querySelector<HTMLElement>(".chat-thread");
          const inner = document.querySelector<HTMLElement>(".chat-thread-inner");
          if (!thread || !inner) {
            throw new Error("Missing chat overflow fixture");
          }
          inner.style.minHeight = `${thread.clientHeight + 1}px`;
        });
        await expectNoHorizontalOverflow(page);
        const [assistantLane, composer, thread, userLane, overflow] = await Promise.all([
          getRect(page, ".chat-group.assistant .chat-group-messages"),
          getRect(page, ".agent-chat__composer-shell"),
          getRect(page, ".chat-thread-inner"),
          getRect(page, ".chat-group.user .chat-group-messages"),
          page.evaluate(() => {
            const node = document.querySelector<HTMLElement>(".chat-thread");
            if (!node) {
              return null;
            }
            return {
              clientHeight: node.clientHeight,
              gutter: getComputedStyle(node).scrollbarGutter,
              scrollHeight: node.scrollHeight,
            };
          }),
        ]);

        expect(overflow).not.toBeNull();
        expect(overflow?.scrollHeight).toBeGreaterThan(overflow?.clientHeight ?? 0);
        expect(overflow?.gutter).toBe("stable both-edges");
        const threadCenter = thread.left + thread.width / 2;
        const composerCenter = composer.left + composer.width / 2;
        expect(Math.abs(threadCenter - composerCenter)).toBeLessThanOrEqual(1);
        expect(Math.abs(thread.width - composer.width)).toBeLessThanOrEqual(1);
        expect(thread.width).toBeCloseTo(768, 0);
        expect(Math.abs(assistantLane.left - thread.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(userLane.right - thread.right)).toBeLessThanOrEqual(1);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [393, 852],
    [1366, 900],
    [1920, 1080],
  ] as const)("uses compact radii and optical chat-box insets at %sx%s", async (width, height) => {
    const page = await openFixture(width, height);
    try {
      const geometry = await page.evaluate(() => {
        const styleFor = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector);
          if (!node) {
            return null;
          }
          const style = getComputedStyle(node);
          return {
            borderRadius: Number.parseFloat(style.borderTopLeftRadius),
            paddingBottom: Number.parseFloat(style.paddingBottom),
            paddingLeft: Number.parseFloat(style.paddingLeft),
            paddingRight: Number.parseFloat(style.paddingRight),
            paddingTop: Number.parseFloat(style.paddingTop),
          };
        };
        return {
          assistantBubble: styleFor(".chat-group.assistant .chat-bubble:first-child"),
          bubble: styleFor(".chat-group.user .chat-bubble:first-child"),
          composer: styleFor(".agent-chat__input"),
          footer: styleFor(".agent-chat__composer-footer"),
          textarea: styleFor(".agent-chat__composer-combobox > textarea"),
        };
      });

      expect(geometry.assistantBubble).not.toBeNull();
      expect(geometry.bubble).not.toBeNull();
      expect(geometry.composer).not.toBeNull();
      expect(geometry.footer).not.toBeNull();
      expect(geometry.textarea).not.toBeNull();

      expect(geometry.bubble?.borderRadius).toBe(10);
      expect(
        new Set([
          geometry.bubble?.paddingTop,
          geometry.bubble?.paddingRight,
          geometry.bubble?.paddingBottom,
          geometry.bubble?.paddingLeft,
        ]),
      ).toEqual(new Set([16]));
      // Assistant replies render flat (no bubble card): zero horizontal inset
      // keeps the text on the tool-row left edge.
      expect(geometry.assistantBubble?.paddingLeft).toBe(0);
      expect(geometry.assistantBubble?.paddingRight).toBe(0);
      expect(geometry.composer?.borderRadius).toBe(10);

      const composerInset = width <= 768 ? 4 : 8;
      const textareaBlockInset = width <= 768 ? 10 : composerInset;
      expect(geometry.textarea?.paddingTop).toBe(textareaBlockInset);
      expect(geometry.textarea?.paddingRight).toBe(composerInset);
      expect(geometry.textarea?.paddingBottom).toBe(textareaBlockInset);
      expect(geometry.textarea?.paddingLeft).toBe(composerInset - 4);
      expect(geometry.footer?.paddingLeft).toBe(composerInset);
      expect(geometry.footer?.paddingRight).toBe(composerInset);
      // #105866 splits the block inset evenly around the footer so the
      // settings chip centers between the divider and the card edge.
      expect(geometry.footer?.paddingTop).toBe(composerInset / 2);
      expect(geometry.footer?.paddingBottom).toBe(composerInset / 2);
    } finally {
      await closeBrowserPage(page);
    }
  });

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
          action: rectFor(".page-meta .btn--icon"),
        };
      });
      const rowY = [
        controls.session?.y,
        controls.agent?.y,
        controls.model?.y,
        controls.action?.y,
      ].filter((value): value is number => typeof value === "number");
      expect(rowY.length).toBe(4);
      expect(Math.max(...rowY) - Math.min(...rowY)).toBeLessThanOrEqual(4);
      const agent = expectControlRect(controls.agent, "agent");
      const session = expectControlRect(controls.session, "session");
      expect(agent.x).toBeLessThan(session.x);
      expect(session.width / agent.width).toBeGreaterThan(1.25);
      expect(session.width / agent.width).toBeLessThan(1.55);
    } finally {
      await closeBrowserPage(page);
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
      await closeBrowserPage(page);
    }
  });

  it.each(VIEWPORTS)("keeps the chat shell inside the viewport at %sx%s", async (width, height) => {
    const page = await openFixture(width, height);
    try {
      await expectNoHorizontalOverflow(page);
      const code = await getBoundingBox(page, ".chat-text pre");
      expect(code.x + code.width).toBeLessThanOrEqual(width + 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [320, 568],
    [1366, 900],
  ] as const)(
    "keeps short assistant footer actions below the bubble at %sx%s",
    async (width, height) => {
      const page = await openBrowserPage(width, height);
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
            <div class="chat-thread" role="log">
              <div class="chat-thread-inner">
                <div class="chat-group assistant chat-group--with-footer">
                  <div class="chat-avatar assistant">A</div>
                  <div class="chat-group-messages">
                    <div class="chat-bubble">
                      <div class="chat-text"><p>Done.</p></div>
                    </div>
                  </div>
                  <div class="chat-group-footer">
                    <div class="chat-group-footer__meta">
                      <span class="chat-sender-name">Assistant</span>
                      <span class="chat-group-timestamp">9:41 PM</span>
                    </div>
                    ${chatFooterActionsHtml()}
                  </div>
                </div>
              </div>
            </div>
          </body></html>`,
        );
        await page.locator(".chat-bubble").hover();

        const text = await getTextContentRect(page, ".chat-text p");
        const actions = await getRect(page, ".chat-group-footer-actions");
        expect(text.bottom).toBeLessThanOrEqual(actions.top - 1);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [320, 568],
    [1366, 900],
  ] as const)("wraps long inline code without clipping at %sx%s", async (width, height) => {
    const page = await openBrowserPage(width, height);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" role="log">
            <div class="chat-thread-inner">
              <div class="chat-group assistant">
                <div class="chat-avatar assistant">A</div>
                <div class="chat-group-messages">
                  <div class="chat-bubble">
                    <div class="chat-text">
                      <p><code>openclaw_message_send_channel_webchat_target_example_com_thread_very_long_identifier_without_spaces_1234567890abcdefghijklmnopqrstuvwxyz</code></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      await expectNoHorizontalOverflow(page);
      const bubble = await getRect(page, ".chat-bubble");
      const inlineCode = await getRect(page, ".chat-text p code");
      expect(inlineCode.right).toBeLessThanOrEqual(bubble.right + 1);
    } finally {
      await closeBrowserPage(page);
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
        const dropdown = await getBoundingBox(page, ".chat-controls-dropdown.open");
        expect(dropdown.x).toBeGreaterThanOrEqual(8);
        expect(dropdown.x + dropdown.width).toBeLessThanOrEqual(312);
        await expectNoHorizontalOverflow(page);
        const mobileControls = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              text: node.textContent?.trim() ?? "",
              display: getComputedStyle(node).display,
            };
          };
          return {
            agent: rectFor('[data-chat-agent-filter="true"]'),
            session: rectFor('[data-chat-session-select="true"]'),
            model: rectFor('[data-chat-model-select="true"]'),
            compactCount: document.querySelectorAll('[data-chat-thinking-select-compact="true"]')
              .length,
          };
        });
        const agent = expectControlRect(mobileControls.agent, "agent");
        const session = expectControlRect(mobileControls.session, "session");
        const model = expectControlRect(mobileControls.model, "model");
        expect(session.y).toBe(agent.y);
        expect(agent.x).toBeLessThan(session.x);
        expect(session.width / agent.width).toBeGreaterThan(1.25);
        expect(session.width / agent.width).toBeLessThan(1.55);
        expect(model.display).not.toBe("none");
        expect(model.text).toBe("gpt-5 · High");
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
        await closeBrowserPage(page);
      }
    },
  );

  it("keeps composer actions touch-sized on phones", async () => {
    const page = await openFixture(320, 568);
    try {
      const sizes = await page.locator(".chat-send-btn").evaluateAll((nodes) =>
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
      const attach = await getRect(page, ".agent-chat__input-btn--attach");
      expect(attach.width).toBeGreaterThanOrEqual(36);
      expect(attach.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("aligns the reasoning default action with the reasoning heading", async () => {
    const page = await openBrowserPage(520, 600);
    try {
      await page.setContent(`
        <!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <div class="chat-controls__reasoning-panel">
              <div class="chat-controls__reasoning-heading">
                <span class="chat-controls__inline-select-section-label">Reasoning</span>
                <button class="chat-controls__reasoning-default">(Default is High)</button>
              </div>
            </div>
          </body>
        </html>
      `);

      const [headingBox, defaultBox] = await Promise.all([
        page.locator(".chat-controls__reasoning-heading > span").boundingBox(),
        page.locator(".chat-controls__reasoning-default").boundingBox(),
      ]);
      expect(headingBox).not.toBeNull();
      expect(defaultBox).not.toBeNull();
      if (!headingBox || !defaultBox) {
        throw new Error("Expected reasoning labels to have layout boxes");
      }
      expect(defaultBox.x).toBeGreaterThanOrEqual(headingBox.x + headingBox.width - 1);
      expect(
        Math.abs(defaultBox.y + defaultBox.height / 2 - (headingBox.y + headingBox.height / 2)),
      ).toBeLessThanOrEqual(2);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps the expanded mobile composer tight, scrollable, and separated from the thread", async () => {
    const page = await openFixture(393, 852);
    try {
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      await textarea.fill(
        Array.from({ length: 8 }, (_value, index) => `Mobile composer line ${index + 1}`).join(
          "\n",
        ),
      );
      await textarea.evaluate((node) => {
        const textareaNode = node as HTMLTextAreaElement;
        textareaNode.style.height = `${textareaNode.scrollHeight}px`;
      });
      await page.waitForTimeout(220);

      const layout = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector(selector) as HTMLElement | null;
          if (!node) {
            return null;
          }
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        };
        const textareaNode = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        const textareaStyle = textareaNode ? getComputedStyle(textareaNode) : null;
        const textareaRect = rectFor(".agent-chat__composer-combobox > textarea");
        return {
          attach: rectFor('.agent-chat__input-btn[aria-label="Add attachment"]'),
          attachIcon: rectFor('.agent-chat__input-btn[aria-label="Add attachment"] svg'),
          input: rectFor(".agent-chat__input"),
          meta: rectFor(".agent-chat__composer-meta"),
          model: rectFor(".chat-composer-model-control"),
          context: rectFor(".context-ring"),
          send: rectFor(".chat-send-btn"),
          settings: rectFor(".chat-view-menu-trigger"),
          settingsIcon: rectFor(".chat-view-menu-trigger svg"),
          shell: rectFor(".agent-chat__composer-shell"),
          textarea:
            textareaNode && textareaRect
              ? {
                  ...textareaRect,
                  clientHeight: textareaNode.clientHeight,
                  lineHeight: Number.parseFloat(textareaStyle?.lineHeight ?? "0"),
                  paddingBottom: Number.parseFloat(textareaStyle?.paddingBottom ?? "0"),
                  paddingTop: Number.parseFloat(textareaStyle?.paddingTop ?? "0"),
                  scrollHeight: textareaNode.scrollHeight,
                }
              : null,
          thread: rectFor(".chat-thread"),
          viewportWidth: window.innerWidth,
        };
      });

      const shell = expectControlRect(layout.shell, "composer shell");
      const input = expectControlRect(layout.input, "composer input");
      const thread = expectControlRect(layout.thread, "chat thread");
      const meta = expectControlRect(layout.meta, "composer metadata");
      const model = expectControlRect(layout.model, "model selector");
      const context = expectControlRect(layout.context, "context control");
      const send = expectControlRect(layout.send, "primary action");
      const settings = expectControlRect(layout.settings, "settings control");
      const attach = expectControlRect(layout.attach, "attachment control");
      const settingsIcon = expectControlRect(layout.settingsIcon, "settings icon");
      const attachIcon = expectControlRect(layout.attachIcon, "attachment icon");
      const textareaRect = expectControlRect(layout.textarea, "composer textarea");
      const textareaMetrics = layout.textarea;
      if (
        textareaMetrics?.clientHeight === undefined ||
        textareaMetrics.scrollHeight === undefined ||
        textareaMetrics.lineHeight === undefined ||
        textareaMetrics.paddingTop === undefined ||
        textareaMetrics.paddingBottom === undefined
      ) {
        throw new Error("Expected textarea sizing metrics");
      }

      const fiveLineHeight =
        textareaMetrics.lineHeight * 5 + textareaMetrics.paddingTop + textareaMetrics.paddingBottom;
      expect(textareaRect.height).toBeLessThanOrEqual(fiveLineHeight + 1);
      expect(textareaMetrics.scrollHeight).toBeGreaterThan(textareaMetrics.clientHeight);
      expect(input.y - (thread.y + thread.height)).toBeGreaterThanOrEqual(5.5);
      expect(shell.x).toBeLessThanOrEqual(8);
      expect(layout.viewportWidth - (shell.x + shell.width)).toBeLessThanOrEqual(8);
      expect(attach.x - input.x).toBeLessThanOrEqual(10);
      expect(model.x).toBeGreaterThanOrEqual(settings.x + settings.width - 1);
      expect(context.x).toBeGreaterThanOrEqual(model.x + model.width - 1);
      expect(input.x + input.width - (send.x + send.width)).toBeLessThanOrEqual(8);
      for (const control of [model, settings, context]) {
        expect(
          Math.abs(control.y + control.height / 2 - (settings.y + settings.height / 2)),
        ).toBeLessThanOrEqual(2);
      }
      expect(meta.y).toBeGreaterThanOrEqual(settings.y - 1);
      expect(settingsIcon.width).toBeGreaterThanOrEqual(18);
      expect(settingsIcon.height).toBeGreaterThanOrEqual(18);
      expect(attachIcon.width).toBeGreaterThanOrEqual(18);
      expect(attachIcon.height).toBeGreaterThanOrEqual(18);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [320, 568],
    [375, 812],
    [667, 375],
    [768, 500],
  ] as const)(
    "keeps the composer model menu inside the mobile viewport at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height);
      try {
        await page.locator('[data-chat-composer-model="true"]').click();
        const menu = await getBoundingBox(page, ".chat-controls__inline-select-menu--combined");
        const reasoning = await getBoundingBox(page, ".chat-controls__reasoning-panel");
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width + 1);
        expect(reasoning.x).toBeGreaterThanOrEqual(0);
        expect(reasoning.x + reasoning.width).toBeLessThanOrEqual(width + 1);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [320, 568],
    [393, 852],
    [568, 320],
    [1366, 900],
    [1920, 1080],
  ] as const)(
    "keeps the composer bottom controls, attachment, and primary action aligned at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height);
      try {
        await expectNoHorizontalOverflow(page);
        // Measure the settled footer row after the context ring's 200ms entrance animation.
        await page.waitForTimeout(220);
        const controls = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              display: getComputedStyle(node).display,
            };
          };
          return {
            chat: rectFor(".card.chat"),
            shell: rectFor(".agent-chat__composer-shell"),
            input: rectFor(".agent-chat__input"),
            thread: rectFor(".chat-thread"),
            footer: rectFor(".agent-chat__composer-footer"),
            textarea: rectFor(".agent-chat__composer-combobox > textarea"),
            meta: rectFor(".agent-chat__composer-meta"),
            model: rectFor(".chat-composer-model-control"),
            context: rectFor(".context-ring"),
            settings: rectFor(".chat-view-menu-trigger"),
            attach: rectFor('.agent-chat__input-btn[aria-label="Add attachment"]'),
            send: rectFor(".chat-send-btn"),
          };
        });

        const chat = expectControlRect(controls.chat, "chat surface");
        const shell = expectControlRect(controls.shell, "composer shell");
        const input = expectControlRect(controls.input, "composer");
        const thread = expectControlRect(controls.thread, "chat thread");
        const footer = expectControlRect(controls.footer, "composer footer");
        const textarea = expectControlRect(controls.textarea, "composer textarea");
        const meta = expectControlRect(controls.meta, "composer metadata");
        const model = expectControlRect(controls.model, "composer model control");
        const context = expectControlRect(controls.context, "composer context control");
        const settings = expectControlRect(controls.settings, "composer settings control");
        const attach = expectControlRect(controls.attach, "composer attach control");
        const send = expectControlRect(controls.send, "composer send control");

        for (const control of [footer, textarea, meta, model, context, settings, attach, send]) {
          expect(control.x).toBeGreaterThanOrEqual(input.x - 1);
          expect(control.x + control.width).toBeLessThanOrEqual(input.x + input.width + 1);
        }
        for (const control of [input, send]) {
          expect(control.x).toBeGreaterThanOrEqual(shell.x - 1);
          expect(control.x + control.width).toBeLessThanOrEqual(shell.x + shell.width + 1);
        }
        expect(model.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(model.y + model.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        expect(settings.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(settings.y + settings.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        expect(model.y).toBeGreaterThanOrEqual(textarea.y);
        expect(context.y).toBeGreaterThanOrEqual(textarea.y);
        expect(
          Math.abs(attach.y + attach.height / 2 - (send.y + send.height / 2)),
        ).toBeLessThanOrEqual(2);
        expect(attach.x + attach.width).toBeLessThanOrEqual(textarea.x + 1);
        expect(model.x).toBeGreaterThanOrEqual(settings.x + settings.width - 1);
        expect(send.x).toBeGreaterThanOrEqual(textarea.x + textarea.width - 1);
        expect(send.x + send.width).toBeLessThanOrEqual(input.x + input.width + 1);
        expect(rectsOverlap(model, settings)).toBe(false);
        expect(rectsOverlap(model, send)).toBe(false);
        expect(rectsOverlap(settings, send)).toBe(false);
        const composerFontSize = await page
          .locator(".agent-chat__composer-combobox > textarea")
          .evaluate((textareaNode) => Number.parseFloat(getComputedStyle(textareaNode).fontSize));
        if (width <= 768) {
          expect(composerFontSize).toBe(16);
          expect(model.width).toBeGreaterThanOrEqual(width === 320 ? 32 : 64);
          expect(model.width).toBeLessThanOrEqual(footer.width);
          expect(send.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(send.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          for (const control of [model, settings, context]) {
            expect(
              Math.abs(control.y + control.height / 2 - (settings.y + settings.height / 2)),
            ).toBeLessThanOrEqual(2);
          }
          expect(footer.height).toBeLessThanOrEqual(49.1);
          expect(settings.width).toBeGreaterThanOrEqual(36);
          expect(settings.height).toBeGreaterThanOrEqual(36);
        } else {
          expect(composerFontSize).toBe(14);
          expect(send.width).toBeCloseTo(36, 2);
          expect(send.height).toBeCloseTo(36, 2);
        }

        if (width >= 1600) {
          expect(shell.width).toBeGreaterThanOrEqual(767);
          expect(shell.width).toBeLessThanOrEqual(769);
          expect(
            Math.abs(shell.x + shell.width / 2 - (chat.x + chat.width / 2)),
          ).toBeLessThanOrEqual(1);
          expect(input.height).toBeLessThanOrEqual(112);
        }

        if (width > height && height <= 500) {
          expect(input.height).toBeLessThanOrEqual(height * 0.38);
          expect(thread.height).toBeGreaterThanOrEqual(height * 0.4 - 1);
          expect(textarea.height).toBeLessThanOrEqual(56.1);
        }
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [320, 568],
    [393, 852],
  ] as const)(
    "insets attachment previews from the composer edge at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height, { composerAttachment: true });
      try {
        await expectNoHorizontalOverflow(page);
        const input = await getBoundingBox(page, ".agent-chat__input");
        const preview = await getBoundingBox(page, ".chat-attachments-preview");
        const attachment = await getBoundingBox(page, ".chat-attachment-thumb");
        const previewPaddingTop = await page
          .locator(".chat-attachments-preview")
          .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingTop));

        expect(attachment.x - input.x).toBeGreaterThanOrEqual(9.5);
        expect(previewPaddingTop).toBe(10);
        expect(preview.x).toBeGreaterThanOrEqual(input.x);
        expect(preview.x + preview.width).toBeLessThanOrEqual(input.x + input.width + 1);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it("stacks the detail sidebar below the thread in a narrow pane", async () => {
    const page = await openBrowserPage(900, 700);
    try {
      // A 620px pane inside a wide viewport: chat-pane sets the stacked class
      // when the pane cannot fit chat + detail panel side by side.
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div style="width: 620px; height: 600px; display: flex;">
            <div class="chat-split-container chat-split-container--open chat-split-container--stacked">
              <div class="chat-main" style="flex: 0 1 60%">
                <div class="chat-thread" role="log">
                  <div class="chat-thread-inner">
                    <div class="chat-group assistant">
                      <div class="chat-avatar assistant">A</div>
                      <div class="chat-group-messages">
                        <div class="chat-bubble"><div class="chat-text">Stacked layout keeps the thread readable.</div></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <section class="chat-sidebar"><div class="sidebar-panel">Detail panel</div></section>
            </div>
          </div>
        </body></html>`,
      );

      await expectNoHorizontalOverflow(page);
      const main = await getRect(page, ".chat-main");
      const sidebar = await getRect(page, ".chat-sidebar");
      expect(sidebar.top).toBeGreaterThanOrEqual(main.bottom - 1);
      expect(Math.abs(sidebar.width - main.width)).toBeLessThanOrEqual(1);
      expect(sidebar.width).toBeGreaterThanOrEqual(618);
      expect(sidebar.height).toBeGreaterThanOrEqual(160);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps crowded task sections independently scrollable in the side rail", async () => {
    const page = await openBrowserPage(1000, 700);
    try {
      const taskRows = Array.from(
        { length: 10 },
        (_, index) => `<div class="chat-tasks-rail__task">Task ${index + 1}</div>`,
      ).join("");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div style="width: 760px; height: 320px; display: flex;">
            <div class="chat-workbench chat-workbench--tasks-open chat-workbench--workspace-collapsed">
              <div class="chat-workbench__main">thread</div>
              <aside class="chat-tasks-rail">
                <div class="chat-tasks-rail__scroll">
                  <section class="chat-tasks-rail__section">
                    <div class="chat-tasks-rail__section-title">Running</div>
                    <div class="chat-tasks-rail__list">${taskRows}</div>
                  </section>
                  <section class="chat-tasks-rail__section">
                    <div class="chat-tasks-rail__section-title">Finished</div>
                    <div class="chat-tasks-rail__list">${taskRows}</div>
                  </section>
                </div>
              </aside>
            </div>
          </div>
        </body></html>`,
      );

      const sections = await page.$$eval(".chat-tasks-rail__section", (nodes) =>
        nodes.map((node) => {
          const section = node as HTMLElement;
          section.scrollTop = 100;
          return {
            clientHeight: section.clientHeight,
            overflowY: getComputedStyle(section).overflowY,
            scrollHeight: section.scrollHeight,
            scrollTop: section.scrollTop,
          };
        }),
      );

      expect(sections).toHaveLength(2);
      for (const section of sections) {
        expect(section.overflowY).toBe("auto");
        expect(section.scrollHeight).toBeGreaterThan(section.clientHeight);
        expect(section.scrollTop).toBeGreaterThan(0);
      }
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("docks the tasks rail as a full-width bottom strip in a narrow pane", async () => {
    const page = await openBrowserPage(1200, 700);
    try {
      // chat-pane sets --tasks-dock-bottom instead of --tasks-open when the
      // pane is too narrow for a side column; the strip spans the pane and
      // sits below the thread, composing with a bottom-docked workspace rail.
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div style="width: 640px; height: 640px; display: flex;">
            <div class="chat-workbench chat-workbench--dock-bottom chat-workbench--tasks-dock-bottom">
              <aside class="chat-workspace-rail">workspace strip</aside>
              <aside class="chat-tasks-rail">
                <div class="chat-tasks-rail__scroll">
                  <section class="chat-tasks-rail__section">Running</section>
                  <section class="chat-tasks-rail__section">Finished</section>
                </div>
              </aside>
              <div class="chat-workbench__main">thread</div>
            </div>
          </div>
        </body></html>`,
      );

      const layout = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector);
          const rect = node?.getBoundingClientRect();
          return rect
            ? {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              }
            : null;
        };
        return {
          workbench: rectFor(".chat-workbench"),
          main: rectFor(".chat-workbench__main"),
          workspace: rectFor(".chat-workspace-rail"),
          tasks: rectFor(".chat-tasks-rail"),
        };
      });

      const workbench = layout.workbench;
      const tasks = layout.tasks;
      const workspace = layout.workspace;
      expect(workbench).not.toBeNull();
      expect(tasks).not.toBeNull();
      expect(workspace).not.toBeNull();
      // Full pane width, below both the thread and the workspace strip.
      expect(Math.abs((tasks?.width ?? 0) - (workbench?.width ?? 0))).toBeLessThanOrEqual(1);
      expect(tasks?.top ?? 0).toBeGreaterThanOrEqual((workspace?.bottom ?? 0) - 1);
      expect(tasks?.top ?? 0).toBeGreaterThanOrEqual((layout.main?.bottom ?? 0) - 1);
      expect(tasks?.height ?? 0).toBeGreaterThanOrEqual(160);
      expect(tasks?.height ?? 0).toBeLessThanOrEqual(237);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps the bottom-docked rail path and summary rows unclipped", async () => {
    const page = await openBrowserPage(760, 700);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-workbench chat-workbench--dock-bottom" style="height: 620px;">
            <div class="chat-workbench__main"></div>
            <aside class="chat-workspace-rail">
              <div class="chat-workspace-rail__header">
                <div class="chat-workspace-rail__title">
                  <span class="chat-workspace-rail__eyebrow">Session</span>
                  <strong>Workspace</strong>
                </div>
              </div>
              <div class="chat-workspace-rail__path">/Users/steipete/.openclaw/workspace</div>
              <div class="chat-workspace-rail__summary">
                <span>0 changed</span><span>0 read</span><span>0 artifacts</span><span>15 shown</span>
              </div>
              <div class="chat-workspace-rail__scroll">
                <section class="chat-workspace-rail__section">
                  <div class="chat-workspace-rail__section-title">Project files</div>
                  ${Array.from(
                    { length: 12 },
                    (_value, index) =>
                      `<div class="chat-workspace-rail__file">notes-file-${index}.md</div>`,
                  ).join("")}
                </section>
              </div>
            </aside>
          </div>
        </body></html>`,
      );

      const rail = await getRect(page, ".chat-workspace-rail");
      const railPath = await getRect(page, ".chat-workspace-rail__path");
      const summary = await getRect(page, ".chat-workspace-rail__summary");
      // The strip is height-bounded; fixed rows must not shrink below their
      // content, only the scroll section gives way.
      expect(rail.height).toBeLessThanOrEqual(237);
      expect(railPath.height).toBeGreaterThanOrEqual(30);
      expect(summary.height).toBeGreaterThanOrEqual(20);
      expect(summary.top).toBeGreaterThanOrEqual(railPath.bottom - 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps short-landscape composer adjunct rows scroll-reachable", async () => {
    const page = await openFixture(568, 320, { composerAttachment: true });
    try {
      await page
        .locator(".agent-chat__composer-combobox > textarea")
        .fill(
          Array.from(
            { length: 10 },
            (_value, index) =>
              `Landscape proof line ${index + 1}: keep transcript visible while this long draft scrolls inside the bounded composer.`,
          ).join("\n"),
        );

      const initial = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector(selector) as HTMLElement | null;
          if (!node) {
            return null;
          }
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            scrollTop: node.scrollTop,
          };
        };
        return {
          input: rectFor(".agent-chat__input"),
          thread: rectFor(".chat-thread"),
          textarea: rectFor(".agent-chat__composer-combobox > textarea"),
        };
      });

      const input = expectControlRect(initial.input, "composer");
      const thread = expectControlRect(initial.thread, "chat thread");
      const textarea = expectControlRect(initial.textarea, "composer textarea");
      expect(input.height).toBeLessThanOrEqual(320 * 0.38);
      expect(thread.height).toBeGreaterThanOrEqual(320 * 0.4 - 1);
      if (
        input.scrollHeight === undefined ||
        input.clientHeight === undefined ||
        textarea.scrollHeight === undefined ||
        textarea.clientHeight === undefined
      ) {
        throw new Error("Expected scroll metrics for short-landscape composer");
      }
      expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
      expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);

      const scrolled = await page.evaluate(() => {
        const composer = document.querySelector(".agent-chat__input") as HTMLElement | null;
        if (composer) {
          composer.scrollTop = composer.scrollHeight;
        }
        const rectFor = (selector: string) => {
          const node = document.querySelector(selector) as HTMLElement | null;
          if (!node) {
            return null;
          }
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        return {
          shell: rectFor(".agent-chat__composer-shell"),
          input: rectFor(".agent-chat__input"),
          meta: rectFor(".agent-chat__composer-meta"),
          model: rectFor(".chat-composer-model-control"),
          settings: rectFor(".chat-view-menu-trigger"),
          send: rectFor(".chat-send-btn"),
        };
      });

      const scrolledShell = expectControlRect(scrolled.shell, "scrolled composer shell");
      const scrolledInput = expectControlRect(scrolled.input, "scrolled composer");
      for (const [label, control] of [
        ["composer metadata", scrolled.meta],
        ["composer model control", scrolled.model],
        ["composer settings control", scrolled.settings],
      ] as const) {
        const rect = expectControlRect(control, label);
        expect(rect.y).toBeGreaterThanOrEqual(scrolledInput.y - 1);
        expect(rect.y + rect.height).toBeLessThanOrEqual(
          scrolledInput.y + scrolledInput.height + 1,
        );
      }
      const send = expectControlRect(scrolled.send, "composer send control");
      expect(send.y).toBeGreaterThanOrEqual(scrolledShell.y - 1);
      expect(send.y + send.height).toBeLessThanOrEqual(scrolledShell.y + scrolledShell.height + 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps short-landscape slash menu visible inside the bounded composer", async () => {
    const page = await openFixture(568, 320, {
      composerAttachment: true,
      slashMenu: true,
    });
    try {
      await page.locator(".agent-chat__composer-combobox > textarea").fill("/review");

      const initial = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector(selector) as HTMLElement | null;
          if (!node) {
            return null;
          }
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            scrollTop: node.scrollTop,
          };
        };
        return {
          input: rectFor(".agent-chat__input"),
          menu: rectFor(".slash-menu"),
          textarea: rectFor(".agent-chat__composer-combobox > textarea"),
          footer: rectFor(".agent-chat__composer-footer"),
        };
      });

      const input = expectControlRect(initial.input, "composer");
      const menu = expectControlRect(initial.menu, "slash menu");
      const textarea = expectControlRect(initial.textarea, "composer textarea");
      expect(input.height).toBeLessThanOrEqual(320 * 0.38);
      if (input.scrollHeight === undefined || input.clientHeight === undefined) {
        throw new Error("Expected scroll metrics for slash-menu composer");
      }
      expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
      expect(menu.y).toBeGreaterThanOrEqual(input.y - 1);
      expect(menu.y + menu.height).toBeLessThanOrEqual(input.y + input.height + 1);
      expect(menu.height).toBeGreaterThanOrEqual(48);
      expect(menu.height).toBeLessThanOrEqual(89);
      expect(textarea.y).toBeGreaterThan(menu.y);

      const scrolled = await page.evaluate(() => {
        const composer = document.querySelector(".agent-chat__input") as HTMLElement | null;
        if (composer) {
          composer.scrollTop = composer.scrollHeight;
        }
        const rectFor = (selector: string) => {
          const node = document.querySelector(selector) as HTMLElement | null;
          if (!node) {
            return null;
          }
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        return {
          input: rectFor(".agent-chat__input"),
          footer: rectFor(".agent-chat__composer-footer"),
        };
      });

      const scrolledInput = expectControlRect(scrolled.input, "scrolled composer");
      const footer = expectControlRect(scrolled.footer, "composer footer");
      expect(footer.y).toBeGreaterThanOrEqual(scrolledInput.y - 1);
      expect(footer.y + footer.height).toBeLessThanOrEqual(
        scrolledInput.y + scrolledInput.height + 1,
      );
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [320, 568],
    [393, 852],
    [568, 320],
  ] as const)(
    "keeps mobile model and settings popovers inside the viewport at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height);
      try {
        const modelTrigger = page.locator('[data-chat-composer-model="true"]');
        await modelTrigger.click();

        const modelMenu = await getRect(page, ".chat-controls__inline-select-menu--combined");
        expect(modelMenu.left).toBeGreaterThanOrEqual(0);
        expect(modelMenu.right).toBeLessThanOrEqual(width);
        expect(modelMenu.top).toBeGreaterThanOrEqual(0);
        expect(modelMenu.bottom).toBeLessThanOrEqual(height);

        await modelTrigger.click();
        await page.locator(".chat-view-menu").evaluate((node) => {
          node.setAttribute("open", "");
        });
        await waitForLayoutSettled(page);

        const settingsMenu = await getRect(page, ".chat-view-menu[open]");
        expect(settingsMenu.left).toBeGreaterThanOrEqual(0);
        expect(settingsMenu.right).toBeLessThanOrEqual(width);
        expect(settingsMenu.top).toBeGreaterThanOrEqual(0);
        expect(settingsMenu.bottom).toBeLessThanOrEqual(height);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [768, 900],
    [1024, 768],
    [1366, 900],
  ] as const)(
    "keeps the left-aligned desktop settings popover inside the viewport at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height);
      try {
        await page.locator(".chat-view-menu").evaluate((node) => {
          node.setAttribute("open", "");
        });
        await waitForLayoutSettled(page);

        const settingsMenu = await getRect(page, ".chat-view-menu[open]");
        expect(settingsMenu.left).toBeGreaterThanOrEqual(0);
        expect(settingsMenu.right).toBeLessThanOrEqual(width);
        expect(settingsMenu.top).toBeGreaterThanOrEqual(0);
        expect(settingsMenu.bottom).toBeLessThanOrEqual(height);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  describe("slash command keyboard navigation", () => {
    let page: Page;

    beforeAll(async () => {
      if (!realChatServer) {
        throw new Error("Expected the Control UI server to be ready");
      }
      page = await openBrowserPage(568, 320);
      await installMockGateway(page, {
        historyMessages: [
          {
            content: [
              {
                text: "Short landscape slash command keyboard regression fixture.",
                type: "text",
              },
            ],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
      });
      await page.goto(`${realChatServer.baseUrl}chat`, {
        waitUntil: "domcontentloaded",
        timeout: APP_FIRST_RENDER_TIMEOUT_MS,
      });
      await page
        .getByText("Short landscape slash command keyboard regression fixture.")
        .waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      await textarea.fill("/");
      await textarea.focus();
    });

    afterAll(async () => {
      await closeBrowserPage(page);
    });

    it("scrolls the keyboard-active slash option into view in short landscape", async () => {
      const initiallyHidden = await page.evaluate(() => {
        const menu = document.querySelector<HTMLElement>(".slash-menu");
        const options = Array.from(
          document.querySelectorAll<HTMLElement>(".slash-menu-item[role='option']"),
        );
        const hiddenOption = options.find((option) => {
          const menuRect = menu?.getBoundingClientRect();
          const optionRect = option.getBoundingClientRect();
          return Boolean(menuRect && optionRect.bottom > menuRect.bottom + 1);
        });
        if (!menu || !hiddenOption) {
          throw new Error("Expected an initially hidden slash option");
        }
        menu.scrollTop = 0;
        const menuRect = menu.getBoundingClientRect();
        const itemRect = hiddenOption.getBoundingClientRect();
        return {
          id: hiddenOption.id,
          index: options.indexOf(hiddenOption),
          visible: itemRect.top >= menuRect.top - 1 && itemRect.bottom <= menuRect.bottom + 1,
        };
      });
      expect(initiallyHidden.visible).toBe(false);

      for (let index = 0; index < initiallyHidden.index; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await page.waitForFunction((expectedId) => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        return input?.getAttribute("aria-activedescendant") === expectedId;
      }, initiallyHidden.id);
      await page.waitForFunction((expectedId) => {
        const active = document.getElementById(expectedId);
        const menu = active?.closest<HTMLElement>(".slash-menu");
        if (!active || !menu) {
          return false;
        }
        const menuRect = menu.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1;
      }, initiallyHidden.id);

      const result = await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        const menu = document.querySelector<HTMLElement>(".slash-menu");
        const active = document.querySelector<HTMLElement>(".slash-menu-item--active");
        if (!input || !menu || !active) {
          throw new Error("Expected active slash option after keyboard navigation");
        }
        const menuRect = menu.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return {
          activeDescendant: input.getAttribute("aria-activedescendant"),
          focusedTag: document.activeElement?.tagName,
          scrollTop: menu.scrollTop,
          visible: activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1,
        };
      });

      expect(result.focusedTag).toBe("TEXTAREA");
      expect(result.activeDescendant).toBe(initiallyHidden.id);
      expect(result.scrollTop).toBeGreaterThan(0);
      expect(result.visible).toBe(true);
    });
  });

  it("uses the compact mobile grid when the agent filter is not rendered", async () => {
    const page = await openFixture(320, 568, { singleAgent: true });
    try {
      await expectNoHorizontalOverflow(page);
      expect(await page.locator('[data-chat-agent-filter="true"]').count()).toBe(0);
      const session = await getBoundingBox(page, '[data-chat-session-select="true"]');
      const model = await getBoundingBox(page, '[data-chat-model-select="true"]');
      expect(model.y).toBeGreaterThan(session.y);
      expect(model.width).toBe(session.width);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [1024, 768],
    [1366, 900],
  ] as const)(
    "scrolls long side-chat conversations instead of expanding the panel at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height, {
        sideChatBody: LONG_SIDE_CHAT_BODY,
      });
      try {
        const panel = await page.locator(".chat-side-chat").evaluate((node) => {
          const element = node as HTMLElement;
          return {
            clientHeight: element.clientHeight,
            position: getComputedStyle(element).position,
          };
        });
        expect(panel.position).toBe("absolute");
        expect(panel.clientHeight).toBeLessThanOrEqual(560);

        const body = await page.locator(".chat-side-chat__scroll").evaluate((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            overflowY: style.overflowY,
            clientHeight: (node as HTMLElement).clientHeight,
            scrollHeight: (node as HTMLElement).scrollHeight,
          };
        });
        expect(body.overflowY).toBe("auto");
        expect(body.clientHeight).toBeLessThan(body.scrollHeight);

        const scrollTop = await page.locator(".chat-side-chat__scroll").evaluate((node) => {
          const element = node as HTMLElement;
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
        expect(scrollTop).toBeGreaterThan(0);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it("renders the side chat as a mobile overlay without horizontal overflow", async () => {
    const page = await openFixture(320, 568, {
      sideChatBody: LONG_SIDE_CHAT_BODY,
    });
    try {
      await expectNoHorizontalOverflow(page);
      const panel = await page.locator(".chat-side-chat").evaluate((node) => {
        const element = node as HTMLElement;
        return {
          clientHeight: element.clientHeight,
          position: getComputedStyle(element).position,
        };
      });
      expect(panel.position).toBe("fixed");
      expect(panel.clientHeight).toBeLessThanOrEqual(380);

      const scroll = await page.locator(".chat-side-chat__scroll").evaluate((node) => {
        const element = node as HTMLElement;
        return {
          overflowY: getComputedStyle(element).overflowY,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        };
      });
      expect(scroll.overflowY).toBe("auto");
      expect(scroll.clientHeight).toBeLessThan(scroll.scrollHeight);

      const scrollTop = await page.locator(".chat-side-chat__scroll").evaluate((node) => {
        const element = node as HTMLElement;
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      });
      expect(scrollTop).toBeGreaterThan(0);
    } finally {
      await closeBrowserPage(page);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
