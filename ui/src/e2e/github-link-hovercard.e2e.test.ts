// Control UI tests cover GitHub link hover card behavior.
import { chromium, type Browser, type BrowserContext, type Locator } from "playwright";
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

async function expectText(locator: Locator, text: string): Promise<void> {
  await expect.poll(() => locator.textContent()).toContain(text);
}

describeControlUiE2e("GitHub link hover cards", () => {
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

  it("previews issue and pull request links while preserving navigation", async () => {
    const context = await newBrowserContext();
    await context.route("https://github.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>GitHub item</title>",
      }),
    );

    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "controlUi.githubPreview": {
          cases: [
            {
              match: { kind: "pull", number: 99816 },
              response: {
                additions: 101,
                avatarDataUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
                changedFiles: 3,
                closedAt: "2026-07-04T09:53:52Z",
                createdAt: "2026-07-04T05:03:47Z",
                deletions: 12,
                draft: false,
                kind: "pull",
                login: "steipete",
                mergedAt: "2026-07-04T09:53:52Z",
                number: 99816,
                owner: "openclaw",
                repo: "openclaw",
                state: "closed",
                title: "fix(agents): derive conversation scope from trusted group facts",
                updatedAt: "2026-07-04T09:53:55Z",
              },
            },
            {
              match: { kind: "issue", number: 99815 },
              response: {
                avatarDataUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
                comments: 4,
                createdAt: "2026-07-05T08:00:00Z",
                kind: "issue",
                login: "octocat",
                number: 99815,
                owner: "openclaw",
                repo: "openclaw",
                state: "open",
                title: "Keep hover previews compact",
                updatedAt: new Date().toISOString(),
              },
            },
            {
              match: { kind: "issue", number: 999999 },
              response: {},
            },
          ],
        },
      },
      historyMessages: [
        {
          content: [
            {
              type: "text",
              text: [
                "Review [#99816](https://github.com/openclaw/openclaw/pull/99816),",
                "then [#99815](https://github.com/openclaw/openclaw/issues/99815).",
                "A [missing item](https://github.com/openclaw/openclaw/issues/999999) stays usable.",
                "The [repository](https://github.com/openclaw/openclaw) has no item preview.",
              ].join(" "),
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    await page.goto(`${server.baseUrl}chat`);

    const pullLink = page.getByRole("link", { name: "#99816" });
    await pullLink.hover();
    const card = page.locator(".github-link-hovercard");
    await expectText(card, "Merged");
    await expectText(card, "openclaw/openclaw #99816");
    await expectText(card, "+101");
    await expectText(card, "−12");
    await expectText(card, "3 files");
    await expect.poll(() => card.locator("img").count()).toBe(1);
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(1);
    const pullBox = await card.boundingBox();
    expect(pullBox).not.toBeNull();
    expect(pullBox!.x).toBeGreaterThanOrEqual(0);
    expect(pullBox!.y).toBeGreaterThanOrEqual(0);
    expect(pullBox!.x + pullBox!.width).toBeLessThanOrEqual(1180);
    expect(pullBox!.y + pullBox!.height).toBeLessThanOrEqual(800);

    const issueLink = page.getByRole("link", { name: "#99815" });
    await issueLink.hover();
    await expectText(card, "Keep hover previews compact");
    await expectText(card, "octocat");
    await expectText(card, "4 comments");
    await expect.poll(() => card.locator("img").count()).toBe(1);
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(2);

    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
    await issueLink.hover();
    await expectText(card, "4 comments");
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(2);

    await page.mouse.move(1, 1);
    await page.getByRole("link", { name: "repository" }).hover();
    await page.clock.runFor(300);
    await expect.poll(() => card.count()).toBe(0);

    const missingLink = page.getByRole("link", { name: "missing item" });
    await missingLink.hover();
    await expectText(card, "GitHub preview unavailable");
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(3);
    expect(await missingLink.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/issues/999999",
    );
    await page.mouse.move(1, 1);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
    await pullLink.hover();
    await expectText(card, "Merged");
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(3);
    await page.mouse.move(1, 1);

    await pullLink.focus();
    await expectText(card, "Merged");
    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    await expect
      .poll(() => pullLink.evaluate((element) => element === document.activeElement))
      .toBe(true);

    const popupPromise = page.waitForEvent("popup");
    await pullLink.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe("https://github.com/openclaw/openclaw/pull/99816");
  });
});
