// Control UI tests cover chat responsive behavior.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiMockGatewayScenario,
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
// The shared real-app page still cold-boots Vite's full Control UI graph once;
// under CI contention that first render can starve well past 10s.
const APP_FIRST_RENDER_TIMEOUT_MS = 30_000;
const FULL_APP_TEST_OPTIONS = {
  // Shared-page interactions mutate viewport, pointer, and composer state. Keep
  // each as a sequential barrier so they cannot overlap one another.
  concurrent: false,
  timeout: 60_000,
} as const;
const LONG_SESSION_RAIL_BODY = Array.from(
  { length: 80 },
  (_, index) => `<p>Line ${index + 1}: keep the complete side result readable.</p>`,
).join("");
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

let sharedBrowser: Browser | null = null;
let sharedLayoutContext: BrowserContext | null = null;
let sharedAppPage: Page | null = null;
let sharedAppPagePromise: Promise<Page> | null = null;
const sharedAppPageErrors: string[] = [];
let realChatServer: ControlUiE2eServer | null = null;
let cachedUiCss: string | null = null;

const SHARED_APP_CONTEXT_TEXT = "Context hover regression fixture.";
const SHARED_APP_SLASH_TEXT = "Short landscape slash command keyboard regression fixture.";
const SHARED_APP_IMAGE_URL = "https://cdn.example/render%2Epng?download=1";
const SHARED_APP_VIDEO_URL = "https://cdn.example/clip%2Emp4?download=1";

function installResponsiveChatGateway(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installMockGateway(page, {
    agentModel: "openai/gpt-5.5",
    ...scenario,
  });
}

async function getSharedAppPage(): Promise<Page> {
  sharedAppPagePromise ??= createSharedAppPage();
  return await sharedAppPagePromise;
}

async function createSharedAppPage(): Promise<Page> {
  if (!realChatServer) {
    throw new Error("Expected the Control UI server to be ready");
  }
  // The five app assertions use disjoint fixture messages and reset mutable
  // page state, so one lazy boot preserves coverage without five graph loads.
  const page = await openBrowserPage(1366, 900, { isolated: true });
  try {
    page.on("pageerror", (error) => sharedAppPageErrors.push(error.message));
    await page.route("https://cdn.example/**", (route) => route.abort());
    await installResponsiveChatGateway(page, {
      assistantName: "Claw",
      historyMessages: [
        {
          content: [{ text: SHARED_APP_CONTEXT_TEXT, type: "text" }],
          model: "openai/gpt-5.5",
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 5, 9, 51),
          usage: { cacheRead: 2_400, input: 19_600, output: 126 },
        },
        {
          content: `MEDIA:${SHARED_APP_IMAGE_URL}`,
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 0),
        },
        {
          content: "Encoded transcript video",
          __openclaw: { media: [{ url: SHARED_APP_VIDEO_URL, contentType: "video/mp4" }] },
          role: "user",
          timestamp: Date.UTC(2026, 6, 9, 10, 1),
        },
        {
          content: [{ text: SHARED_APP_SLASH_TEXT, type: "text" }],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 2),
        },
      ],
    });
    await page.goto(`${realChatServer.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: APP_FIRST_RENDER_TIMEOUT_MS,
    });
    await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
    sharedAppPage = page;
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

type ControlRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  clientWidth?: number;
  scrollWidth?: number;
  clientHeight?: number;
  scrollHeight?: number;
  scrollTop?: number;
  text?: string;
  display?: string;
};

type ChatFixtureOptions = {
  composerAttachment?: boolean;
  crowdedComposerFooter?: boolean;
  direct?: boolean;
  sessionRailBody?: string;
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

/**
 * Corner radii are expressed as their base step times the live corner scale,
 * so these expectations stay true on engines that draw continuous curvature
 * (`--openclaw-corner-radius-scale: 1.25`) and on engines that do not.
 */
async function readCornerScale(page: Page): Promise<number> {
  return await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--openclaw-corner-radius-scale"),
    ),
  );
}

function expectControlRect(rect: ControlRect | null, label: string): ControlRect {
  if (rect === null) {
    throw new Error(`Expected ${label} control rect`);
  }
  expectFiniteRect(rect);
  return rect;
}

function readUiCss(): string {
  if (cachedUiCss !== null) {
    return cachedUiCss;
  }
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
  cachedUiCss = files.map((file) => readStyleSheet(file)).join("\n");
  return cachedUiCss;
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
              <button class="chat-activity-group__summary" type="button">
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
                    <button class="chat-tool-msg-summary" data-failed-call-row type="button">
                      <span class="chat-tool-msg-summary__icon">${iconSvg()}</span>
                      <span class="chat-tool-msg-summary__label">Bash</span>
                      <span class="chat-tool-msg-summary__names">Bash</span>
                      <span class="chat-tool-row__badge">failed</span>
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

function composerControlsHtml(crowded = false) {
  return `
    <div class="agent-chat__composer-controls">
      ${
        crowded
          ? `<div class="agent-chat__composer-run-status">
          <span class="agent-chat__run-status agent-chat__run-status--interrupted">
            ${iconSvg()}<span class="agent-chat__run-status-label">Interrupted</span>
          </span>
        </div>
        <span class="agent-chat__session-overrides-pill">
          <button class="agent-chat__session-overrides-open" type="button">4 session overrides</button>
          <button class="agent-chat__session-overrides-clear" type="button" aria-label="Clear session overrides">${iconSvg()}</button>
        </span>`
          : ""
      }
      <div class="chat-composer-model-control">
        <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
          <details class="chat-controls__inline-select chat-controls__model-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__model-trigger" data-chat-composer-model="true" aria-label="Chat model">
            <span class="chat-controls__inline-select-label">GPT-5.6 Luna</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__model-menu">
            <div class="chat-controls__model-search-wrap"><input class="chat-controls__model-search" placeholder="Search models" /></div>
            <div class="chat-controls__model-options">
              <button class="chat-controls__inline-select-option chat-controls__model-option chat-controls__inline-select-option--selected">Default model</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">gpt-5.5</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">claude-sonnet-4-6</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">gpt-5.6-luna</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">gpt-5.6-sol</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">openrouter/auto</button>
            </div>
          </div>
          </details>
          <details class="chat-controls__inline-select chat-controls__effort-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__effort-trigger" data-chat-composer-effort="true" aria-label="Effort">
            <span class="chat-controls__inline-select-label">High</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__effort-menu">
            <div class="chat-controls__reasoning-panel">Effort</div>
          </div>
          </details>
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
                opts.sessionRailBody !== undefined
                  ? `<openclaw-chat-session-rail>
                    <section class="chat-session-rail chat-session-rail--expanded" role="region" aria-label="Session companion">
                      <header class="chat-session-rail__header">
                        <div class="chat-session-rail__header-copy">
                          <strong class="chat-session-rail__headline">Reviewing the session</strong>
                        </div>
                      </header>
                      <div class="chat-session-rail__thread">
                        <article class="chat-session-rail__exchange">
                          <div class="chat-session-rail__question">What should I check next?</div>
                          <div class="chat-session-rail__answer">${opts.sessionRailBody}</div>
                          <span class="chat-session-rail__pr-checks">2 passed</span>
                          <time class="chat-session-rail__timestamp">as of 4:12 PM</time>
                          <div class="chat-session-rail__hint">The companion is already answering a question.</div>
                        </article>
                      </div>
                      <footer class="chat-session-rail__composer">
                        <label class="chat-session-rail__prompt">
                          <input class="chat-session-rail__input" type="text" placeholder="What should I know?" />
                        </label>
                        <button class="chat-send-btn">${iconSvg()}</button>
                      </footer>
                    </section>
                  </openclaw-chat-session-rail>`
                  : ""
              }
              ${
                opts.crowdedComposerFooter
                  ? `<div class="agent-chat__typing-indicator agent-chat__typing-indicator--outside" role="status">
                    <span class="agent-chat__typing-avatars" aria-hidden="true">
                      <span class="chat-author-avatar">A</span>
                      <span class="chat-author-avatar">B</span>
                      <span class="chat-author-avatar">C</span>
                    </span>
                    <span class="agent-chat__typing-text">Alexandria, Bartholomew, and Cassandra are typing</span>
                  </div>`
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
                    ${composerControlsHtml(opts.crowdedComposerFooter)}
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
                                  <span class="context-usage__limit-label">Weekly</span>
                                  <span class="context-usage__limit-meta"><strong>72%</strong></span>
                                </div>
                                <div class="context-usage__limit-bar"><span style="width: 72%"></span></div>
                              </div>
                            </div>
                          </section>
                        </details>
                      </div>
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

async function syncFixtureComposerPopoverAnchor(page: Page) {
  await page.locator(".agent-chat__input").evaluate((node) => {
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const layoutViewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const composerTop = node.getBoundingClientRect().top;
    node.style.setProperty(
      "--chat-composer-popover-bottom",
      `${layoutViewportHeight - composerTop + 6}px`,
    );
    node.style.setProperty(
      "--chat-composer-popover-max-height",
      `${Math.max(0, composerTop - viewportTop - 28)}px`,
    );
  });
}

async function openFixture(width: number, height: number, opts: ChatFixtureOptions = {}) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts, width <= 1100)}</body></html>`,
    );
    await syncFixtureComposerPopoverAnchor(page);
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function openBrowserPage(
  width: number,
  height: number,
  options: { isolated?: boolean } = {},
): Promise<Page> {
  sharedBrowser ??= await chromium.launch({
    executablePath: chromiumExecutablePath,
    headless: true,
  });
  if (options.isolated) {
    return await sharedBrowser.newPage({ viewport: { width, height } });
  }
  // Static setContent fixtures do not mutate context-owned storage or routes,
  // so they can share one context while their pages remain concurrent.
  sharedLayoutContext ??= await sharedBrowser.newContext();
  const page = await sharedLayoutContext.newPage();
  await page.setViewportSize({ width, height });
  return page;
}

async function closeBrowserPage(page: Page): Promise<void> {
  await page.close().catch(() => {});
}

async function waitForLayoutSettled(page: Page, selector: string): Promise<void> {
  // content-visibility and container queries can defer descendant layout beyond
  // a fixed rAF pair. Measure the owning geometry until two frames agree.
  await page.evaluate(
    async ({ maxFrames, selector: targetSelector }) => {
      let previousGeometry: string | undefined;
      let stableFrames = 0;
      for (let frame = 0; frame < maxFrames; frame += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        const elements = [...document.querySelectorAll<HTMLElement>(targetSelector)];
        if (elements.length === 0) {
          throw new Error(`No layout elements matched ${targetSelector}`);
        }
        const geometry = JSON.stringify(
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
        );
        stableFrames = geometry === previousGeometry ? stableFrames + 1 : 1;
        if (stableFrames >= 2) {
          return;
        }
        previousGeometry = geometry;
      }
      throw new Error(`Layout did not stabilize for ${targetSelector} within ${maxFrames} frames`);
    },
    { maxFrames: 60, selector },
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
    sharedLayoutContext = await sharedBrowser.newContext();
    realChatServer = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await sharedAppPage?.close();
    sharedAppPage = null;
    sharedAppPagePromise = null;
    await realChatServer?.close();
    realChatServer = null;
    await sharedLayoutContext?.close();
    sharedLayoutContext = null;
    await sharedBrowser?.close();
    sharedBrowser = null;
  });

  it("keeps transcript search icons compact", async () => {
    const page = await openBrowserPage(1024, 768);
    try {
      await page.setContent(`<!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <section class="card chat">
              <div class="agent-chat__search-bar">
                ${iconSvg()}
                <input type="text" placeholder="Search messages" />
                <button class="btn btn--ghost" type="button">${iconSvg()}</button>
              </div>
            </section>
          </body>
        </html>`);

      const searchBar = await getBoundingBox(page, ".agent-chat__search-bar");
      const icons = await page.locator(".agent-chat__search-bar svg").all();
      const input = page.locator(".agent-chat__search-bar input");
      const cornerRadii = await page.locator(".chat").evaluate((chat) => {
        const search = chat.querySelector<HTMLElement>(".agent-chat__search-bar");
        if (!search) {
          throw new Error("Expected transcript search bar");
        }
        const radii = (element: Element) => {
          const style = getComputedStyle(element);
          return [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ];
        };
        return { chat: radii(chat), search: radii(search) };
      });

      const searchRadius = `${14 * (await readCornerScale(page))}px`;
      expect(searchBar.height).toBeLessThan(64);
      expect(cornerRadii).toEqual({
        chat: ["0px", "0px", "0px", "0px"],
        search: ["0px", "0px", searchRadius, searchRadius],
      });
      expect(icons).toHaveLength(2);
      for (const icon of icons) {
        const box = await icon.boundingBox();
        expect(box?.width).toBeCloseTo(16, 3);
        expect(box?.height).toBeCloseTo(16, 3);
      }
      await input.focus();
      const outline = await input.evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth };
      });
      expect(outline).toEqual({ style: "solid", width: "2px" });
    } finally {
      await closeBrowserPage(page);
    }
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

  it("keeps the native gateway picker as compact as sidebar menus", async () => {
    const page = await openBrowserPage(800, 600);
    try {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <wa-dropdown class="chat-pane__gateway-menu">
            <template shadowrootmode="open"><div part="menu">Gateways<slot></slot></div></template>
            <wa-dropdown-item class="chat-pane__gateway-menu-item">Local Gateway</wa-dropdown-item>
          </wa-dropdown>
        </body></html>`,
      );

      const readGatewayMenuStyles = () =>
        page.evaluate(() => {
          const dropdown = document.querySelector<HTMLElement>(".chat-pane__gateway-menu")!;
          const menu = dropdown.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;
          const item = dropdown.querySelector<HTMLElement>(".chat-pane__gateway-menu-item")!;
          const menuStyle = getComputedStyle(menu);
          const itemStyle = getComputedStyle(item);
          return {
            menu: {
              borderRadius: menuStyle.borderRadius,
              padding: menuStyle.padding,
            },
            item: {
              borderRadius: itemStyle.borderRadius,
              fontSize: itemStyle.fontSize,
              minHeight: itemStyle.minHeight,
              padding: itemStyle.padding,
            },
          };
        });

      const styles = await readGatewayMenuStyles();
      const menuRadius = 10 * (await readCornerScale(page));

      expect(styles).toEqual({
        menu: { borderRadius: `${menuRadius}px`, padding: "4px" },
        item: {
          // Item radius plus the 4px menu padding equals the panel radius, so
          // the item edge stays optically parallel to the menu edge.
          borderRadius: `${menuRadius - 4}px`,
          fontSize: "13px",
          minHeight: "28px",
          padding: "0px 8px",
        },
      });

      const session = await page.context().newCDPSession(page);
      try {
        await session.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 1,
        });
        await session.send("Emulation.setEmulatedMedia", {
          media: "screen",
          features: [{ name: "pointer", value: "coarse" }],
        });
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        expect((await readGatewayMenuStyles()).item.minHeight).toBe("44px");
      } finally {
        await session.detach();
      }
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("insets the collapsed session rail from the pane header edge", async () => {
    const page = await openBrowserPage(922, 282);
    try {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 922px; height: 282px;">
            <div class="chat-pane__header">Current session</div>
            <div class="chat-split-view__pane">
              <div class="chat-main" style="height: 100%;">
                <div class="chat-session-rail chat-session-rail--pill">
                  <span class="chat-session-rail__status" data-health="on-track">On track</span>
                  <span class="chat-session-rail__headline">Investigating repository guidance</span>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const header = await getBoundingBox(page, ".chat-pane__header");
      const observer = await getBoundingBox(page, ".chat-session-rail");

      expect(observer.y).toBeCloseTo(header.y + header.height + 12, 0);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps the split-pane close button reachable as the pane narrows", async () => {
    const page = await openBrowserPage(1100, 240);
    try {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      const boardCss = readStyleSheet("ui/src/styles/chat/board.css");
      const settingsCss = readStyleSheet("ui/src/styles/settings.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${settingsCss}\n${splitViewCss}\n${boardCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 320px;">
            <div class="chat-pane__header">
              <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle" type="button">N</button>
              <span class="chat-pane__session-title"
                ><span class="chat-pane__session-title-text"
                  >A deliberately long split-pane session title</span
                ></span
              >
              <openclaw-session-owner-chip>
                <span class="session-owner-chip session-owner-chip--header">O</span>
              </openclaw-session-owner-chip>
              <button class="chat-pane__workspace-chip" type="button">
                ${iconSvg()}<span>openclaw-workspace</span>
              </button>
              <div class="chat-pane__face-switch chat-pane__face-switch--split">
                <div class="settings-segmented">
                  <button class="settings-segmented__btn" type="button">Chat</button>
                  <button class="settings-segmented__btn settings-segmented__btn--active" type="button">Split</button>
                  <button class="settings-segmented__btn" type="button">Dashboard</button>
                </div>
                <wa-dropdown class="chat-pane__dock-caret">
                  <button
                    slot="trigger"
                    class="btn btn--ghost btn--icon chat-icon-btn chat-pane__dock-caret-trigger"
                    type="button"
                  >B</button>
                </wa-dropdown>
              </div>
              <wa-dropdown class="chat-pane__sharing-menu">
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__sharing-trigger" type="button">S</button>
              </wa-dropdown>
              <wa-dropdown class="chat-pane__branches-menu">
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger" type="button">R</button>
              </wa-dropdown>
              <wa-dropdown class="chat-pane__gateway-menu">
                <button class="chat-pane__gateway-chip" type="button">
                  <span class="chat-pane__gateway-health"></span>
                  <span class="chat-pane__gateway-name">A long native gateway name</span>
                </button>
              </wa-dropdown>
              <div class="chat-pane__actions">
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-side-panel-toggle" type="button">L</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-down" type="button">V</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-right" type="button">H</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__close-pane" type="button">X</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__palette-open" type="button">P</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const selectors = [
        "openclaw-session-owner-chip",
        ".chat-side-panel-toggle",
        ".chat-pane__dock-caret",
        ".chat-pane__sharing-menu",
        ".chat-pane__branches-menu",
        ".chat-pane__gateway-menu",
        ".chat-pane__nav-toggle",
        ".chat-pane__palette-open",
        ".chat-pane__split-down",
        ".chat-pane__split-right",
      ];
      const displayValues = async () =>
        await page
          .locator(selectors.join(","))
          .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).display));
      const setHeaderContentWidth = async (contentWidth: number) => {
        await page.locator(".chat-split-view__cell").evaluate((cell, width) => {
          const header = cell.querySelector<HTMLElement>(".chat-pane__header")!;
          const style = getComputedStyle(header);
          const horizontalInsets =
            Number.parseFloat(style.paddingLeft) +
            Number.parseFloat(style.paddingRight) +
            Number.parseFloat(style.borderLeftWidth) +
            Number.parseFloat(style.borderRightWidth);
          (cell as HTMLElement).style.width = `${width + horizontalInsets}px`;
        }, contentWidth);
      };

      const header = await getBoundingBox(page, ".chat-pane__header");
      const close = await getBoundingBox(page, ".chat-pane__close-pane");
      expect(close.x + close.width).toBeLessThanOrEqual(header.x + header.width);
      expect(await displayValues()).toEqual(selectors.map(() => "none"));

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "580px";
      });
      await waitForLayoutSettled(page, ".chat-pane__header, .chat-pane__close-pane");
      const intermediateHeader = await getBoundingBox(page, ".chat-pane__header");
      const intermediateClose = await getBoundingBox(page, ".chat-pane__close-pane");
      expect(intermediateClose.x + intermediateClose.width).toBeLessThanOrEqual(
        intermediateHeader.x + intermediateHeader.width,
      );
      expect(await displayValues()).toEqual(selectors.map(() => "none"));
      const intermediateOverflow = await page.locator(".chat-pane__header").evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(intermediateOverflow.scrollWidth).toBeLessThanOrEqual(
        intermediateOverflow.clientWidth,
      );

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "1000px";
      });
      await waitForLayoutSettled(page, ".chat-pane__header, .chat-pane__close-pane");
      const fullCompositionWidth = await page.locator(".chat-pane__header").evaluate((element) => {
        const headerElement = element as HTMLElement;
        headerElement.style.containerType = "normal";
        headerElement.style.width = "0px";
        const width = headerElement.scrollWidth;
        headerElement.style.removeProperty("width");
        headerElement.style.removeProperty("container-type");
        return width;
      });
      await setHeaderContentWidth(801);
      await waitForLayoutSettled(page, ".chat-pane__header, .chat-pane__close-pane");
      const transitionOverflow = await page.locator(".chat-pane__header").evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      const transitionHeader = await getBoundingBox(page, ".chat-pane__header");
      const transitionClose = await getBoundingBox(page, ".chat-pane__close-pane");
      expect(transitionClose.x + transitionClose.width).toBeLessThanOrEqual(
        transitionHeader.x + transitionHeader.width,
      );
      expect(await displayValues()).not.toContain("none");
      expect(transitionOverflow.scrollWidth).toBeLessThanOrEqual(transitionOverflow.clientWidth);
      expect(transitionOverflow.clientWidth - fullCompositionWidth).toBeGreaterThanOrEqual(8);

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "1000px";
      });
      expect(await displayValues()).not.toContain("none");
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("caps a nested session trail at half the header while ellipsizing both titles", async () => {
    const page = await openBrowserPage(720, 180);
    try {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 640px;">
            <div class="chat-pane__header">
              <div class="chat-pane__crumbs">
                <wa-dropdown class="chat-pane__workspace-menu">
                  <button class="chat-pane__workspace-chip" type="button">
                    ${iconSvg()}<span>openclaw</span>
                  </button>
                </wa-dropdown>
                <span class="chat-pane__crumb-sep" aria-hidden="true">/</span>
                <button class="chat-pane__parent-session" type="button">
                  <span class="chat-pane__parent-session-text">Release preparation with a long parent name</span>
                </button>
                <span class="chat-pane__crumb-sep" aria-hidden="true">/</span>
                <button class="chat-pane__session-title chat-pane__session-title-button" type="button">
                  <span class="chat-pane__session-title-text">Implementation details with a long child name</span>
                </button>
              </div>
              <div class="chat-pane__actions">
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__close-pane" type="button">X</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const readState = () =>
        page.locator(".chat-pane__header").evaluate((header) => {
          const separators = [...header.querySelectorAll<HTMLElement>(".chat-pane__crumb-sep")];
          const parentText = header.querySelector<HTMLElement>(".chat-pane__parent-session-text")!;
          const childText = header.querySelector<HTMLElement>(".chat-pane__session-title-text")!;
          const parent = header.querySelector<HTMLElement>(".chat-pane__parent-session")!;
          const child = header.querySelector<HTMLElement>(".chat-pane__session-title")!;
          const headerRect = header.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          const childRect = child.getBoundingClientRect();
          return {
            firstSeparator: getComputedStyle(separators[0]!).display,
            secondSeparator: getComputedStyle(separators[1]!).display,
            parentEllipses: parentText.scrollWidth > parentText.clientWidth,
            childEllipses: childText.scrollWidth > childText.clientWidth,
            headerWidth: headerRect.width,
            nestedTrailWidth: childRect.right - parentRect.left,
            overflow: (header as HTMLElement).scrollWidth - (header as HTMLElement).clientWidth,
          };
        });

      const normal = await readState();
      expect(normal).toMatchObject({
        firstSeparator: "block",
        secondSeparator: "block",
        parentEllipses: true,
        childEllipses: true,
        overflow: 0,
      });
      expect(normal.nestedTrailWidth).toBeLessThanOrEqual(normal.headerWidth / 2 + 1);

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "320px";
      });
      const narrow = await readState();
      expect(narrow).toMatchObject({
        firstSeparator: "none",
        secondSeparator: "block",
        parentEllipses: true,
        childEllipses: true,
        overflow: 0,
      });
      expect(narrow.nestedTrailWidth).toBeLessThanOrEqual(narrow.headerWidth / 2 + 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps a Done status disjoint from a long compact session headline", async () => {
    const page = await openBrowserPage(320, 240);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-session-rail chat-session-rail--pill" style="width: 190px">
            <span class="chat-session-rail__status" data-health="done">Done</span>
            <button class="chat-session-rail__expand" type="button">
              <span class="chat-session-rail__headline">A deliberately long completed-session headline</span>
            </button>
            <button class="chat-session-rail__hide" type="button">Hide</button>
          </div>
        </body></html>`,
      );

      const status = await getBoundingBox(page, ".chat-session-rail__status");
      const headline = await getBoundingBox(page, ".chat-session-rail__headline");
      const expand = await getBoundingBox(page, ".chat-session-rail__expand");

      expect(status.x + status.width).toBeLessThanOrEqual(headline.x);
      expect(headline.x + headline.width).toBeLessThanOrEqual(expand.x + expand.width);
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
      const failedSummary = await getRect(page, "[data-failed-call-row]");
      expect(Math.abs(callRow.right - failedSummary.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(callRow.height - failedSummary.height)).toBeLessThanOrEqual(1);
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

  it("insets only the bundled logo inside the unchanged avatar box", async () => {
    const page = await openBrowserPage(430, 720);
    try {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <img class="chat-avatar assistant chat-avatar--logo" src="/apple-touch-icon.png" alt="Logo" />
        <img class="chat-avatar assistant" src="/avatar/main" alt="Custom" />
        <img class="chat-avatar user" src="/avatar/user" alt="User" />
      </body></html>`);

      const avatars = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".chat-avatar")].map((avatar) => {
          const style = getComputedStyle(avatar);
          const bounds = avatar.getBoundingClientRect();
          return {
            width: bounds.width,
            height: bounds.height,
            boxSizing: style.boxSizing,
            objectFit: style.objectFit,
            padding: style.padding,
            borderWidth: style.borderTopWidth,
          };
        }),
      );

      expect(avatars).toEqual([
        {
          width: 36,
          height: 36,
          boxSizing: "border-box",
          objectFit: "contain",
          padding: "2px",
          borderWidth: "1px",
        },
        {
          width: 36,
          height: 36,
          boxSizing: "border-box",
          objectFit: "cover",
          padding: "0px",
          borderWidth: "1px",
        },
        {
          width: 36,
          height: 36,
          boxSizing: "border-box",
          objectFit: "cover",
          padding: "0px",
          borderWidth: "1px",
        },
      ]);
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

  it("gives inline MCP Apps the full assistant message column", async () => {
    const page = await openBrowserPage(1366, 900);
    try {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="chat-thread chat-thread--direct" role="log">
          <div class="chat-thread-inner">
            <div class="chat-group assistant chat-group--with-footer">
              <div class="chat-group-messages">
                <div class="chat-bubble">
                  <div class="chat-tool-card__preview" data-content-kind="mcp-app">
                    <div class="chat-tool-card__preview-panel">
                      <mcp-app-view style="display:block;width:100%;height:320px"></mcp-app-view>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </body></html>`);

      await expectNoHorizontalOverflow(page);
      const widths = await page.evaluate(() => ({
        app: document.querySelector("mcp-app-view")!.getBoundingClientRect().width,
        bubble: document.querySelector<HTMLElement>(".chat-bubble")!.getBoundingClientRect().width,
        messages: document
          .querySelector<HTMLElement>(".chat-group-messages")!
          .getBoundingClientRect().width,
      }));
      expect(widths.bubble).toBeCloseTo(widths.messages, 0);
      expect(widths.app).toBeGreaterThan(600);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps inline MCP App reloads transparent without changing dashboard surfaces", async () => {
    const page = await openBrowserPage(1366, 900);
    try {
      if (!realChatServer) {
        throw new Error("Expected the Control UI server to be ready");
      }
      await page.goto(realChatServer.baseUrl, { waitUntil: "domcontentloaded" });
      await page.addScriptTag({
        type: "module",
        url: new URL("src/components/mcp-app-view-registration.ts", realChatServer.baseUrl).href,
      });
      const backgrounds = await page.evaluate(async () => {
        await customElements.whenDefined("mcp-app-view");
        const readFrameBackground = async (boardSurface?: string) => {
          const owner = document.createElement("div");
          if (boardSurface) {
            owner.style.setProperty("--board-surface", boardSurface);
          }
          const view = document.createElement("mcp-app-view") as HTMLElement & {
            updateComplete: Promise<boolean>;
          };
          owner.append(view);
          document.body.replaceChildren(owner);
          await view.updateComplete;
          const mount = view.shadowRoot?.querySelector(".mount");
          if (!mount) {
            throw new Error("MCP App mount is missing");
          }
          const frame = document.createElement("iframe");
          mount.append(frame);
          return getComputedStyle(frame).backgroundColor;
        };
        return {
          dashboard: await readFrameBackground("rgb(12, 34, 56)"),
          inline: await readFrameBackground(),
        };
      });

      expect(backgrounds.dashboard).toBe("rgb(12, 34, 56)");
      expect(backgrounds.inline).toBe("rgba(0, 0, 0, 0)");
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
      await waitForLayoutSettled(page, "[data-first-row], .chat-group-footer");

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
      const page = await getSharedAppPage();
      const errorStart = sharedAppPageErrors.length;
      try {
        await page.setViewportSize({ width: 900, height: 800 });
        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        await textarea.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        await textarea.fill(
          "Resize this populated draft across a narrow pane so its wrapped lines change height without waiting for another input event. ".repeat(
            2,
          ),
        );
        await waitForLayoutSettled(page, ".agent-chat__composer-combobox > textarea");
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
        expect(
          sharedAppPageErrors
            .slice(errorStart)
            .filter((message) => message.includes("ResizeObserver loop")),
        ).toEqual([]);
      } finally {
        await page.locator(".agent-chat__composer-combobox > textarea").fill("");
        await page.setViewportSize({ width: 1366, height: 900 });
      }
    },
  );

  it(
    "reveals, pins, and dismisses message context from the timestamp",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      try {
        await page.setViewportSize({ width: 1366, height: 900 });
        const group = page.locator(".chat-group").filter({ hasText: SHARED_APP_CONTEXT_TEXT });
        const details = group.locator("details.msg-meta");
        const context = details.locator(".msg-meta__details");
        const summary = details.locator(".msg-meta__summary");
        const messageText = group.locator(".chat-text").first();
        await messageText.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        const initialLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          return {
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
          };
        });
        expect(await context.isVisible()).toBe(false);

        // Travel like a real pointer: the footer overlay is pointer-gated until
        // the group is hovered, so enter through the message body first.
        await messageText.hover();
        await summary.hover();
        // The reveal is state-driven, so the re-render can lag the hover event
        // under CPU contention; poll instead of a one-shot visibility read.
        await context.waitFor({ state: "visible", timeout: 10_000 });
        const hoverLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          const summaryNode = node.querySelector<HTMLElement>(".msg-meta__summary")!;
          const detailsOverlay = node.querySelector<HTMLElement>(".msg-meta__details")!;
          return {
            contextBottom: detailsOverlay.getBoundingClientRect().bottom,
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
            summaryTop: summaryNode.getBoundingClientRect().top,
          };
        });
        expect(hoverLayout.footerHeight).toBeCloseTo(initialLayout.footerHeight, 2);
        expect(hoverLayout.groupHeight).toBeCloseTo(initialLayout.groupHeight, 2);
        expect(hoverLayout.contextBottom).toBeLessThanOrEqual(hoverLayout.summaryTop + 4);

        await page.mouse.move(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });

        await messageText.hover();
        await summary.hover();
        // Escape only owns pinned disclosures; it must not corrupt an active
        // hover preview before the click converts that preview into a pin.
        await page.keyboard.press("Escape");
        await summary.click();
        await page.mouse.move(0, 0);
        // Click-to-open must survive the pointer leaving the message group.
        await context.waitFor({ state: "visible", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBe("");

        await page.mouse.click(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBeNull();

        await messageText.hover();
        await summary.click();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        await page.keyboard.press("Escape");
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBeNull();
      } finally {
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
      }
    },
  );

  it(
    "renders encoded media extensions from assistant output and transcript fields",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      const image = page.locator(`img.chat-message-image[src="${SHARED_APP_IMAGE_URL}"]`);
      const video = page.locator(`video[src="${SHARED_APP_VIDEO_URL}"]`);
      await image.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
      await video.waitFor({ state: "attached", timeout: 10_000 });
      expect(await image.getAttribute("src")).toBe(SHARED_APP_IMAGE_URL);
      expect(await video.getAttribute("src")).toBe(SHARED_APP_VIDEO_URL);
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

      const mediumRadius = 10 * (await readCornerScale(page));
      expect(geometry.bubble?.borderRadius).toBe(mediumRadius);
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
      expect(geometry.composer?.borderRadius).toBe(mediumRadius);

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
    "keeps punctuation attached to inline code in %s mode",
    async (themeMode) => {
      const page = await openBrowserPage(800, 400);
      try {
        await page.setContent(
          `<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
            <div class="chat-text"><p>Use <code>status</code>; then <code>restart</code>.</p></div>
          </body></html>`,
        );

        const spacing = await page.locator(".chat-text code").evaluateAll((nodes) =>
          nodes.map((node) => {
            const punctuation = node.nextSibling;
            if (!(punctuation instanceof Text)) {
              throw new Error("Expected punctuation text after inline code");
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            const textRect = range.getBoundingClientRect();
            range.setStart(punctuation, 0);
            range.setEnd(punctuation, 1);
            const punctuationRect = range.getBoundingClientRect();
            range.detach();
            const chipRect = (node as HTMLElement).getBoundingClientRect();
            const paragraph = (node as HTMLElement).parentElement;
            if (!paragraph) {
              throw new Error("Expected inline code inside a paragraph");
            }
            return {
              horizontalGap: punctuationRect.left - textRect.right,
              chipHeight: chipRect.height,
              lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
            };
          }),
        );

        expect(spacing).toHaveLength(2);
        for (const { horizontalGap, chipHeight, lineHeight } of spacing) {
          // The gap is the chip's em-derived inset plus its border, so a quarter of
          // the 14px prose size holds on every platform.
          expect(horizontalGap).toBeLessThanOrEqual(3.75);
          // Measure the chip against the paragraph's CSS line box rather than a text
          // rect: the chip's content height follows the monospace font's default line
          // spacing, which differs by several px between macOS and Linux.
          expect(lineHeight).toBeGreaterThan(0);
          expect(chipHeight).toBeLessThanOrEqual(lineHeight + 1);
        }
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each(["dark", "light"] as const)(
    "fits short table cards to their columns in %s mode",
    async (themeMode) => {
      const page = await openBrowserPage(800, 400);
      try {
        await page.setContent(
          `<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
            <div class="chat-text">
              <div data-table-lane style="width: 680px">
                <table data-short-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
              <div data-narrow-table-lane style="width: 160px">
                <table data-narrow-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
            </div>
          </body></html>`,
        );

        const geometry = await page.evaluate(() => {
          const rectFor = (selector: string) =>
            document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          const shortTable = rectFor("[data-short-table]");
          const lastCell = rectFor("[data-short-table] tbody td:last-child");
          return {
            laneWidth: rectFor("[data-table-lane]").width,
            narrowLaneWidth: rectFor("[data-narrow-table-lane]").width,
            narrowTableWidth: rectFor("[data-narrow-table]").width,
            shortTableWidth: shortTable.width,
            trailingGap: shortTable.right - lastCell.right,
          };
        });

        expect(geometry.shortTableWidth).toBeLessThan(geometry.laneWidth);
        expect(geometry.trailingGap).toBeLessThanOrEqual(1);
        expect(geometry.narrowTableWidth).toBeCloseTo(geometry.narrowLaneWidth, 0);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

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
      const attach = expectControlRect(layout.attach, "attachment control");
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
      expect(context.x).toBeGreaterThanOrEqual(model.x + model.width - 1);
      expect(input.x + input.width - (send.x + send.width)).toBeLessThanOrEqual(8);
      for (const control of [model, context]) {
        expect(
          Math.abs(control.y + control.height / 2 - (model.y + model.height / 2)),
        ).toBeLessThanOrEqual(2);
      }
      expect(meta.y).toBeGreaterThanOrEqual(model.y - 1);
      expect(attachIcon.width).toBeGreaterThanOrEqual(18);
      expect(attachIcon.height).toBeGreaterThanOrEqual(18);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [320, 568, false],
    [375, 812, false],
    [667, 375, false],
    [768, 500, false],
    [320, 568, true],
    [667, 375, true],
  ] as const)(
    "keeps the context usage popover inside the mobile viewport and clear of the input at %sx%s (attachment: %s)",
    async (width, height, composerAttachment) => {
      const page = await openFixture(width, height, { composerAttachment });
      try {
        const composer = await getBoundingBox(page, ".agent-chat__input");
        const menuSelector = ".context-usage__popover";
        const triggerSelector = ".context-ring";
        await page.locator(triggerSelector).evaluate((node) => {
          node.parentElement?.setAttribute("open", "");
        });
        await waitForLayoutSettled(page, `${menuSelector}, .agent-chat__input`);
        await syncFixtureComposerPopoverAnchor(page);
        await waitForLayoutSettled(page, `${menuSelector}, .agent-chat__input`);
        const menu = await getBoundingBox(page, menuSelector);
        const trigger = await getBoundingBox(page, triggerSelector);
        const footer = await getBoundingBox(page, ".agent-chat__composer-footer");
        const menuPosition = await page.locator(menuSelector).evaluate((node) => ({
          bottom: getComputedStyle(node).bottom,
          boxSizing: getComputedStyle(node).boxSizing,
          maxHeight: getComputedStyle(node).maxHeight,
        }));
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width + 1);
        expect(menu.y, JSON.stringify(menuPosition)).toBeGreaterThanOrEqual(0);
        expect(menu.y + menu.height).toBeLessThanOrEqual(composer.y + 1);
        expect(trigger.y + trigger.height).toBeLessThanOrEqual(height + 1);
        expect(footer.y + footer.height).toBeLessThanOrEqual(height + 1);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it("anchors mobile context usage when the iPhone visual viewport is panned", async () => {
    const page = await openFixture(375, 812);
    try {
      await page.locator(".card.chat").evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
      });
      await page.evaluate(() => {
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: { height: 400, offsetTop: 300 },
        });
      });
      await syncFixtureComposerPopoverAnchor(page);
      await page.locator(".context-ring").evaluate((node) => {
        node.parentElement?.setAttribute("open", "");
      });
      await waitForLayoutSettled(page, ".context-usage__popover, .agent-chat__input");
      await syncFixtureComposerPopoverAnchor(page);
      await waitForLayoutSettled(page, ".context-usage__popover, .agent-chat__input");
      const composer = await getBoundingBox(page, ".agent-chat__input");
      const menu = await getBoundingBox(page, ".context-usage__popover");
      const anchorEvidence = await page.locator(".agent-chat__input").evaluate((node) => ({
        anchorBottom: getComputedStyle(node).getPropertyValue("--chat-composer-popover-bottom"),
        layoutHeight: document.documentElement.clientHeight,
      }));

      expect(menu.y).toBeGreaterThanOrEqual(300);
      expect(
        Math.abs(menu.y + menu.height - (composer.y - 6)),
        JSON.stringify({ anchorEvidence, composer, menu }),
      ).toBeLessThanOrEqual(1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps transient footer controls from crushing the mobile model pickers", async () => {
    const page = await openFixture(320, 568, { crowdedComposerFooter: true });
    try {
      await expectNoHorizontalOverflow(page);
      const layout = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector)!;
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
          };
        };
        return {
          controls: rectFor(".agent-chat__composer-controls"),
          effort: rectFor(".chat-controls__effort-trigger"),
          footer: rectFor(".agent-chat__composer-footer"),
          meta: rectFor(".agent-chat__composer-meta"),
          model: rectFor(".chat-controls__model-trigger"),
          modelLabel: rectFor(".chat-controls__model-trigger .chat-controls__inline-select-label"),
          overrides: rectFor(".agent-chat__session-overrides-pill"),
          status: rectFor(".agent-chat__composer-run-status"),
          typing: rectFor(".agent-chat__typing-indicator--outside"),
        };
      });

      expect(layout.controls.scrollWidth).toBeLessThanOrEqual(layout.controls.clientWidth + 1);
      for (const control of [
        layout.status,
        layout.overrides,
        layout.model,
        layout.effort,
        layout.typing,
      ]) {
        expect(control.x).toBeGreaterThanOrEqual(layout.footer.x - 1);
        expect(control.x + control.width).toBeLessThanOrEqual(
          layout.footer.x + layout.footer.width + 1,
        );
      }
      for (const trigger of [layout.model, layout.effort]) {
        expect(trigger.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        expect(trigger.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      }
      expect(layout.modelLabel.scrollWidth).toBeLessThanOrEqual(layout.modelLabel.clientWidth + 1);
      for (const [left, right] of [
        [layout.status, layout.overrides],
        [layout.overrides, layout.model],
        [layout.model, layout.effort],
        [layout.effort, layout.meta],
      ] as const) {
        expect(rectsOverlap(left, right)).toBe(false);
      }
      expect(rectsOverlap(layout.typing, layout.footer)).toBe(false);
    } finally {
      await closeBrowserPage(page);
    }
  });

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
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
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
            modelTrigger: rectFor(".chat-controls__model-trigger"),
            modelLabel: rectFor(
              ".chat-controls__model-trigger .chat-controls__inline-select-label",
            ),
            effortTrigger: rectFor(".chat-controls__effort-trigger"),
            effortLabel: rectFor(
              ".chat-controls__effort-trigger .chat-controls__inline-select-label",
            ),
            context: rectFor(".context-ring"),
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
        const modelTrigger = expectControlRect(controls.modelTrigger, "composer model trigger");
        const modelLabel = expectControlRect(controls.modelLabel, "composer model label");
        const effortTrigger = expectControlRect(
          controls.effortTrigger,
          "composer thinking trigger",
        );
        const effortLabel = expectControlRect(controls.effortLabel, "composer thinking label");
        const context = expectControlRect(controls.context, "composer context control");
        const attach = expectControlRect(controls.attach, "composer attach control");
        const send = expectControlRect(controls.send, "composer send control");

        for (const control of [
          footer,
          textarea,
          meta,
          model,
          modelTrigger,
          effortTrigger,
          context,
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
        expect(model.y).toBeGreaterThanOrEqual(textarea.y);
        expect(context.y).toBeGreaterThanOrEqual(textarea.y);
        expect(
          Math.abs(attach.y + attach.height / 2 - (send.y + send.height / 2)),
        ).toBeLessThanOrEqual(2);
        expect(attach.x + attach.width).toBeLessThanOrEqual(textarea.x + 1);
        expect(send.x).toBeGreaterThanOrEqual(textarea.x + textarea.width - 1);
        expect(send.x + send.width).toBeLessThanOrEqual(input.x + input.width + 1);
        expect(rectsOverlap(model, send)).toBe(false);
        const effortContextGap = context.x - (effortTrigger.x + effortTrigger.width);
        expect(effortContextGap).toBeGreaterThanOrEqual(-1);
        expect(effortContextGap).toBeLessThanOrEqual(9);
        const composerFontSize = await page
          .locator(".agent-chat__composer-combobox > textarea")
          .evaluate((textareaNode) => Number.parseFloat(getComputedStyle(textareaNode).fontSize));
        if (width <= 768) {
          expect(composerFontSize).toBe(16);
          expect(model.width).toBeGreaterThanOrEqual(40);
          expect(model.width).toBeLessThanOrEqual(footer.width);
          for (const trigger of [modelTrigger, effortTrigger]) {
            expect(trigger.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
            expect(trigger.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          }
          for (const label of [modelLabel, effortLabel]) {
            expect(label.clientWidth).toBeDefined();
            expect(label.scrollWidth).toBeDefined();
            expect(label.scrollWidth ?? 0).toBeLessThanOrEqual((label.clientWidth ?? 0) + 1);
          }
          expect(send.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(send.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          for (const control of [model, context]) {
            expect(
              Math.abs(control.y + control.height / 2 - (model.y + model.height / 2)),
            ).toBeLessThanOrEqual(2);
          }
          expect(footer.height).toBeLessThanOrEqual(49.1);
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

  it("keeps newly opened sidebar columns transparent while panel owners retain their surface", async () => {
    const page = await openBrowserPage(1_000, 700);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="sidebar-region" style="--panel: rgb(12, 34, 56)">
            <main class="sidebar-region__primary">Primary chat</main>
          </div>
        </body></html>`,
      );

      const backgrounds = await page.evaluate(() => {
        const column = document.createElement("section");
        column.className = "sidebar-column";
        column.innerHTML = '<div class="sidebar-panel">Owned panel surface</div>';
        document.querySelector(".sidebar-region")?.append(column);
        return {
          column: getComputedStyle(column).backgroundColor,
          panel: getComputedStyle(column.firstElementChild!).backgroundColor,
        };
      });

      expect(backgrounds.column).toBe("rgba(0, 0, 0, 0)");
      expect(backgrounds.panel).toBe("rgb(12, 34, 56)");
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("stacks the single side panel below the conversation at the pane breakpoint", async () => {
    const page = await openBrowserPage(900, 700);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div style="width: 620px; height: 600px; display: flex;">
            <div class="sidebar-region sidebar-region--narrow">
              <main class="sidebar-region__primary">Primary chat</main>
              <section class="sidebar-column side-panel side-panel--narrow">
                <div class="rail-header side-panel__header">Details</div>
                <div class="side-panel__body">Active detail panel</div>
              </section>
            </div>
          </div>
        </body></html>`,
      );

      await expectNoHorizontalOverflow(page);
      const primary = await getRect(page, ".sidebar-region__primary");
      const sidebar = await getRect(page, ".side-panel--narrow");
      expect(sidebar.top).toBeGreaterThanOrEqual(primary.bottom - 1);
      expect(Math.abs(sidebar.width - primary.width)).toBeLessThanOrEqual(1);
      expect(sidebar.width).toBeGreaterThanOrEqual(618);
      expect(await page.locator(".side-panel").count()).toBe(1);
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
          <div style="width: 360px; height: 320px; display: flex;">
              <aside class="chat-tasks-rail" style="width: 100%; height: 100%;">
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
          send: rectFor(".chat-send-btn"),
        };
      });

      const scrolledShell = expectControlRect(scrolled.shell, "scrolled composer shell");
      const scrolledInput = expectControlRect(scrolled.input, "scrolled composer");
      for (const [label, control] of [
        ["composer metadata", scrolled.meta],
        ["composer model control", scrolled.model],
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

  describe("slash command keyboard navigation", () => {
    let page: Page;

    beforeAll(async () => {
      page = await getSharedAppPage();
      await page.setViewportSize({ width: 568, height: 320 });
      await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      await textarea.fill("/");
      await textarea.focus();
    });

    afterAll(async () => {
      await page.locator(".agent-chat__composer-combobox > textarea").fill("");
      await page.setViewportSize({ width: 1366, height: 900 });
    });

    it("scrolls the keyboard-active slash option into view in short landscape", async () => {
      const initiallyHidden = await page.evaluate(() => {
        const scrollRegion = document.querySelector<HTMLElement>(".slash-menu__scroll");
        const options = Array.from(
          document.querySelectorAll<HTMLElement>(".slash-menu-item[role='option']"),
        );
        const hiddenOption = options.find((option) => {
          const menuRect = scrollRegion?.getBoundingClientRect();
          const optionRect = option.getBoundingClientRect();
          return Boolean(menuRect && optionRect.bottom > menuRect.bottom + 1);
        });
        if (!scrollRegion || !hiddenOption) {
          throw new Error("Expected an initially hidden slash option");
        }
        scrollRegion.scrollTop = 0;
        const menuRect = scrollRegion.getBoundingClientRect();
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
        const scrollRegion = active?.closest<HTMLElement>(".slash-menu__scroll");
        if (!active || !scrollRegion) {
          return false;
        }
        const menuRect = scrollRegion.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1;
      }, initiallyHidden.id);

      const result = await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        const scrollRegion = document.querySelector<HTMLElement>(".slash-menu__scroll");
        const active = document.querySelector<HTMLElement>(".slash-menu-item--active");
        if (!input || !scrollRegion || !active) {
          throw new Error("Expected active slash option after keyboard navigation");
        }
        const menuRect = scrollRegion.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return {
          activeDescendant: input.getAttribute("aria-activedescendant"),
          focusedTag: document.activeElement?.tagName,
          scrollTop: scrollRegion.scrollTop,
          visible: activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1,
        };
      });

      expect(result.focusedTag).toBe("TEXTAREA");
      expect(result.activeDescendant).toBe(initiallyHidden.id);
      expect(result.scrollTop).toBeGreaterThan(0);
      expect(result.visible).toBe(true);
    });
  });

  it("keeps overflowing skill suggestions on the nested scroll viewport", async () => {
    const page = await openBrowserPage(568, 320);
    try {
      const items = Array.from({ length: 16 }, (_, index) => {
        const active = index === 15 ? " slash-menu-item--active" : "";
        return `<div class="slash-menu-item${active}" role="option">
          <span class="slash-menu-leading">
            <span class="slash-menu-icon">${iconSvg()}</span>
            <span class="slash-menu-name">$skill_${index + 1}</span>
          </span>
        </div>`;
      }).join("");
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="slash-menu skill-menu" role="listbox">
          <div class="slash-menu__scroll">${items}</div>
        </div>
      </body></html>`);

      const result = await page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(".slash-menu-item--active");
        const scrollRegion = active?.closest<HTMLElement>(".slash-menu__scroll");
        if (!active || !scrollRegion) {
          throw new Error("Expected an active skill inside the nested viewport");
        }
        const viewport = scrollRegion.getBoundingClientRect();
        const option = active.getBoundingClientRect();
        scrollRegion.scrollTop += option.bottom - viewport.bottom;
        const settledOption = active.getBoundingClientRect();
        const settledViewport = scrollRegion.getBoundingClientRect();
        return {
          outerScrollTop: active.closest<HTMLElement>(".skill-menu")?.scrollTop,
          scrollTop: scrollRegion.scrollTop,
          visible:
            settledOption.top >= settledViewport.top - 1 &&
            settledOption.bottom <= settledViewport.bottom + 1,
        };
      });

      expect(result.outerScrollTop).toBe(0);
      expect(result.scrollTop).toBeGreaterThan(0);
      expect(result.visible).toBe(true);
    } finally {
      await closeBrowserPage(page);
    }
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
    "scrolls long session-rail conversations instead of expanding the overlay at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height, {
        sessionRailBody: LONG_SESSION_RAIL_BODY,
      });
      try {
        const panel = await page.evaluate(() => {
          const element = document.querySelector(".chat-session-rail") as HTMLElement;
          const pane = document.querySelector(".chat-main") as HTMLElement;
          return {
            clientHeight: element.clientHeight,
            paneHeight: pane.clientHeight,
            position: getComputedStyle(element).position,
          };
        });
        expect(panel.position).toBe("absolute");
        // The rail fills its pane and no more; growth past the container is what
        // the old floating card was capped against, and the sheet must not
        // reintroduce it. Long threads scroll internally instead — asserted below.
        expect(panel.clientHeight).toBeLessThanOrEqual(panel.paneHeight);

        const body = await page.locator(".chat-session-rail__thread").evaluate((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            overflowY: style.overflowY,
            clientHeight: (node as HTMLElement).clientHeight,
            scrollHeight: (node as HTMLElement).scrollHeight,
          };
        });
        expect(body.overflowY).toBe("auto");
        expect(body.clientHeight).toBeLessThan(body.scrollHeight);

        const scrollTop = await page.locator(".chat-session-rail__thread").evaluate((node) => {
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

  it("renders the session rail as a mobile overlay without horizontal overflow", async () => {
    const page = await openFixture(320, 568, {
      sessionRailBody: LONG_SESSION_RAIL_BODY,
    });
    try {
      await expectNoHorizontalOverflow(page);
      const panel = await page.locator(".chat-session-rail").evaluate((node) => {
        const element = node as HTMLElement;
        return {
          clientHeight: element.clientHeight,
          position: getComputedStyle(element).position,
        };
      });
      expect(panel.position).toBe("fixed");
      // Full-screen sheet at this width: bounded by the viewport, never beyond.
      expect(panel.clientHeight).toBeLessThanOrEqual(568);

      const scroll = await page.locator(".chat-session-rail__thread").evaluate((node) => {
        const element = node as HTMLElement;
        return {
          overflowY: getComputedStyle(element).overflowY,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        };
      });
      expect(scroll.overflowY).toBe("auto");
      expect(scroll.clientHeight).toBeLessThan(scroll.scrollHeight);

      const scrollTop = await page.locator(".chat-session-rail__thread").evaluate((node) => {
        const element = node as HTMLElement;
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      });
      expect(scrollTop).toBeGreaterThan(0);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps rail metadata out of the scrolling thread's layout", async () => {
    const page = await openFixture(1024, 768, { sessionRailBody: LONG_SESSION_RAIL_BODY });
    try {
      const styles = await page.evaluate(() => {
        const read = (selector: string) => {
          const style = getComputedStyle(document.querySelector(selector) as HTMLElement);
          return {
            minHeight: style.minHeight,
            overflowY: style.overflowY,
            borderTopWidth: style.borderTopWidth,
          };
        };
        return {
          thread: read(".chat-session-rail__thread"),
          prChecks: read(".chat-session-rail__pr-checks"),
          timestamp: read(".chat-session-rail__timestamp"),
          hint: read(".chat-session-rail__hint"),
        };
      });

      // PR checks, timestamps and hints are metadata inside an exchange. Sharing the
      // thread's rule would give each one a 96px scrolling bordered box; the
      // selector list has silently merged before.
      expect(styles.thread.minHeight).toBe("96px");
      expect(styles.thread.overflowY).toBe("auto");
      for (const metadata of [styles.prChecks, styles.timestamp, styles.hint]) {
        // Relational, not a literal: the point is that these nodes do not share
        // the thread's rule, whatever the thread's own numbers become.
        expect(metadata.minHeight).not.toBe(styles.thread.minHeight);
        expect(metadata.overflowY).toBe("visible");
        expect(metadata.borderTopWidth).toBe("0px");
      }
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("degrades an undocked session rail to a full-height edge sheet, never a floating card", async () => {
    const page = await openFixture(900, 800, {
      sessionRailBody: LONG_SESSION_RAIL_BODY,
    });
    try {
      const geometry = await page.evaluate(() => {
        const rail = document.querySelector(".chat-session-rail") as HTMLElement;
        const main = document.querySelector(".chat-main") as HTMLElement;
        const railBox = rail.getBoundingClientRect();
        const mainBox = main.getBoundingClientRect();
        const style = getComputedStyle(rail);
        return {
          topGap: Math.round(railBox.top - mainBox.top),
          bottomGap: Math.round(mainBox.bottom - railBox.bottom),
          rightGap: Math.round(mainBox.right - railBox.right),
          borderRadius: style.borderTopLeftRadius,
          boxShadow: style.boxShadow,
          backdropFilter: style.backdropFilter,
          animationName: style.animationName,
        };
      });

      // Flush to the pane on three sides with square corners: a surface that
      // took the pane over, not a card hovering above the conversation.
      expect(geometry.topGap).toBe(0);
      expect(geometry.bottomGap).toBe(0);
      expect(geometry.rightGap).toBe(0);
      expect(geometry.borderRadius).toBe("0px");
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("matches the reading prototype's transcript letter spacing without changing shared text", async () => {
    const page = await openBrowserPage(1366, 900);
    try {
      await page.setContent(`<!doctype html><html data-theme-mode="dark"><head><style>${readUiCss()}</style></head><body>
        <div class="chat-thread chat-thread--direct" role="log">
          <div class="chat-thread-inner">
            <div class="chat-group assistant">
              <div class="chat-group-messages">
                <div class="chat-bubble">
                  <div class="chat-text">
                    <p>Aa Bb Cc — Smooth reading depends on the shape, spacing, and contrast of every glyph in a transcript.</p>
                    <p>Keep this fixture about text rendering; width and block rhythm are intentionally not asserted here.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <section class="custodian-surface">
          <div class="chat-bubble"><div class="chat-text">Custodian output</div></div>
        </section>
        <div class="chat-notice"><div class="chat-text chat-notice__body">Compact notice</div></div>
        <div class="cron-run-entry__body chat-text">Cron output</div>
      </body></html>`);

      const transcriptLetterSpacing = await page
        .locator(".chat-thread .chat-bubble .chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const custodianLetterSpacing = await page
        .locator(".custodian-surface .chat-bubble .chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const noticeLetterSpacing = await page
        .locator(".chat-notice .chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const cronLetterSpacing = await page
        .locator(".cron-run-entry__body.chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const bodyLetterSpacing = await page
        .locator("body")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      expect(transcriptLetterSpacing).toBe("normal");
      expect(custodianLetterSpacing).toBe(bodyLetterSpacing);
      expect(noticeLetterSpacing).toBe(bodyLetterSpacing);
      expect(cronLetterSpacing).toBe(bodyLetterSpacing);
    } finally {
      await closeBrowserPage(page);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
