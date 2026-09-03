// Control UI tests cover the working claw's optical alignment.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowser = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;

const claw = `
  <svg viewBox="0 0 24 24">
    <path d="M8.2 10 A5.2 5.2 0 1 0 8.2 20.4 A5.2 5.2 0 0 0 8.2 10 Z M10.2 20 C14.5 20.8 19 18.6 22.3 13.2 C21 12.9 19.7 12.7 18.4 12.8 L17.5 14.6 L16 12.9 L14.3 14.5 L13.5 13 L11.5 14.2 Z"></path>
    <path class="claw-icon__jaw" d="M5.6 12.2 C5.2 5.6 10.4 1.4 15.6 2 C19.4 2.6 21.8 5.2 22.6 8.2 C20.9 7.7 19.2 7.6 17.6 7.9 L16.9 6.3 L15.2 8.5 C13.6 9.4 12.2 10.9 11.6 12.4 L6.8 13 Z"></path>
  </svg>`;

describeBrowser("working claw browser layout", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("centers the claw when grouped chat styles load after the indicator styles", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 240 } });
    try {
      const css = [
        "ui/src/styles/base.css",
        "ui/src/styles/components.css",
        "ui/src/styles/chat/working-indicator.css",
        // Production code splitting can attach grouped chat CSS after the
        // indicator chunk. The centering invariant must not depend on order.
        "ui/src/styles/chat/grouped.css",
      ]
        .map((file) => readStyleSheet(file))
        .join("\n");
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
        <div class="chat-group assistant chat-group--working">
          <div class="chat-working-indicator">
            <div class="chat-bubble chat-reading-indicator">${claw}</div>
            <span class="chat-working-indicator__status">
              <span class="chat-working-indicator__elapsed">8s</span><span>·</span><span>72 tokens</span>
            </span>
          </div>
        </div>
      </body></html>`);

      const geometry = await page.evaluate(() => {
        const center = (selector: string) => {
          const bounds = document.querySelector(selector)!.getBoundingClientRect();
          return bounds.top + bounds.height / 2;
        };
        const svg = document.querySelector<SVGElement>(".chat-reading-indicator svg")!;
        return {
          display: getComputedStyle(document.querySelector(".chat-reading-indicator")!).display,
          layoutCenter: center(".chat-reading-indicator"),
          paintedCenter: center(".chat-reading-indicator svg"),
          statusCenter: center(".chat-working-indicator__status"),
          translate: getComputedStyle(svg).translate,
        };
      });

      // As a flex item, inline-flex is blockified to flex in computed style.
      expect(geometry.display).toBe("flex");
      expect(geometry.layoutCenter).toBeCloseTo(geometry.statusCenter, 3);
      expect(geometry.paintedCenter).toBeCloseTo(geometry.statusCenter, 3);
      expect(geometry.translate).toBe("none");
    } finally {
      await page.close();
    }
  });
});
