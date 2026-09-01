// Control UI tests cover GitHub link hover card behavior.
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";

let artifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  artifactDir = parent ? createControlUiE2eArtifactDir("github-link-hovercard", parent) : undefined;
});
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

async function captureArtifact(page: Page, name: string): Promise<void> {
  if (!artifactDir) {
    return;
  }
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
}

const pullPreviewResponse = {
  additions: 101,
  coAuthorCount: 5,
  coAuthors: [
    {
      login: "roboclaw-bot",
      avatarDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
    },
    {
      login: "ada",
      avatarDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
    },
    {
      login: "mira",
      avatarDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
    },
  ],
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
};

// Shared page setup for the two pointer-lifecycle cases below: both only need
// a single previewable pull-request link, unlike the full walkthrough above.
async function openPullPreviewPage(deferPreview = false): Promise<{
  card: Locator;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
  page: Page;
  pullLink: Locator;
}> {
  const context = await newBrowserContext();
  await context.route("https://github.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>GitHub item</title>",
    }),
  );

  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    deferredMethods: deferPreview ? ["controlUi.githubPreview"] : [],
    methodResponses: {
      "controlUi.githubPreview": {
        cases: [{ match: { kind: "pull", number: 99816 }, response: pullPreviewResponse }],
      },
    },
    historyMessages: [
      {
        content: [
          { type: "text", text: "Review https://github.com/openclaw/openclaw/pull/99816." },
        ],
        role: "assistant",
        timestamp: Date.now(),
      },
    ],
  });
  await page.goto(`${server.baseUrl}chat`);

  const pullLink = page.locator('a.markdown-github-link[href$="/pull/99816"]');
  const card = page.locator(".github-link-hovercard");
  await pullLink.waitFor({ state: "visible" });
  return { card, gateway, page, pullLink };
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

  it.each([
    { theme: "light", reducedMotion: "no-preference", width: 1180, fails: false },
    { theme: "dark", reducedMotion: "no-preference", width: 1180, fails: false },
    { theme: "dark", reducedMotion: "reduce", width: 390, fails: true },
  ] as const)("shimmers while pending ($theme, $reducedMotion, $width)", async (scenario) => {
    const { card, gateway, page, pullLink } = await openPullPreviewPage(true);
    await page.emulateMedia({ colorScheme: scenario.theme, reducedMotion: scenario.reducedMotion });
    await page.setViewportSize({ width: scenario.width, height: 800 });
    await pullLink.focus();
    await gateway.waitForRequest("controlUi.githubPreview");

    await expect.poll(() => card.getAttribute("aria-label")).toBe("Loading GitHub details…");
    const skeleton = card.locator('[aria-hidden="true"]');
    await skeleton.waitFor({ state: "visible" });
    expect(await card.locator("a").count()).toBe(0);
    expect(await card.textContent()).toBe("");
    const placeholder = skeleton.locator(".skeleton").first();
    await placeholder.waitFor({ state: "visible" });
    const animating = () =>
      placeholder.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      );
    await expect.poll(animating).toBe(scenario.reducedMotion === "no-preference");
    const bounds = await card.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(scenario.width);

    if (scenario.fails) {
      await gateway.rejectDeferred("controlUi.githubPreview", { message: "Unavailable" });
      await expectText(card, "GitHub preview unavailable");
    } else {
      await gateway.resolveDeferred("controlUi.githubPreview");
      await expectText(card, pullPreviewResponse.title);
    }
    expect(await card.locator(".skeleton").count()).toBe(0);
    expect(await card.getAttribute("aria-label")).not.toBe("Loading GitHub details…");
  });

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
                "Review https://github.com/openclaw/openclaw/pull/99816,",
                "then https://github.com/openclaw/openclaw/issues/99815.",
                "A [missing item](https://github.com/openclaw/openclaw/issues/999999) stays usable.",
                "The [repository](https://github.com/openclaw/openclaw) has no item preview.",
                "The skill lives at https://github.com/blader/humanizer/blob/main/SKILL.md.",
                "Styling notes live in [the docs](https://docs.openclaw.ai/web/control-ui).",
              ].join(" "),
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
        {
          content: [
            {
              type: "text",
              text: "Narrow reference https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/99817",
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    await page.goto(`${server.baseUrl}chat`);

    const message = page.locator(".chat-text").filter({ hasText: "Review" });
    if (artifactDir) {
      await message.screenshot({ path: path.join(artifactDir, "github-references-light.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
      await message.screenshot({ path: path.join(artifactDir, "github-references-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
    }

    await expect
      .poll(() => page.getByRole("link", { name: "#99817" }).getAttribute("href"))
      .toBe(
        "https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/99817",
      );
    await expect
      .poll(() => page.getByRole("link", { name: "SKILL.md" }).getAttribute("href"))
      .toBe("https://github.com/blader/humanizer/blob/main/SKILL.md");

    const pullLink = page.locator('a.markdown-github-link[href$="/pull/99816"]');

    const decorationLine = (link: Locator) =>
      link.evaluate((element) => getComputedStyle(element).textDecorationLine);
    expect(await decorationLine(pullLink)).toBe("none");
    expect(await decorationLine(page.getByRole("link", { name: "the docs" }))).toBe("underline");

    await pullLink.hover();
    const card = page.locator(".github-link-hovercard");
    await expectText(card, "Merged");
    await expectText(card, "openclaw/openclaw #99816");
    await expectText(card, "+101");
    await expectText(card, "−12");
    expect(await card.getByText("3 files", { exact: true }).count()).toBe(0);
    expect(await card.locator(".github-link-hovercard__metric--files").count()).toBe(0);
    await page.clock.runFor(300);
    await captureArtifact(page, "github-hovercard-title-tooltip");
    await expect.poll(() => page.locator("openclaw-tooltip[open]").count()).toBe(0);
    expect(await pullLink.getAttribute("title")).toBe("");
    await expect.poll(() => card.locator("img").count()).toBe(1);
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(1);
    const pullBox = await card.boundingBox();
    expect(pullBox).not.toBeNull();
    expect(pullBox!.x).toBeGreaterThanOrEqual(0);
    expect(pullBox!.y).toBeGreaterThanOrEqual(0);
    expect(pullBox!.x + pullBox!.width).toBeLessThanOrEqual(1180);
    expect(pullBox!.y + pullBox!.height).toBeLessThanOrEqual(800);

    const issueLink = page.locator('a.markdown-github-link[href$="/issues/99815"]');
    await issueLink.hover();
    await expectText(card, "Keep hover previews compact");
    await expectText(card, "octocat");
    await expectText(card, "4 comments");
    await expect.poll(() => page.locator("openclaw-tooltip[open]").count()).toBe(0);
    await expect.poll(() => card.locator("img").count()).toBe(1);
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(2);

    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
    await issueLink.hover();
    await expectText(card, "4 comments");
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(2);

    await page.mouse.move(1, 1);
    await page.getByRole("link", { exact: true, name: "repository" }).hover();
    await page.clock.runFor(300);
    await expect.poll(() => card.count()).toBe(0);

    const fileLink = page.getByRole("link", { name: "SKILL.md" });
    await fileLink.hover();
    await expect
      .poll(() => page.locator("openclaw-tooltip[open]").textContent())
      .toContain("https://github.com/blader/humanizer/blob/main/SKILL.md");

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
    await expect.poll(() => page.locator("openclaw-tooltip[open]").count()).toBe(0);
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

  it("keeps the card open while the pointer crosses the gap onto it, then closes once it leaves both", async () => {
    const { card, page, pullLink } = await openPullPreviewPage();

    await pullLink.hover();
    await expectText(card, "openclaw/openclaw #99816");
    const linkBox = await pullLink.boundingBox();
    expect(linkBox).not.toBeNull();

    // Cross the physical gap with real intermediate pointer positions: off the
    // link, through the unowned strip below it, then onto the card body. Each
    // move is a fast CDP round trip, so the whole crossing lands comfortably
    // inside CLOSE_DELAY_MS (github-link-hovercard.runtime.ts); the card must
    // survive every step.
    await page.mouse.move(linkBox!.x + linkBox!.width / 2, linkBox!.y + linkBox!.height / 2);
    await page.mouse.move(linkBox!.x + linkBox!.width / 2, linkBox!.y + linkBox!.height + 5);
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + 4);
    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
    expect(await card.count()).toBe(1);
    const faces = card.locator(".github-link-hovercard__coauthors img");
    await expect.poll(() => faces.count()).toBe(3);
    await expect
      .poll(() => card.locator(".github-link-hovercard__coauthors-more").textContent())
      .toBe("+2");
    await captureArtifact(page, "github-hovercard-pointer-open");

    // Staying on the card holds it open regardless of elapsed time, mirroring
    // the unit test's ten-grace-window persistence check.
    await page.waitForTimeout(300);
    expect(await card.count()).toBe(1);
    await expectText(card, "openclaw/openclaw #99816");

    // Leaving both surfaces, with no click, still dismisses the card after the
    // traversal grace period.
    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
  });

  it("exposes the card as a dialog whose title link Tab reaches and Escape leaves", async () => {
    const { card, page, pullLink } = await openPullPreviewPage();

    await pullLink.focus();
    await expectText(card, "openclaw/openclaw #99816");
    // The real accessibility tree has to report a dialog, not a tooltip: the card
    // owns a link, which tooltip semantics may not contain.
    await expect.poll(() => page.getByRole("dialog").count()).toBe(1);
    await expect.poll(() => pullLink.getAttribute("aria-expanded")).toBe("true");
    await expect
      .poll(() => pullLink.getAttribute("aria-controls"))
      .toBe(await card.getAttribute("id"));

    // Tab enters the card at its first link and then walks the rest natively.
    const focused = () => page.evaluate(() => document.activeElement?.className ?? "");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("github-link-hovercard__repo");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("github-link-hovercard__title");
    await captureArtifact(page, "github-hovercard-keyboard-focus");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("github-link-hovercard__author");

    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    await expect
      .poll(() => pullLink.evaluate((element) => element === document.activeElement))
      .toBe(true);
    // Returning focus to the trigger must not reopen what Escape just dismissed.
    await page.waitForTimeout(300);
    expect(await card.count()).toBe(0);
  });

  it("opens the linked pull request when the card's title link is clicked", async () => {
    const { card, page, pullLink } = await openPullPreviewPage();

    await pullLink.hover();
    await expectText(card, "openclaw/openclaw #99816");
    const titleLink = card.locator(".github-link-hovercard__title");
    await expectText(titleLink, pullPreviewResponse.title);

    // The title owns the card's only underline; the other links stay quiet even
    // under the pointer, so the card keeps reading as a preview and not a menu.
    for (const quiet of ["repo", "author"]) {
      const link = card.locator(`.github-link-hovercard__${quiet}`);
      await link.hover();
      expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
    }
    await titleLink.hover();
    expect(await titleLink.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe(
      "underline",
    );

    // Mirrors the source-link popup assertion above: the title anchor reuses
    // the same validated href, target="_blank", and safe rel.
    const popupPromise = page.waitForEvent("popup");
    await titleLink.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe("https://github.com/openclaw/openclaw/pull/99816");

    // The click focused the title link inside the card; leaving the card still
    // dismisses it with no click-outside required (github-link-hovercard.runtime.ts
    // clears cardFocusInside for a pointer-opened card once the pointer leaves).
    await popup.close();
    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
  });
});
