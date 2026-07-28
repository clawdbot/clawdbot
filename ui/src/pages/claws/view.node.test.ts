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
        <div class="settings-segmented claws-mode">
          <button class="settings-segmented__btn settings-segmented__btn--active">Installed</button>
          <button class="settings-segmented__btn">Discover</button>
        </div>
        <section class="claws-plan">
          <div class="claws-detail__header">
            <div>
              <div class="claws-detail__title">Update Claw</div>
              <div class="claws-detail__subtitle">financial-analyst</div>
            </div>
            <span class="chip chip-warn">Preview</span>
          </div>
          <div class="claws-plan__groups">
            <section>
              <div class="claws-detail__heading">Changes</div>
              <div class="claws-plan__list">
                <div class="claws-plan__row"><span><strong>update</strong> AGENTS.md</span><span class="chip">workspace-file</span></div>
              </div>
            </section>
            <section>
              <div class="claws-detail__heading">Capabilities requiring consent</div>
              <div class="claws-plan__list">
                <div class="claws-plan__row"><span><strong>install</strong> @openclaw/a-very-long-financial-markets-integration-package<small>Required by the selected Claw release.</small></span><span class="chip">plugin</span></div>
              </div>
            </section>
          </div>
          <label class="claws-consent"><input type="checkbox" /><span>I understand this ClawHub release has a security warning and want to continue.</span></label>
          <div class="claws-plan__actions"><button class="btn">Cancel</button><button class="btn primary">Update Claw</button></div>
        </section>
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
        `<!doctype html><html><head><style>${css}</style></head><body>${fixtureHtml()}</body></html>`,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const inventory = await page.locator(".claws-inventory").boundingBox();
      const detail = await page.locator(".claws-detail").boundingBox();
      const plan = await page.locator(".claws-plan").boundingBox();
      expect(inventory).not.toBeNull();
      expect(detail).not.toBeNull();
      expect(plan).not.toBeNull();
      expect(plan!.x).toBeGreaterThanOrEqual(0);
      expect(plan!.x + plan!.width).toBeLessThanOrEqual(width);
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
