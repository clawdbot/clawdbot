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
              checks: { state: "passing", passed: 65, failed: 0, skipped: 31, running: 0 },
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
            {
              number: 103200,
              owner: "openclaw",
              repo: "openclaw",
              branch: "claude/browser-tabs-web-ui-756a64",
              title: "feat(ui): earlier landing on the same branch",
              url: "https://github.com/openclaw/openclaw/pull/103200",
              state: "merged",
            },
          ],
          rateLimited: true,
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);

    // Three detected PRs collapse to two chips; merged history hides first.
    const chips = page.locator(".chat-pr");
    await expect.poll(() => chips.count()).toBe(2);
    const showMore = page.locator(".chat-prs__more");
    await expect.poll(() => showMore.textContent()).toContain("Show 1 more");

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

    // The CI pill opens the monitoring popover with per-state counts.
    await openChip.locator(".chat-pr__checks-pill").click();
    const menu = openChip.locator(".chat-pr__checks-menu");
    await expect
      .poll(() => menu.locator(".chat-pr__checks-row--passed").textContent())
      .toContain("65");
    await expect
      .poll(() => menu.locator(".chat-pr__checks-row--skipped").textContent())
      .toContain("31");
    await expect
      .poll(() => menu.locator("a").getAttribute("href"))
      .toBe("https://github.com/openclaw/openclaw/pull/103469/checks");
    // Clicking outside light-dismisses the popover.
    await page.locator(".chat-prs").click({ position: { x: 4, y: 4 } });
    await expect.poll(() => openChip.locator(".chat-pr__checks[open]").count()).toBe(0);

    // Show more reveals the collapsed merged chip.
    await showMore.click();
    await expect.poll(() => chips.count()).toBe(3);
    await expect.poll(() => showMore.count()).toBe(0);

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
    await expect.poll(() => chips.count()).toBe(2);
    await expect
      .poll(() => chips.first().locator(".chat-pr__number").textContent())
      .toBe("#103469");
  });

  it("offers a Create PR row with the stale warning while rate limited pre-PR", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "controlUi.sessionPullRequests"],
      methodResponses: {
        "controlUi.sessionPullRequests": {
          pullRequests: [],
          branch: {
            owner: "openclaw",
            repo: "openclaw",
            branch: "claude/cloud-workers-live-events",
            additions: 2819,
            deletions: 205,
            createUrl:
              "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
          },
          rateLimited: true,
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);

    const row = page.locator('.chat-pr[data-state="branch"]');
    await expect.poll(() => row.count()).toBe(1);
    await expect.poll(() => row.locator(".chat-pr__repo").textContent()).toBe("openclaw");
    await expect
      .poll(() => row.locator(".chat-pr__branch").textContent())
      .toBe("claude/cloud-workers-live-events");
    // Locale-formatted diff stats, sized like the PR the branch would open.
    await expect.poll(() => row.locator(".chat-pr__additions").textContent()).toBe("+2,819");
    await expect.poll(() => row.locator(".chat-pr__deletions").textContent()).toBe("−205");
    // While rate limited "no PR found" is unreliable, so the warning shows.
    await expect.poll(() => row.locator(".chat-pr__warning").count()).toBe(1);
    const create = row.locator(".chat-pr__create");
    await expect.poll(() => create.textContent()).toContain("Create PR");
    await expect
      .poll(() => create.getAttribute("href"))
      .toBe("https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events");
    // No dismiss control: the row reflects the checkout itself.
    await expect.poll(() => row.locator(".chat-pr__dismiss").count()).toBe(0);
  });
});
