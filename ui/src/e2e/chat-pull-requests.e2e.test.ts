// Control UI tests cover session pull request chips above the chat composer.
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  sharedPublisher,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let publicationProofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    publicationProofDir = createControlUiE2eArtifactDir("github-publication");
  }
});
let stackingProofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    stackingProofDir = createControlUiE2eArtifactDir("pr-chip-stacking");
  }
});

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

async function expectPullRequestChipOnTop(page: Page): Promise<void> {
  const chip = page.locator(".chat-pr").first();
  await chip.waitFor();
  const uncovered = await chip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const sampleY = Math.min(bounds.bottom - 1, bounds.top + 10);
    return [0.2, 0.5, 0.8].every((ratio) => {
      const sampleX = bounds.left + bounds.width * ratio;
      return document.elementFromPoint(sampleX, sampleY)?.closest(".chat-pr") === element;
    });
  });
  expect(uncovered).toBe(true);
}

async function overlapLastTranscriptRowWithPullRequestChip(page: Page): Promise<void> {
  const row = page.locator(".chat-virtual-row").last();
  const chip = page.locator(".chat-pr").first();
  await row.waitFor();
  await chip.waitFor();
  await page.evaluate(() => {
    const rows = document.querySelectorAll<HTMLElement>(".chat-virtual-row");
    const rowElement = rows.item(rows.length - 1);
    const chipElement = document.querySelector<HTMLElement>(".chat-pr");
    if (!rowElement || !chipElement) {
      throw new Error("Expected a virtual transcript row and pull request chip");
    }
    const paintedRow = rowElement.querySelector<HTMLElement>(".chat-bubble") ?? rowElement;
    const paintedBounds = paintedRow.getBoundingClientRect();
    const chipBounds = chipElement.getBoundingClientRect();
    rowElement.style.top = `${chipBounds.top + 24 - paintedBounds.bottom}px`;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

function publicationRequestKey(params: unknown): string {
  if (
    !params ||
    typeof params !== "object" ||
    !("idempotencyKey" in params) ||
    typeof params.idempotencyKey !== "string"
  ) {
    throw new Error("Expected publication request to carry an idempotency key");
  }
  return params.idempotencyKey;
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

  it.each([
    { label: "desktop", viewport: { width: 1180, height: 800 } },
    { label: "mobile", viewport: { width: 393, height: 852 } },
  ])(
    "keeps the PR chip above an underlapping transcript on $label",
    async ({ label, viewport }) => {
      const context = await browser.newContext({
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
      });
      openContexts.add(context);
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
        historyMessages: Array.from({ length: 25 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Transcript row ${index + 1}: paint-order regression fixture.`,
          timestamp: index + 1,
        })),
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
                number: 123456,
                owner: "openclaw",
                repo: "openclaw",
                branch: "fix/pr-chip-stacking",
                title: "Keep the PR chip above the transcript",
                url: "https://github.com/openclaw/openclaw/pull/123456",
                state: "open",
              },
            ],
            rateLimited: false,
            status: "ok",
          },
        },
      });

      await overlapLastTranscriptRowWithPullRequestChip(page);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(stackingProofDir, `${label}.png`),
        });
      }
      await expectPullRequestChipOnTop(page);
    },
  );

  it("offers a Publish PR row with the stale warning while rate limited pre-PR", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "sessions.github.publish",
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
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
    // While rate limited "no PR found" is unreliable, so the warning shows.
    await expect.poll(() => row.locator(".chat-pr__warning").count()).toBe(1);
    const create = row.locator(".chat-pr__create");
    await expect.poll(() => create.textContent()).toContain("Publish PR");
    await expect.poll(() => create.getAttribute("href")).toBeNull();
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

  it("publishes through the Gateway and renders the terminal pull request URL", async () => {
    const context = await browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1180 },
      ...(captureUiProof
        ? { recordVideo: { dir: publicationProofDir, size: { width: 1180, height: 800 } } }
        : {}),
    });
    openContexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "sessions.github.publish",
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
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
            branch: "openclaw/reconciled-publication",
            additions: 42,
            deletions: 7,
          },
          rateLimited: false,
          status: "ok",
        },
      },
    });

    await gateway.deferNext("sessions.github.publish");
    const publish = page.getByRole("button", { name: "Publish PR" });
    await publish.waitFor();
    await publish.click();
    const request = await gateway.waitForRequest("sessions.github.publish");
    expect(request.params).toMatchObject({
      sessionKey: "agent:main:main",
      selection: { source: "shared", expected: sharedPublisher },
    });
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @system-bot");
    await expect
      .poll(() => page.getByRole("combobox", { name: "Publication account" }).count())
      .toBe(0);
    expect(request.params).not.toHaveProperty("title");
    expect(JSON.stringify(request.params)).not.toContain("token");
    expect(request.params).not.toHaveProperty("repository");
    await expect
      .poll(() => page.getByRole("button", { name: "Publishing…" }).isDisabled())
      .toBe(true);
    if (captureUiProof) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(publicationProofDir, "01-publication-pending.png"),
      });
    }

    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "publication-1",
      publisher: sharedPublisher,
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125200",
      repository: "openclaw/openclaw",
      branch: "openclaw/reconciled-publication",
      headCommit: "a".repeat(40),
    });
    const open = page.getByRole("link", { name: "Open PR" });
    await open.waitFor();
    await expect
      .poll(() => open.getAttribute("href"))
      .toBe("https://github.com/openclaw/openclaw/pull/125200");
    if (captureUiProof) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(publicationProofDir, "02-publication-published.png"),
      });
    }

    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: {
        [watchedKey]: {
          pullRequests: [
            {
              number: 125200,
              owner: "openclaw",
              repo: "openclaw",
              branch: "openclaw/reconciled-publication",
              title: "Publish reconciled work",
              url: "https://github.com/openclaw/openclaw/pull/125200",
              state: "merged",
            },
          ],
          branch: {
            owner: "openclaw",
            repo: "openclaw",
            branch: "openclaw/reconciled-publication",
            additions: 3,
            deletions: 0,
            createUrl:
              "https://github.com/openclaw/openclaw/pull/new/openclaw/reconciled-publication",
          },
          rateLimited: false,
          status: "ok",
        },
      },
    });
    await expect.poll(() => page.getByRole("button", { name: "Publish PR" }).count()).toBe(1);
    await expect.poll(() => page.getByRole("link", { name: "Open PR" }).count()).toBe(0);
  });

  it("drops a deferred publication result after switching to another publishing session", async () => {
    const sessionA = "agent:main:publication-a";
    const sessionB = "agent:main:publication-b";
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "sessions.github.publish",
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.list": {
          count: 2,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            { key: sessionA, kind: "direct", label: "Publication A", updatedAt: 2 },
            { key: sessionB, kind: "direct", label: "Publication B", updatedAt: 1 },
          ],
          ts: 1,
        },
      },
      sessionKey: sessionA,
    });
    await page.goto(controlUiSessionUrl(server.baseUrl, sessionA));
    await waitForWatchedSessionKey(gateway);
    const publicationState = (branch: string) => ({
      pullRequests: [],
      branch: {
        owner: "openclaw",
        repo: "openclaw",
        branch,
        additions: 2,
        deletions: 1,
      },
      rateLimited: false,
      status: "ok",
    });
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [sessionA]: publicationState("openclaw/publication-a") },
    });

    await gateway.deferNext("sessions.github.publish", { sessionKey: sessionA });
    const requestCountA = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Publish PR" }).click();
    const requestA = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCountA,
    });
    expect(requestA.params).toMatchObject({ sessionKey: sessionA });

    await navigateToControlUiSession(page, sessionB);
    await expect
      .poll(async () => {
        const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        return requests.some((request) => {
          const keys = (request.params as { sessionKeys?: unknown } | undefined)?.sessionKeys;
          return Array.isArray(keys) && keys.includes(sessionB);
        });
      })
      .toBe(true);
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [sessionB]: publicationState("openclaw/publication-b") },
    });
    await gateway.deferNext("sessions.github.publish", { sessionKey: sessionB });
    const requestCountB = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Publish PR" }).click();
    const requestB = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCountB,
    });
    expect(requestB.params).toMatchObject({ sessionKey: sessionB });
    const publishingB = page.getByRole("button", { name: "Publishing…" });
    await expect.poll(() => publishingB.isDisabled()).toBe(true);

    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "publication-a",
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125301",
      repository: "openclaw/openclaw",
      branch: "openclaw/publication-a",
      headCommit: "a".repeat(40),
    });
    await expect.poll(() => publishingB.isDisabled()).toBe(true);
    expect(
      await page.locator('a[href="https://github.com/openclaw/openclaw/pull/125301"]').count(),
    ).toBe(0);
    expect(await page.locator('.chat-pr__publication-outcome[data-state="failed"]').count()).toBe(
      0,
    );

    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "publication-b",
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125302",
      repository: "openclaw/openclaw",
      branch: "openclaw/publication-b",
      headCommit: "b".repeat(40),
    });
    await expect
      .poll(() => page.getByRole("link", { name: "Open PR" }).getAttribute("href"))
      .toBe("https://github.com/openclaw/openclaw/pull/125302");
  });

  it("renders a typed publication failure and its next action", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "sessions.github.publish",
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.publish": {
          requestId: "publication-failed",
          publisher: sharedPublisher,
          status: "failed",
          code: "push_rejected",
          message: "GitHub publication failed.",
          nextAction: "Check repository write access and retry.",
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
            branch: "openclaw/rejected-publication",
            additions: 2,
            deletions: 1,
            createUrl:
              "https://github.com/openclaw/openclaw/pull/new/openclaw/rejected-publication",
          },
          rateLimited: false,
          status: "ok",
        },
      },
    });

    await page.getByRole("button", { name: "Publish PR" }).click();
    const failure = page.locator('.chat-pr__publication-outcome[data-state="failed"]');
    await expect.poll(() => failure.textContent()).toContain("GitHub publication failed.");
    await expect.poll(() => failure.textContent()).toContain("Check repository write access");
    await expect
      .poll(() => page.getByRole("button", { name: "Choose a new publication" }).count())
      .toBe(1);
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @system-bot");
    expect(
      await page
        .getByRole("link", { name: "Create a pull request for openclaw/rejected-publication" })
        .count(),
    ).toBe(0);
    if (captureUiProof) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(publicationProofDir, "03-publication-failed.png"),
      });
    }
  });

  it("reuses the publication key after an unknown outcome and rotates it after failure", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const terminalFailure = {
      requestId: "publication-failed",
      publisher: sharedPublisher,
      status: "failed",
      code: "push_rejected",
      message: "GitHub publication failed.",
      nextAction: "Check repository write access and retry.",
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "sessions.github.publish",
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.publish": terminalFailure,
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
            branch: "openclaw/retry-publication",
            additions: 2,
            deletions: 1,
          },
          rateLimited: false,
          status: "ok",
        },
      },
    });

    await gateway.deferNext("sessions.github.publish");
    let requestCount = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Publish PR" }).click();
    const first = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCount,
    });
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Publication response was lost.",
    });
    await expect
      .poll(() => page.getByRole("button", { name: "Retry publication" }).count())
      .toBe(1);

    requestCount = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Retry publication" }).click();
    const second = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCount,
    });
    expect(publicationRequestKey(second.params)).toBe(publicationRequestKey(first.params));
    await expect
      .poll(() => page.getByRole("button", { name: "Choose a new publication" }).count())
      .toBe(1);

    requestCount = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Choose a new publication" }).click();
    await page.getByRole("button", { name: "Publish PR" }).click();
    const third = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCount,
    });
    expect(publicationRequestKey(third.params)).not.toBe(publicationRequestKey(second.params));
  });

  it("preserves explicit shared publication on a cloud-idle workspace", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "sessions.github.publish",
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.publish": {
          requestId: "cloud-publication",
          status: "requested",
          publisher: sharedPublisher,
          message: "Publication requested after workspace reconciliation.",
        },
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              contextTokens: null,
              displayName: "Main",
              hasActiveRun: false,
              key: "main",
              kind: "direct",
              label: "Main",
              model: "gpt-5.5",
              modelProvider: "openai",
              placement: { state: "active" },
              status: "done",
              totalTokens: 0,
              updatedAt: 1,
            },
          ],
          ts: 1,
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
            branch: "openclaw/cloud-idle",
            additions: 2,
            deletions: 1,
          },
          rateLimited: false,
          status: "ok",
        },
      },
    });

    await expect
      .poll(() => page.getByRole("button", { name: "Publish PR" }).isEnabled())
      .toBe(true);
    await expect
      .poll(() => page.locator(".chat-pr__publication-outcome").textContent())
      .toContain("My GitHub requires an idle, reconciled local workspace");
    await page.getByRole("button", { name: "Publish PR" }).click();
    const request = await gateway.waitForRequest("sessions.github.publish");
    expect(request.params).toMatchObject({
      selection: { source: "shared", expected: sharedPublisher },
    });
    await expect
      .poll(() => page.locator(".chat-pr__publication-outcome").textContent())
      .toContain("Publication requested after workspace reconciliation.");
    if (captureUiProof) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(publicationProofDir, "04-cloud-idle-guidance.png"),
      });
    }
  });
});
