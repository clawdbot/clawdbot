import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

const VIEWPORTS = [
  [375, 812],
  [430, 932],
  [768, 1024],
  [1440, 900],
] as const;

const describeBrowserLayout = existsSync(chromium.executablePath()) ? describe : describe.skip;

let browser: Browser;

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/layout.mobile.css",
    "ui/src/styles/components.css",
  ];
  return files.map((file) => readStyleSheet(file)).join("\n");
}

function sessionsTableHtml() {
  const headers = [
    "",
    "Key",
    "Label",
    "Kind",
    "Status",
    "Runtime",
    "Updated",
    "Tokens",
    "Compaction",
    "Thinking",
    "Fast",
    "Verbose",
    "Reasoning",
  ];
  return `
    <section class="card">
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
                            : index === 4
                              ? "session-status-col"
                              : index === 8
                                ? "session-compaction-col"
                                : ""
                      }">${header}</th>`,
                  )
                  .join("")}
              </tr>
            </thead>
            <tbody>
              <tr class="session-data-row session-data-row--expandable">
                <td class="data-table-checkbox-col"><input type="checkbox" /></td>
                <td class="data-table-key-col">
                  <div class="mono session-key-cell" title="agent:main:main">
                    <a class="session-link">agent:main:main</a>
                  </div>
                </td>
                <td><input value="" /></td>
                <td><span class="data-table-badge data-table-badge--direct">direct</span></td>
                <td class="session-status-col">
                  <span class="session-status-badge session-status-badge--live" aria-label="Status: Live">
                    <span class="session-status-badge__dot" aria-hidden="true"></span>
                    <span class="session-status-badge__label">Live</span>
                  </span>
                </td>
                <td class="session-runtime-cell"><span class="mono">claude-cli (fallback none)</span></td>
                <td>now</td>
                <td class="session-token-cell">123456 / 200000</td>
                <td class="session-compaction-col">
                  <div class="session-compaction-cell">
                    <button class="session-compaction-trigger" type="button" aria-expanded="true">
                      <span class="session-compaction-count">1 Checkpoint</span>
                    </button>
                  </div>
                </td>
                <td><select><option>Default</option></select></td>
                <td><select><option>on</option></select></td>
                <td><select><option>full</option></select></td>
                <td><select><option>stream</option></select></td>
              </tr>
              <tr class="session-checkpoint-details-row">
                <td colspan="13">
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

async function openFixture(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${sessionsTableHtml()}</body></html>`,
  );
  return page;
}

describeBrowserLayout("sessions responsive browser layout", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it.each(VIEWPORTS)("keeps compaction details visible at %dx%d", async (width, height) => {
    const page = await openFixture(width, height);
    const metrics = await page.evaluate(() => {
      const container = document.querySelector(".data-table-container");
      const compaction = document.querySelector(".session-compaction-cell");
      const trigger = document.querySelector(".session-compaction-trigger");
      const status = document.querySelector(".session-status-badge");
      const statusLabel = document.querySelector(".session-status-badge__label");
      const runtime = document.querySelector(".session-runtime-cell .mono");
      const kind = document.querySelector(".data-table-badge");
      const key = document.querySelector(".session-key-cell .session-link");
      const details = document.querySelector(".session-details-panel");
      if (
        !(container instanceof HTMLElement) ||
        !(compaction instanceof HTMLElement) ||
        !(status instanceof HTMLElement) ||
        !(statusLabel instanceof HTMLElement) ||
        !(runtime instanceof HTMLElement) ||
        !(kind instanceof HTMLElement) ||
        !(key instanceof HTMLElement)
      ) {
        throw new Error("Missing sessions table fixture elements");
      }
      const containerRect = container.getBoundingClientRect();
      const compactionRect = compaction.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      return {
        bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
        compactionText: compaction.textContent?.trim(),
        statusText: status.textContent?.trim(),
        runtimeText: runtime.textContent?.trim(),
        keyWhiteSpace: getComputedStyle(key).whiteSpace,
        kindWhiteSpace: getComputedStyle(kind).whiteSpace,
        statusWhiteSpace: getComputedStyle(status).whiteSpace,
        runtimeWhiteSpace: getComputedStyle(runtime).whiteSpace,
        hasTrigger: trigger !== null,
        hasLegacyButton: document.querySelector(".session-checkpoint-toggle") !== null,
        hasDetails: details !== null,
        compactionVisible:
          compactionRect.left >= containerRect.left && compactionRect.right <= containerRect.right,
        statusVisible:
          statusRect.left >= containerRect.left && statusRect.right <= containerRect.right,
      };
    });

    expect(metrics.bodyOverflow).toBeLessThanOrEqual(1);
    expect(metrics.compactionText).toContain("1 Checkpoint");
    expect(metrics.statusText).toBe("Live");
    expect(metrics.runtimeText).toBe("claude-cli (fallback none)");
    expect(metrics.keyWhiteSpace).toBe("nowrap");
    expect(metrics.kindWhiteSpace).toBe("nowrap");
    expect(metrics.statusWhiteSpace).toBe("nowrap");
    expect(metrics.runtimeWhiteSpace).toBe("nowrap");
    expect(metrics.hasTrigger).toBe(true);
    expect(metrics.hasLegacyButton).toBe(false);
    expect(metrics.hasDetails).toBe(true);
    expect(metrics.compactionVisible).toBe(true);
    expect(metrics.statusVisible).toBe(true);

    await page.close();
  });
});
