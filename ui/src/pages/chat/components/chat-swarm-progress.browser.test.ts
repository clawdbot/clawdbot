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

  it("keeps long task popovers reachable above the in-flow mobile composer", async () => {
    if (!browser) {
      throw new Error("expected browser");
    }
    const page = await browser.newPage({ viewport: { width: 375, height: 568 } });
    const tasks = Array.from(
      { length: 256 },
      (_, index) => `<div class="chat-swarm__task">Worker ${index + 1}</div>`,
    ).join("");
    const styles = [
      "ui/src/styles/base.css",
      "ui/src/styles/chat/layout.css",
      "ui/src/styles/chat/message-layout.css",
      "ui/src/styles/chat/composer.css",
      "ui/src/styles/chat/sidebar.css",
    ]
      .map((file) => readStyleSheet(file))
      .join("\n");
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body>
      <section class="card chat">
        <div class="chat-workbench">
          <div class="chat-workbench__main">
            <div class="chat-split-container">
              <div class="chat-main">
                <div class="chat-main__conversation-column">
                  <div class="chat-main__conversation">
                    <div class="chat-thread" role="log">Conversation</div>
                    <aside class="chat-swarm">
                      <div class="chat-swarm__group">
                        <div class="chat-swarm__header"><strong>Active swarm</strong></div>
                        <div class="chat-swarm__tasks" style="visibility:visible;opacity:1;transform:none">
                          ${tasks}
                        </div>
                      </div>
                    </aside>
                    <div class="agent-chat__composer-shell">
                      <div class="agent-chat__input agent-chat__input--chat"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </body></html>`);

    await page.locator(".chat-swarm__group").evaluate((element) => {
      const availableHeight = element.getBoundingClientRect().top - 28;
      element.style.setProperty("--chat-composer-popover-max-height", `${availableHeight}px`);
    });

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
