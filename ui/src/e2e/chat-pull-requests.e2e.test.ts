// Control UI tests cover session pull request chips above the chat composer.
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
const openBrowsers = new Set<Browser>();

async function newBrowserContext(): Promise<BrowserContext> {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  openBrowsers.add(browser);
  return browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
}

async function closeBrowsers(): Promise<void> {
  await Promise.all([...openBrowsers].map((browser) => browser.close().catch(() => {})));
  openBrowsers.clear();
}

describeControlUiE2e("session pull request chips", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await closeBrowsers();
    await server?.close();
  });

  afterEach(closeBrowsers);

  it("pins detected PR chips above the composer with rate-limit staleness", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "controlUi.sessionPullRequests"],
      methodResponses: {
        "controlUi.sessionPullRequests": {
          pullRequests: [
            {
              number: 103469,
              owner: "openclaw",
              repo: "openclaw",
              branch: "claude/browser-tabs-tighter-header",
              title: "fix(macos): tighten the link-browser tab header",
              url: "https://github.com/openclaw/openclaw/pull/103469",
              state: "open",
              additions: 4,
              deletions: 3,
              checks: "passing",
              checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
            },
            {
              number: 103438,
              owner: "openclaw",
              repo: "openclaw",
              branch: "claude/browser-tabs-web-ui-756a64",
              title: "feat(ui): link browser tabs into the web UI",
              url: "https://github.com/openclaw/openclaw/pull/103438",
              state: "merged",
            },
          ],
          rateLimited: true,
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);

    const chips = page.locator(".chat-pr");
    await expect.poll(() => chips.count()).toBe(2);

    const openChip = chips.first();
    await expect.poll(() => openChip.getAttribute("data-state")).toBe("open");
    await expect.poll(() => openChip.locator(".chat-pr__number").textContent()).toBe("#103469");
    await expect
      .poll(() => openChip.locator(".chat-pr__branch").textContent())
      .toBe("claude/browser-tabs-tighter-header");
    await expect.poll(() => openChip.locator(".chat-pr__additions").textContent()).toBe("+4");
    await expect
      .poll(() => openChip.locator(".chat-pr__checks").getAttribute("data-checks"))
      .toBe("passing");
    // Rate-limited data shows the stale warning on non-terminal chips only.
    await expect.poll(() => openChip.locator(".chat-pr__warning").count()).toBe(1);

    const mergedChip = chips.nth(1);
    await expect.poll(() => mergedChip.getAttribute("data-state")).toBe("merged");
    await expect
      .poll(() => mergedChip.locator(".chat-pr__state").textContent())
      .toContain("Merged");
    await expect.poll(() => mergedChip.locator(".chat-pr__warning").count()).toBe(0);

    // The chip row sits inside the chat column directly above the composer.
    const rowBottom = await page
      .locator(".chat-prs")
      .evaluate((node) => node.getBoundingClientRect().bottom);
    const composerTop = await page
      .locator(".agent-chat__composer-shell")
      .evaluate((node) => node.getBoundingClientRect().top);
    expect(rowBottom).toBeLessThanOrEqual(composerTop);

    // Dismissal hides the chip for this session without a gateway round trip.
    await mergedChip.locator(".chat-pr__dismiss").click();
    await expect.poll(() => chips.count()).toBe(1);
    await expect
      .poll(() => chips.first().locator(".chat-pr__number").textContent())
      .toBe("#103469");
  });
});
