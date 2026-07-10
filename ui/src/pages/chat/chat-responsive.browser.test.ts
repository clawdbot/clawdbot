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
const LONG_SIDE_RESULT_BODY = Array.from(
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
  sideResultBody?: string;
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
      <button class="btn btn--xs chat-expand-btn" type="button" aria-label="Open in canvas">
        <span class="chat-expand-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>
      <button class="btn btn--xs chat-copy-btn" type="button" aria-label="Copy as markdown">
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
              <select data-chat-session-select="true" aria-label="Chat session"><option>Daily planning</option></select>
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
      <div class="chat-settings-popover-wrapper">
        <button class="chat-settings-chip" type="button" aria-label="Settings">
          <span class="chat-settings-chip__icon">${iconSvg()}</span>
        </button>
        <div class="chat-settings-popover" role="dialog" aria-label="Settings">
          <div class="chat-settings-popover__section">Settings content</div>
        </div>
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
              <select data-chat-session-select="true" aria-label="Chat session"><option>main</option></select>
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

function chatHtml(opts: ChatFixtureOptions = {}) {
  return `
    <div class="shell shell--chat" data-chat-responsive-fixture>
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
            <div class="chat-main">
              <div class="chat-thread" role="log">
                <div class="chat-thread-inner">
                  <div class="chat-group user">
                    <div class="chat-avatar user">V</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">Keep this visible.</div></div>
                    </div>
                  </div>
                  <div class="chat-group assistant">
                    <div class="chat-avatar assistant">A</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">It stays readable.</div></div>
                      <div class="chat-bubble">
                        <div class="chat-text">
                          <p>The chat shell should stay compact and readable.</p>
                          <pre><code>const importantLongIdentifier = "control-ui-chat-responsive-regression-fixture-keeps-code-scrollable"; console.log(importantLongIdentifier);</code></pre>
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
              </div>
            </div>
          </div>
          ${
            opts.sideResultBody !== undefined
              ? `<section class="chat-side-result" role="status" aria-live="polite">
                  <div class="chat-side-result__header">
                    <div class="chat-side-result__label-row"><span class="chat-side-result__label">BTW</span><span class="chat-side-result__meta">Not saved to chat history</span></div>
                    <button class="btn chat-side-result__dismiss">${iconSvg()}</button>
                  </div>
                  <div class="chat-side-result__question">What should I check next?</div>
                  <div class="chat-side-result__body">${opts.sideResultBody}</div>
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
                      <summary class="context-ring" role="status" aria-label="Session context usage: 46k/200k (23%)">
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
                  <div class="agent-chat__composer-progress">
                    <span class="agent-chat__run-status agent-chat__run-status--in-progress">
                      ${iconSvg()}<span class="agent-chat__run-status-label">In progress</span>
                    </span>
                  </div>
                  <span class="agent-chat__token-count">8</span>
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
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts)}</body></html>`,
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

  it("reveals message context on timestamp hover and keeps click-to-open", async () => {
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
      await page.goto(`${realChatServer.baseUrl}chat`);
      await page.getByText("Context hover regression fixture.").waitFor({ timeout: 10_000 });

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

      await page.locator(".msg-meta__summary").hover();
      expect(await context.isVisible()).toBe(true);
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
      expect(await context.isVisible()).toBe(false);

      await page.locator(".msg-meta__summary").click();
      await page.mouse.move(0, 0);
      expect(await details.getAttribute("open")).toBe("");
      expect(await context.isVisible()).toBe(true);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("renders encoded media extensions from assistant output and transcript fields", async () => {
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
      await page.goto(`${realChatServer.baseUrl}chat`);

      const image = page.locator("img.chat-message-image");
      const video = page.locator("video");
      await image.waitFor({ timeout: 10_000 });
      await video.waitFor({ timeout: 10_000 });
      expect(await image.getAttribute("src")).toBe(imageUrl);
      expect(await video.getAttribute("src")).toBe(videoUrl);
    } finally {
      await closeBrowserPage(page);
    }
  });

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
          bubble: styleFor(".chat-group.assistant .chat-bubble:first-child"),
          composer: styleFor(".agent-chat__input"),
          footer: styleFor(".agent-chat__composer-footer"),
          textarea: styleFor(".agent-chat__composer-combobox > textarea"),
        };
      });

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
      expect(geometry.composer?.borderRadius).toBe(10);

      const composerInset = width <= 768 ? 4 : 8;
      const textareaBlockInset = width <= 768 ? 10 : composerInset;
      expect(geometry.textarea?.paddingTop).toBe(textareaBlockInset);
      expect(geometry.textarea?.paddingRight).toBe(composerInset);
      expect(geometry.textarea?.paddingBottom).toBe(textareaBlockInset);
      expect(geometry.textarea?.paddingLeft).toBe(composerInset - 4);
      expect(geometry.footer?.paddingLeft).toBe(composerInset);
      expect(geometry.footer?.paddingRight).toBe(composerInset);
      expect(geometry.footer?.paddingBottom).toBe(composerInset);
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
                <div class="chat-group assistant">
                  <div class="chat-avatar assistant">A</div>
                  <div class="chat-group-messages">
                    <div class="chat-bubble">
                      <div class="chat-text"><p>Done.</p></div>
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
          settings: rectFor(".chat-settings-chip"),
          settingsIcon: rectFor(".chat-settings-chip__icon svg"),
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
            progress: rectFor(".agent-chat__composer-progress"),
            textarea: rectFor(".agent-chat__composer-combobox > textarea"),
            meta: rectFor(".agent-chat__composer-meta"),
            model: rectFor(".chat-composer-model-control"),
            context: rectFor(".context-ring"),
            settings: rectFor(".chat-settings-chip"),
            attach: rectFor('.agent-chat__input-btn[aria-label="Add attachment"]'),
            send: rectFor(".chat-send-btn"),
          };
        });

        const chat = expectControlRect(controls.chat, "chat surface");
        const shell = expectControlRect(controls.shell, "composer shell");
        const input = expectControlRect(controls.input, "composer");
        const thread = expectControlRect(controls.thread, "chat thread");
        const footer = expectControlRect(controls.footer, "composer footer");
        const progress = expectControlRect(controls.progress, "composer progress");
        const textarea = expectControlRect(controls.textarea, "composer textarea");
        const meta = expectControlRect(controls.meta, "composer metadata");
        const model = expectControlRect(controls.model, "composer model control");
        const context = expectControlRect(controls.context, "composer context control");
        const settings = expectControlRect(controls.settings, "composer settings control");
        const attach = expectControlRect(controls.attach, "composer attach control");
        const send = expectControlRect(controls.send, "composer send control");

        for (const control of [
          footer,
          progress,
          textarea,
          meta,
          model,
          context,
          settings,
          attach,
          send,
        ]) {
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
        expect(progress.y).toBeGreaterThanOrEqual(textarea.y);
        expect(
          Math.abs(attach.y + attach.height / 2 - (send.y + send.height / 2)),
        ).toBeLessThanOrEqual(2);
        expect(attach.x + attach.width).toBeLessThanOrEqual(textarea.x + 1);
        expect(model.x).toBeGreaterThanOrEqual(settings.x + settings.width - 1);
        expect(send.x).toBeGreaterThanOrEqual(textarea.x + textarea.width - 1);
        expect(send.x + send.width).toBeLessThanOrEqual(input.x + input.width + 1);
        expect(progress.x).toBeGreaterThanOrEqual(context.x + context.width - 1);
        expect(
          Math.abs(progress.y + progress.height / 2 - (context.y + context.height / 2)),
        ).toBeLessThanOrEqual(2);
        expect(rectsOverlap(progress, context)).toBe(false);
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
          for (const control of [model, settings, context, progress]) {
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
          settings: rectFor(".chat-settings-chip"),
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
        await page.locator(".chat-settings-popover").evaluate((node) => {
          node.classList.add("chat-settings-popover--open");
        });

        const settingsMenu = await getRect(page, ".chat-settings-popover--open");
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
        await page.locator(".chat-settings-popover").evaluate((node) => {
          node.classList.add("chat-settings-popover--open");
        });

        const settingsMenu = await getRect(page, ".chat-settings-popover--open");
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
      await page.goto(`${realChatServer.baseUrl}chat`);
      await page
        .getByText("Short landscape slash command keyboard regression fixture.")
        .waitFor({ timeout: 10_000 });
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
    "scrolls long BTW side result bodies instead of expanding the card at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height, {
        sideResultBody: LONG_SIDE_RESULT_BODY,
      });
      try {
        const body = await page.locator(".chat-side-result__body").evaluate((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            overflowY: style.overflowY,
            clientHeight: (node as HTMLElement).clientHeight,
            scrollHeight: (node as HTMLElement).scrollHeight,
          };
        });
        expect(body.overflowY).toBe("auto");
        expect(body.clientHeight).toBeLessThan(body.scrollHeight);
        expect(body.clientHeight).toBeLessThanOrEqual(480);

        const scrollTop = await page.locator(".chat-side-result__body").evaluate((node) => {
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

  it("renders BTW side results as a mobile overlay without horizontal overflow", async () => {
    const page = await openFixture(320, 568, {
      sideResultBody: LONG_SIDE_RESULT_BODY,
    });
    try {
      await expectNoHorizontalOverflow(page);
      const card = await page.locator(".chat-side-result").evaluate((node) => {
        const element = node as HTMLElement;
        const style = getComputedStyle(element);
        return {
          clientHeight: element.clientHeight,
          overflowY: style.overflowY,
          position: style.position,
          scrollHeight: element.scrollHeight,
        };
      });
      const bodyOverflowY = await page
        .locator(".chat-side-result__body")
        .evaluate((node) => getComputedStyle(node).overflowY);
      expect(card.position).toBe("fixed");
      expect(card.overflowY).toBe("auto");
      expect(card.clientHeight).toBeLessThan(card.scrollHeight);
      expect(bodyOverflowY).toBe("visible");

      const scrollTop = await page.locator(".chat-side-result").evaluate((node) => {
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
