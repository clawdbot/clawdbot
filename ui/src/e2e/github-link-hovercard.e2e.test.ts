// Control UI tests cover GitHub link hover card behavior.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";

let artifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  artifactDir = parent ? createControlUiE2eArtifactDir("github-link-hovercard", parent) : undefined;
});
import {
  canRunPlaywrightChromium,
  installMockGateway,
  pauseVirtualClock,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
let browser: Browser;

async function newBrowserContext(): Promise<BrowserContext> {
  return browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
}

async function closeContexts(): Promise<void> {
  const [first, ...remaining] = browser?.contexts() ?? [];
  await runQaGatewayFixture(
    async () => {
      await first?.close();
    },
    ...remaining.map((context) => () => context.close()),
  );
}

async function expectText(locator: Locator, text: string): Promise<void> {
  await expect.poll(() => locator.textContent()).toContain(text);
}

async function captureArtifact(target: Page | Locator, name: string): Promise<void> {
  if (!artifactDir) {
    return;
  }
  await target.screenshot({ path: path.join(artifactDir, `${name}.png`) });
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

const PULL_HREF = "https://github.com/openclaw/openclaw/pull/99816";
const PULL_COMMENT_HREF = `${PULL_HREF}#issuecomment-123`;

// Shared page setup for lifecycle cases and cached permalink navigation.
async function openPullPreviewPage(deferPreview = false): Promise<{
  card: Locator;
  commentLink: Locator;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
  page: Page;
  pullLink: Locator;
}> {
  const context = await newBrowserContext();
  await context.route("https://github.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Synthetic GitHub destination</title>
        <h1>Synthetic GitHub destination</h1><pre id="destination"></pre>
        <script>document.getElementById("destination").textContent = location.href;</script>`,
    }),
  );

  const page = await context.newPage();
  await page.clock.install();
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
          {
            type: "text",
            text: `Review ${PULL_HREF}, then [the review comment](${PULL_COMMENT_HREF}).`,
          },
        ],
        role: "assistant",
        timestamp: Date.now(),
      },
    ],
  });
  await page.goto(`${server.baseUrl}chat`);

  const pullLink = page.locator('a.markdown-github-link[href$="/pull/99816"]');
  const commentLink = page.getByRole("link", { name: "the review comment", exact: true });
  const card = page.locator(".github-link-hovercard");
  await pullLink.waitFor({ state: "visible" });
  return { card, commentLink, gateway, page, pullLink };
}

describeControlUiE2e("GitHub link hover cards", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await runQaGatewayFixture(
      closeContexts,
      () => browser?.close(),
      () => server?.close(),
    );
  });

  afterEach(closeContexts);

  it.each([
    { theme: "light", reducedMotion: "no-preference", width: 1180, fails: false },
    { theme: "light", reducedMotion: "no-preference", width: 1180, fails: true },
    { theme: "dark", reducedMotion: "no-preference", width: 1180, fails: false },
    { theme: "dark", reducedMotion: "reduce", width: 390, fails: true },
  ] as const)(
    "shimmers while pending ($theme, $reducedMotion, $width, fails=$fails)",
    async (scenario) => {
      const { card, gateway, page, pullLink } = await openPullPreviewPage(true);
      await page.emulateMedia({
        colorScheme: scenario.theme,
        reducedMotion: scenario.reducedMotion,
      });
      await page.setViewportSize({ width: scenario.width, height: 800 });
      await pullLink.focus();
      const request = await gateway.waitForRequest("controlUi.githubPreview");
      expect(request.params).toMatchObject({ agentId: "main" });

      await expect.poll(() => card.getAttribute("aria-label")).toBe("Loading GitHub details…");
      const skeleton = card.locator('[aria-hidden="true"]');
      await skeleton.waitFor({ state: "visible" });
      expect(await card.locator("a").count()).toBe(0);
      expect((await card.textContent())?.trim()).toBe("");
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
        const error = "GitHub API rate limit exceeded (HTTP 403). Try again in 2 minutes.";
        await gateway.rejectDeferred("controlUi.githubPreview", { message: error });
        await expectText(card, "GitHub preview unavailable");
        const detail = card.locator(".github-link-hovercard__error");
        await expectText(detail, error);
        expect(await card.getAttribute("aria-describedby")).toBe(await detail.getAttribute("id"));
        expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await captureArtifact(card, "github-hovercard-error-subtext");
      } else {
        await gateway.resolveDeferred("controlUi.githubPreview");
        await expectText(card, pullPreviewResponse.title);
      }
      expect(await card.locator(".skeleton").count()).toBe(0);
      expect(await card.getAttribute("aria-label")).not.toBe("Loading GitHub details…");
    },
  );

  it("reloads a dismissed pending preview on rehover and caches the successful response", async () => {
    const proofDir =
      artifactDir ?? createControlUiE2eArtifactDir("github-link-hovercard-cancellation");
    const { card, gateway, page, pullLink } = await openPullPreviewPage(true);

    await pullLink.hover();
    await gateway.waitForRequest("controlUi.githubPreview");
    await expect.poll(() => card.getAttribute("aria-label")).toBe("Loading GitHub details…");
    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);

    await pullLink.hover();
    await card.waitFor({ state: "visible" });
    // The abandoned response arrives after rehover; a fresh request must own
    // the rendered result, and the retired response must not poison its cache.
    await gateway.resolveDeferred("controlUi.githubPreview");
    await expect.poll(() => card.getAttribute("data-loading")).toBe("false");
    // Capture the settled state even when the title assertion below fails.
    await page.screenshot({
      path: path.join(proofDir, "github-hovercard-cancellation-rehover.png"),
    });
    await expectText(card, pullPreviewResponse.title);
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(2);

    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
    await pullLink.hover();
    await expectText(card, pullPreviewResponse.title);
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(2);
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
    // Let preview response timers finish before freezing the pointer's grace.
    await pauseVirtualClock(page);
    const linkBox = await pullLink.boundingBox();
    expect(linkBox).not.toBeNull();
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    const below = (await card.getAttribute("data-side")) === "bottom";
    const linkEdgeY = below ? linkBox!.y + linkBox!.height : linkBox!.y;
    const cardEdgeY = below ? cardBox!.y : cardBox!.y + cardBox!.height;
    const gap = { x: linkBox!.x + linkBox!.width / 2, y: (linkEdgeY + cardEdgeY) / 2 };

    // Cross the actual top/bottom gap using native pointer events, then enter
    // the card just before the existing 120 ms dismissal deadline.
    await page.mouse.move(gap.x, gap.y);
    expect(
      await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        return target !== null && !target.closest("a.markdown-github-link, .github-link-hovercard");
      }, gap),
    ).toBe(true);
    await page.clock.runFor(119);
    expect(await card.count()).toBe(1);
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
    await page.clock.runFor(1_200);
    expect(await card.count()).toBe(1);
    await expectText(card, "openclaw/openclaw #99816");

    // Leaving both surfaces, with no click, still dismisses the card after the
    // traversal grace period.
    await page.mouse.move(1, 1);
    await page.clock.runFor(119);
    expect(await card.count()).toBe(1);
    await page.clock.runFor(1);
    expect(await card.count()).toBe(0);
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

  it("opens the current pull request permalink from cached card title and repo links", async () => {
    const proofDir =
      artifactDir ?? createControlUiE2eArtifactDir("github-link-hovercard-navigation");
    const { card, commentLink, gateway, page, pullLink } = await openPullPreviewPage();

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

    for (const { state, anchor, href } of [
      { state: "base", anchor: pullLink, href: PULL_HREF },
      { state: "cached-comment", anchor: commentLink, href: PULL_COMMENT_HREF },
    ]) {
      const observations = [];
      for (const clickedLink of ["title", "repo"]) {
        await anchor.hover();
        await expectText(card, pullPreviewResponse.title);
        const actual = {
          titleHref: await card.locator(".github-link-hovercard__title").getAttribute("href"),
          repoHref: await card.locator(".github-link-hovercard__repo").getAttribute("href"),
          authorHref: await card.locator(".github-link-hovercard__author").getAttribute("href"),
          requestCount: (await gateway.getRequests("controlUi.githubPreview")).length,
        };
        const stage = `${state}-${clickedLink}`;
        await page.screenshot({ path: path.join(proofDir, `${stage}-card.png`) });
        const popupPromise = page.waitForEvent("popup");
        await card.locator(`.github-link-hovercard__${clickedLink}`).click();
        const popup = await popupPromise;
        await popup.waitForLoadState("domcontentloaded");
        const observation = {
          state,
          clickedLink,
          actual: { ...actual, popupHref: popup.url() },
          expected: {
            titleHref: href,
            repoHref: href,
            authorHref: "https://github.com/steipete",
            requestCount: 1,
            popupHref: href,
          },
        };
        await popup.screenshot({ path: path.join(proofDir, `${stage}-popup.png`) });
        await writeFile(path.join(proofDir, `${stage}.json`), JSON.stringify(observation, null, 2));
        observations.push(observation);

        // A pointer-opened card still dismisses after its clicked link gains focus.
        await popup.close();
        await page.mouse.move(1, 1);
        await expect.poll(() => card.count()).toBe(0);
      }
      // Retain both actual destinations before failing on a lost comment hash.
      for (const { actual, expected, clickedLink } of observations) {
        expect(actual.popupHref, `${state} ${clickedLink} navigation`).toBe(expected.popupHref);
        expect(actual).toEqual(expected);
      }
    }
    expect((await gateway.getRequests("controlUi.githubPreview")).length).toBe(1);
  });
});
