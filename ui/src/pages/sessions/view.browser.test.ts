// Control UI tests cover sessions behavior.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

const VIEWPORTS = [
  [375, 812],
  [430, 932],
  [768, 1024],
  [1440, 900],
] as const;

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

type BrowserFixture = {
  context: BrowserContext;
  page: Page;
};

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/layout.mobile.css",
    "ui/src/styles/components.css",
    "ui/src/styles/sessions.css",
  ];
  return files.map((file) => readStyleSheet(file)).join("\n");
}

function sessionsTableHtml() {
  const headers = ["", "Key", "Kind", "Status", "Updated", "Tokens", "Actions"];
  const overviewTiles = [
    ["3", "Sessions"],
    ["1", "Live"],
    ["1", "Unread"],
    ["123k", "Tokens"],
  ]
    .map(
      ([value, label]) => `
        <div class="sessions-overview__tile">
          <span class="sessions-overview__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></svg>
          </span>
          <span class="sessions-overview__meta">
            <span class="sessions-overview__value">${value}</span>
            <span class="sessions-overview__label">${label}</span>
          </span>
        </div>
      `,
    )
    .join("");
  return `
    <section class="card">
      <div class="sessions-overview">${overviewTiles}</div>
      <div class="data-table-wrapper">
        <div class="data-table-container">
          <table class="data-table sessions-table">
            <thead>
              <tr>
                ${headers
                  .map(
                    (header, index) =>
                      `<th class="${
                        index === 0
                          ? "data-table-checkbox-col"
                          : index === 1
                            ? "data-table-key-col"
                            : index === 3
                              ? "session-status-col"
                              : index === 6
                                ? "session-actions-col"
                                : ""
                      }">${
                        index === 6 ? `<span class="sessions-sr-only">${header}</span>` : header
                      }</th>`,
                  )
                  .join("")}
              </tr>
            </thead>
            <tbody>
              <tr class="session-data-row session-data-row--expandable session-data-row--expanded">
                <td class="data-table-checkbox-col"><input type="checkbox" /></td>
                <td class="data-table-key-col">
                  <div class="mono session-key-cell" aria-label="agent:main:main">
                    <span class="session-avatar session-avatar--direct" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      <span class="session-avatar__status"></span>
                    </span>
                    <div class="session-key-cell__text">
                      <span class="session-key-cell__primary">
                        <a class="session-link">agent:main:main</a>
                        <span class="session-label-chip">triage</span>
                      </span>
                    </div>
                  </div>
                </td>
                <td><span class="data-table-badge data-table-badge--direct">direct</span></td>
                <td class="session-status-col">
                  <span class="session-status-badge session-status-badge--live" aria-label="Status: Live">
                    <span class="session-status-badge__dot" aria-hidden="true"></span>
                    <span class="session-status-badge__label">Live</span>
                  </span>
                </td>
                <td>now</td>
                <td class="session-token-cell">
                  <div class="session-tokens">
                    <span class="session-tokens__value">123k / 200k</span>
                    <span class="session-context-meter session-context-meter--ok" role="img" aria-label="62% of context used (123,456 / 200,000 tokens)">
                      <span class="session-context-meter__fill" style="width: 62%"></span>
                    </span>
                  </div>
                </td>
                <td class="session-actions-cell">
                  <div class="session-actions">
                    <button class="session-details-toggle" type="button" aria-expanded="true">
                      <span class="session-compaction-count">1</span>
                      <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
                    </button>
                    <button class="icon-btn" aria-label="Open session menu" aria-haspopup="menu">
                      <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1" /></svg>
                    </button>
                  </div>
                </td>
              </tr>
              <tr class="session-details-row">
                <td colspan="7">
                  <div class="session-details-panel">
                    <div class="session-details-panel__hero">
                      <div>
                        <div class="session-details-panel__eyebrow">Session details</div>
                        <div class="session-details-panel__title">agent:main:main</div>
                      </div>
                      <div class="session-details-panel__badges">
                        <span class="session-status-badge session-status-badge--live" aria-label="Status: Live">
                          <span class="session-status-badge__dot" aria-hidden="true"></span>
                          <span class="session-status-badge__label">Live</span>
                        </span>
                        <span class="data-table-badge data-table-badge--direct">direct</span>
                      </div>
                    </div>
                    <div class="session-details-section">
                      <div class="session-details-panel__eyebrow">Overrides</div>
                      <div class="session-overrides-grid">
                        <label class="session-override-field">
                          <span class="session-override-field__label">Label</span>
                          <input class="session-override-field__control" value="triage" />
                        </label>
                        <label class="session-override-field">
                          <span class="session-override-field__label">Thinking</span>
                          <select class="session-override-field__control"><option>Default</option></select>
                        </label>
                        <label class="session-override-field">
                          <span class="session-override-field__label">Fast</span>
                          <select class="session-override-field__control"><option>on</option></select>
                        </label>
                      </div>
                    </div>
                    <div class="session-details-grid">
                      <div class="session-detail-stat">
                        <div class="session-detail-stat__label">Tokens</div>
                        <div class="session-detail-stat__value">123456 / 200000</div>
                      </div>
                      <div class="session-detail-stat">
                        <div class="session-detail-stat__label">Compaction</div>
                        <div class="session-detail-stat__value">1 Checkpoint</div>
                      </div>
                    </div>
                    <div class="session-details-section">
                      <div class="session-details-panel__eyebrow">Compaction history</div>
                      <div class="session-checkpoint-list">
                        <div class="session-checkpoint-card">
                          <div class="session-checkpoint-card__header">
                            <strong>manual - now</strong>
                            <span class="muted session-checkpoint-card__delta">122,414 to 38,920 tokens</span>
                          </div>
                          <div class="session-checkpoint-card__summary">
                            Earlier transcript state is preserved here for branch or restore.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

async function openFixture(
  browser: Browser,
  width: number,
  height: number,
): Promise<BrowserFixture> {
  const context = await browser.newContext({ viewport: { width, height } });
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${sessionsTableHtml()}</body></html>`,
    );
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function closeFixture(fixture: BrowserFixture): Promise<void> {
  await fixture.context.close().catch(() => {});
}

describeBrowserLayout("sessions responsive browser layout", () => {
  let browser: Browser;

  beforeAll(async () => {
    // Browser startup dominates this suite; fresh contexts keep viewport state isolated.
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
  });

  it.each(VIEWPORTS)("keeps the session roster visible at %dx%d", async (width, height) => {
    const fixture = await openFixture(browser, width, height);
    const { page } = fixture;
    try {
      const metrics = await page.evaluate(() => {
        const container = document.querySelector(".data-table-container");
        const actions = document.querySelector(".session-actions");
        const trigger = document.querySelector(".session-details-toggle");
        const status = document.querySelector(".session-status-badge");
        const statusLabel = document.querySelector(".session-status-badge__label");
        const kind = document.querySelector(".data-table-badge");
        const key = document.querySelector(".session-key-cell .session-link");
        const details = document.querySelector(".session-details-panel");
        if (
          !(container instanceof HTMLElement) ||
          !(actions instanceof HTMLElement) ||
          !(trigger instanceof HTMLElement) ||
          !(status instanceof HTMLElement) ||
          !(statusLabel instanceof HTMLElement) ||
          !(kind instanceof HTMLElement) ||
          !(key instanceof HTMLElement)
        ) {
          throw new Error("Missing sessions table fixture elements");
        }
        const containerRect = container.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        const statusRect = status.getBoundingClientRect();
        const statusStyle = getComputedStyle(status);
        return {
          bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
          checkpointCount: trigger.querySelector(".session-compaction-count")?.textContent?.trim(),
          statusText: status.textContent?.trim(),
          keyWhiteSpace: getComputedStyle(key).whiteSpace,
          kindWhiteSpace: getComputedStyle(kind).whiteSpace,
          statusWhiteSpace: statusStyle.whiteSpace,
          statusBorderStyle: statusStyle.borderTopStyle,
          statusBackgroundColor: statusStyle.backgroundColor,
          hasDetails: details !== null,
          actionsVisible:
            actionsRect.left >= containerRect.left && actionsRect.right <= containerRect.right,
          statusVisible:
            statusRect.left >= containerRect.left && statusRect.right <= containerRect.right,
        };
      });

      expect(metrics.bodyOverflow).toBeLessThanOrEqual(1);
      expect(metrics.checkpointCount).toBe("1");
      expect(metrics.statusText).toBe("Live");
      expect(metrics.keyWhiteSpace).toBe("nowrap");
      expect(metrics.kindWhiteSpace).toBe("nowrap");
      expect(metrics.statusWhiteSpace).toBe("nowrap");
      // Status is a plain dot + label; pill chrome must not come back.
      expect(metrics.statusBorderStyle).toBe("none");
      expect(metrics.statusBackgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(metrics.hasDetails).toBe(true);
      expect(metrics.actionsVisible).toBe(true);
      expect(metrics.statusVisible).toBe(true);
    } finally {
      await closeFixture(fixture);
    }
  });
});
