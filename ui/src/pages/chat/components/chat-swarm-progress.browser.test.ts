import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

let browser: Browser | null = null;

describeBrowserLayout("chat swarm progress browser layout", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("keeps long task popovers reachable inside the viewport", async () => {
    if (!browser) {
      throw new Error("expected browser");
    }
    const page = await browser.newPage({ viewport: { width: 375, height: 568 } });
    const tasks = Array.from(
      { length: 256 },
      (_, index) => `<div class="chat-swarm__task">Worker ${index + 1}</div>`,
    ).join("");
    const styles = ["ui/src/styles/base.css", "ui/src/styles/chat/layout.css"]
      .map((file) => readStyleSheet(file))
      .join("\n");
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body>
      <aside class="chat-swarm" style="position:fixed;right:0;bottom:16px;left:0">
        <div class="chat-swarm__group">
          <div class="chat-swarm__header"><strong>Active swarm</strong></div>
          <div class="chat-swarm__tasks" style="visibility:visible;opacity:1;transform:none">
            ${tasks}
          </div>
        </div>
      </aside>
    </body></html>`);

    const layout = await page.locator(".chat-swarm__tasks").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientHeight: element.clientHeight,
        overflowY: style.overflowY,
        scrollHeight: element.scrollHeight,
        top: element.getBoundingClientRect().top,
      };
    });

    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.overflowY).toBe("auto");
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  });
});
