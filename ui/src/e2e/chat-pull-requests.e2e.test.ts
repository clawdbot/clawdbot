// Control UI tests cover session pull request chips above the chat composer.
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
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
// Browser contexts preserve test isolation; keep one process warm for this file.
let browser: Browser;
const openContexts = new Set<BrowserContext>();

async function newBrowserContext(): Promise<BrowserContext> {
  const context = await browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
  openContexts.add(context);
  return context;
}

async function closeContexts(): Promise<void> {
  await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
  openContexts.clear();
}

async function waitForWatchedSessionKey(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
): Promise<string> {
  let watchedKey = "";
  await expect
    .poll(async () => {
      const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
      for (const request of requests.toReversed()) {
        const params = request.params;
        if (!params || typeof params !== "object" || !("sessionKeys" in params)) {
          continue;
        }
        const keys = (params as { sessionKeys?: unknown }).sessionKeys;
        if (Array.isArray(keys) && typeof keys[0] === "string") {
          watchedKey = keys[0];
          break;
        }
      }
      return watchedKey;
    })
    .not.toBe("");
  return watchedKey;
}

describeControlUiE2e("session pull request chips", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterAll(async () => {
    await closeContexts();
    await browser?.close();
    await server?.close();
  });

  afterEach(closeContexts);

  it("pins detected PR chips above the composer with rate-limit staleness", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      },
    });
    await page.goto(`${server.baseUrl}chat`);
    const watchedKey = await waitForWatchedSessionKey(gateway);
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: {
        [watchedKey]: {
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
          status: "rate-limited",
        },
      },
    });

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
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.diff",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.diff": {
          sessionKey: "main",
          root: "/tmp/checkout",
          branch: "claude/cloud-workers-live-events",
          baseRef: "main",
          files: [
            {
              path: "src/app.ts",
              status: "modified",
              additions: 2819,
              deletions: 205,
              patch: "@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
          additions: 2819,
          deletions: 205,
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);
    const watchedKey = await waitForWatchedSessionKey(gateway);
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: {
        [watchedKey]: {
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
          status: "rate-limited",
        },
      },
    });

    const row = page.locator('.chat-pr[data-state="branch"]');
    await expect.poll(() => row.count()).toBe(1);
    await expect.poll(() => row.locator(".chat-pr__repo").textContent()).toBe("openclaw");
    await expect
      .poll(() => row.locator(".chat-pr__branch").textContent())
      .toBe("claude/cloud-workers-live-events");
    // Locale-formatted diff stats, sized like the PR the branch would open.
    await expect.poll(() => row.locator(".chat-pr__additions").textContent()).toBe("+2,819");
    await expect.poll(() => row.locator(".chat-pr__deletions").textContent()).toBe("−205");
    const diffMarker = row.getByRole("button", { name: "Show session changes" });
    await expect.poll(() => diffMarker.count()).toBe(1);
    await diffMarker.click();
    await expect.poll(() => page.locator(".session-diff").count()).toBe(1);
    await expect.poll(() => page.locator(".session-diff__filename").textContent()).toBe("app.ts");
    // While rate limited "no PR found" is unreliable, so the warning shows.
    await expect.poll(() => row.locator(".chat-pr__warning").count()).toBe(1);
    const create = row.locator(".chat-pr__create");
    await expect.poll(() => create.textContent()).toContain("Create PR");
    await expect
      .poll(() => create.getAttribute("href"))
      .toBe("https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events");
    // No dismiss control: the row reflects the checkout itself.
    await expect.poll(() => row.locator(".chat-pr__dismiss").count()).toBe(0);

    // The row shares the composer's centered width; it is part of the input
    // stack, not a full-pane banner.
    const rowBox = await page.locator(".chat-prs").boundingBox();
    const composerBox = await page.locator(".agent-chat__composer-shell").boundingBox();
    expect(rowBox && composerBox).toBeTruthy();
    if (rowBox && composerBox) {
      expect(Math.abs(rowBox.width - composerBox.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(rowBox.x - composerBox.x)).toBeLessThanOrEqual(1);
    }
  });
});
