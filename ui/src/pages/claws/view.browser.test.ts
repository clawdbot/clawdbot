import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

function fixtureHtml(): string {
  return `
    <main style="max-width: 1180px; margin: 0 auto; padding: 20px">
      <div class="claws-page stack">
        <div class="claws-lifecycle-stack">
          <section class="claws-lifecycle">
            <div class="claws-lifecycle__heading">
              <div><div class="claws-detail__heading">Discover Claws</div></div>
            </div>
            <form class="claws-catalog-search">
              <input class="input" value="financial planning" aria-label="Search ClawHub" />
              <button class="btn" type="button">Search</button>
            </form>
            <div class="claws-catalog-results">
              <button class="claws-catalog-result" type="button">
                <span>
                  <strong>Financial Analyst</strong>
                  <span class="muted">@openclaw/a-very-long-financial-analyst-package-name</span>
                </span>
                <span class="claws-catalog-result__meta"><span class="chip">1.2.0</span></span>
              </button>
            </div>
            <div class="claws-catalog-detail">
              <div><div class="claws-detail__title">Financial Analyst</div></div>
              <dl class="claws-catalog-counts">
                <div><dt>Workspace files</dt><dd>5</dd></div>
                <div><dt>Skills</dt><dd>2</dd></div>
                <div><dt>Plugins</dt><dd>1</dd></div>
                <div><dt>MCP servers</dt><dd>1</dd></div>
                <div><dt>Scheduled work</dt><dd>2</dd></div>
              </dl>
            </div>
          </section>
          <section class="claws-plan">
            <div class="claws-lifecycle__heading"><strong>Change preview</strong><span class="chip">Ready</span></div>
            <div class="claws-plan__actions-list">
              <div class="claws-plan-action">
                <span><strong>update</strong> workspace-file</span>
                <span class="claws-plan-action__id">schemas/financial-quarterly-report-with-a-long-name.json</span>
              </div>
            </div>
            <label class="claws-consent-row"><input type="checkbox" /><span>I reviewed the package risk</span></label>
          </section>
        </div>
        <section class="claws-summary">
          ${["Healthy", "Needs attention", "Managed", "Referenced"]
            .map(
              (label, index) => `
                <div class="claws-summary__item">
                  <span class="claws-summary__icon"><svg viewBox="0 0 24 24"></svg></span>
                  <div>
                    <div class="claws-summary__value">${index + 1}</div>
                    <div class="claws-summary__label">${label}</div>
                  </div>
                </div>`,
            )
            .join("")}
        </section>
        <div class="claws-workspace">
          <div class="claws-inventory">
            <button class="claws-inventory__row" aria-pressed="true">
              <span class="claws-inventory__main">
                <span class="claws-inventory__name">financial-analyst</span>
                <span class="claws-inventory__agent">analyst</span>
              </span>
              <span class="claws-inventory__meta"><span class="chip chip-ok">Healthy</span></span>
            </button>
          </div>
          <section class="claws-detail">
            <div class="claws-detail__header">
              <div>
                <div class="claws-detail__title">financial-analyst</div>
                <div class="claws-detail__subtitle">Agent: analyst</div>
              </div>
              <span class="chip chip-ok">Healthy</span>
            </div>
            <dl class="claws-metadata">
              <div><dt>Version</dt><dd>1.2.0</dd></div>
              <div><dt>Source</dt><dd>package</dd></div>
              <div><dt>First-run setup</dt><dd><span class="chip chip-ok">Complete</span></dd></div>
              <div><dt>Updated</dt><dd>just now</dd></div>
            </dl>
            <section class="claws-detail__section">
              <div class="claws-detail__heading">Resources</div>
              <div class="claws-resource-list">
                <div class="claws-resource">
                  <div class="claws-resource__identity">
                    <span class="claws-resource__kind">Plugin</span>
                    <span class="claws-resource__id">@openclaw/a-very-long-financial-markets-integration-package@2026.7.22</span>
                  </div>
                  <div class="claws-resource__state">
                    <span class="chip">referenced</span>
                    <span class="chip">pre-existing</span>
                    <span class="chip chip-ok">present</span>
                  </div>
                </div>
              </div>
            </section>
          </section>
        </div>
      </div>
    </main>
  `;
}

describeBrowserLayout("Claws responsive layout", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  for (const [width, height] of [
    [375, 812],
    [1440, 900],
  ] as const) {
    it(`fits lifecycle inventory at ${width}x${height}`, async () => {
      const page: Page = await browser.newPage({ viewport: { width, height } });
      const css = [
        "ui/src/styles/base.css",
        "ui/src/styles/components.css",
        "ui/src/styles/claws.css",
      ]
        .map((file) => readStyleSheet(file))
        .join("\n");
      await page.setContent(
        `<!doctype html><html><head><style>${css}\nhtml, body { overflow: visible; height: auto; min-height: 100%; }</style></head><body>${fixtureHtml()}</body></html>`,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const inventory = await page.locator(".claws-inventory").boundingBox();
      const detail = await page.locator(".claws-detail").boundingBox();
      const catalog = await page.locator(".claws-catalog-detail").boundingBox();
      const summary = await page.locator(".claws-summary").boundingBox();
      const resource = await page.locator(".claws-resource").boundingBox();
      expect(inventory).not.toBeNull();
      expect(detail).not.toBeNull();
      expect(catalog).not.toBeNull();
      expect(summary).not.toBeNull();
      expect(resource).not.toBeNull();
      expect(summary!.y).toBeGreaterThan(catalog!.y);
      expect(resource!.y).toBeGreaterThanOrEqual(detail!.y);
      if (width <= 760) {
        expect(detail!.y).toBeGreaterThanOrEqual(inventory!.y + inventory!.height - 1);
      } else {
        expect(Math.abs(detail!.y - inventory!.y)).toBeLessThanOrEqual(1);
        expect(detail!.x).toBeGreaterThan(inventory!.x);
      }

      await page.close();
    });
  }
});
