import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-progress-hovercard",
);

async function captureProof(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

async function waitForPullRequestSubscription(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  sessionKey: string,
): Promise<string> {
  await expect
    .poll(async () => {
      const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
      return requests.some((request) => {
        const sessionKeys = isRecord(request.params) ? request.params.sessionKeys : undefined;
        return Array.isArray(sessionKeys) && sessionKeys.includes(sessionKey);
      });
    })
    .toBe(true);
  return sessionKey;
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders safe progress markdown and refreshes the hovered card after a change event", async () => {
    const selectedSessionKey = "agent:main:selected";
    const sessionKey = "agent:main:building-release";
    const initialMarkdown = [
      "**Building** phase 2",
      "",
      '<progress value="3" max="7"></progress>',
      "",
      "| step | state |",
      "| --- | --- |",
      "| tests | green |",
      "",
      '<span onclick="window.__progressCardPwned = true">unsafe</span>',
      "<script>window.__progressCardPwned = true</script>",
    ].join("\n");

    await suite.withPage(
      {
        colorScheme: "dark",
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": {
              cases: [
                {
                  match: { sessionKey: selectedSessionKey },
                  response: { card: null },
                },
                {
                  match: { sessionKey },
                  response: {
                    card: {
                      markdown: initialMarkdown,
                      revision: 1,
                      sessionKey,
                      steps: [
                        { step: "Inspect", status: "completed" },
                        { step: "Package", status: "in_progress" },
                        { step: "Publish", status: "pending" },
                      ],
                      updatedAt: 1,
                    },
                  },
                },
              ],
            },
            "sessions.list": chatSessionListResponse([
              {
                key: selectedSessionKey,
                kind: "direct",
                label: "Selected session",
                updatedAt: 3,
              },
              {
                key: sessionKey,
                kind: "direct",
                label: "Building release",
                updatedAt: 2,
              },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);

        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.hover();

        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        await expect.poll(() => card.locator("strong").textContent()).toContain("Building");

        const progress = card.locator("progress");
        await expect.poll(() => progress.getAttribute("value")).toBe("3");
        expect(await progress.getAttribute("max")).toBe("7");
        expect(await card.locator("table").count()).toBe(1);
        expect(await card.getByRole("cell", { name: "tests" }).count()).toBe(1);
        expect(await card.getByRole("cell", { name: "green" }).count()).toBe(1);
        expect(await card.locator("script").count()).toBe(0);
        expect(await card.locator("[onclick]").count()).toBe(0);
        expect(await card.textContent()).not.toContain("progressCardPwned");
        await expect
          .poll(() => card.locator(".session-progress-card__heading").textContent())
          .toContain("1/3");
        await expect
          .poll(() => card.locator(".session-progress-card__step--completed").textContent())
          .toContain("Inspect");
        await expect
          .poll(() => card.locator(".session-progress-card__step--in_progress").textContent())
          .toContain("Package");
        await expect
          .poll(() => card.locator(".session-progress-card__step--pending").textContent())
          .toContain("Publish");
        expect(await page.evaluate(() => "__progressCardPwned" in window)).toBe(false);
        await captureProof(page, "sidebar-hovercard-open.png");

        await gateway.setMethodResponse("progressCard.get", {
          cases: [
            { match: { sessionKey: selectedSessionKey }, response: { card: null } },
            {
              match: { sessionKey },
              response: {
                card: {
                  markdown: '**Packaging** phase 3\n\n<progress value="6" max="7"></progress>',
                  revision: 2,
                  sessionKey,
                  steps: [
                    { step: "Inspect", status: "completed" },
                    { step: "Package", status: "completed" },
                    { step: "Publish", status: "in_progress" },
                  ],
                  updatedAt: 2,
                },
              },
            },
          ],
        });
        await gateway.emitGatewayEvent("progressCard.changed", { revision: 2, sessionKey });

        await expect.poll(() => card.textContent()).toContain("Packaging");
        await expect.poll(() => card.locator("progress").getAttribute("value")).toBe("6");
        await expect
          .poll(() => card.locator(".session-progress-card__heading").textContent())
          .toContain("2/3");
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("progressCard.get")).filter(
                (request) => isRecord(request.params) && request.params.sessionKey === sessionKey,
              ).length,
          )
          .toBe(2);
        await captureProof(page, "hovercard-updated.png");
      },
    );
  });

  it("renders owner, pull request, diff, and progress details in one hovercard", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:selected-pr-hovercard";
    const sessionKey = "agent:main:release-hovercard";
    const pullRequestUrl = "https://github.com/openclaw/openclaw/pull/417";

    await suite.withPage(
      {
        colorScheme: "dark",
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "progressCard.get": {
              cases: [
                { match: { sessionKey: selectedSessionKey }, response: { card: null } },
                {
                  match: { sessionKey },
                  response: {
                    card: {
                      markdown: "**Release candidate** is ready for review.",
                      revision: 1,
                      sessionKey,
                      steps: [
                        { step: "Implement", status: "completed" },
                        { step: "Verify", status: "completed" },
                        { step: "Land", status: "in_progress" },
                      ],
                      updatedAt: now - 15 * 60_000,
                    },
                  },
                },
              ],
            },
            "sessions.list": chatSessionListResponse([
              {
                key: selectedSessionKey,
                kind: "direct",
                label: "Selected session",
                updatedAt: now - 5 * 60_000,
              },
              {
                createdActor: { type: "human", id: "profile-ada", label: "Ada King" },
                key: sessionKey,
                kind: "direct",
                label: "Release hovercard polish",
                startedAt: now - 2 * 60 * 60_000,
                updatedAt: now - 15 * 60_000,
              },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.hover();

        const watchedKey = await waitForPullRequestSubscription(gateway, sessionKey);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [watchedKey]: {
              pullRequests: [
                {
                  additions: 128,
                  branch: "steipete/session-hovercard-pr-chips",
                  changedFiles: 7,
                  checks: { state: "passing", passed: 24, failed: 0, skipped: 2, running: 0 },
                  deletions: 34,
                  number: 417,
                  owner: "openclaw",
                  repo: "openclaw",
                  state: "open",
                  title: "feat(ui): show PR details in the session hovercard",
                  url: pullRequestUrl,
                },
              ],
              rateLimited: false,
              status: "ready",
            },
          },
        });

        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        const header = card.locator(".session-hovercard__header");
        await expect
          .poll(() => header.locator(".session-hovercard__avatar").textContent())
          .toBe("AK");
        await expect
          .poll(() => header.locator(".session-hovercard__title").textContent())
          .toBe("Release hovercard polish");
        await expect
          .poll(() => header.locator(".session-hovercard__meta").textContent())
          .toContain("Ada King");
        await expect
          .poll(() => header.locator(".session-hovercard__meta").textContent())
          .toContain("created 2h ago");
        await expect
          .poll(() => header.locator(".session-hovercard__meta").textContent())
          .toContain("updated 15m ago");

        const pullRequest = card.locator(".session-hovercard__pr-chip");
        await expect.poll(() => pullRequest.getAttribute("href")).toBe(pullRequestUrl);
        expect(await pullRequest.getAttribute("data-state")).toBe("open");
        expect(await pullRequest.locator(".session-hovercard__pr-number").textContent()).toBe(
          "#417",
        );
        expect(await pullRequest.locator(".session-hovercard__pr-state").textContent()).toBe(
          "Open",
        );
        const checks = pullRequest.locator(".session-hovercard__checks");
        expect(await checks.textContent()).toBe("✓");
        expect(await checks.getAttribute("aria-label")).toBe("CI checks passing");
        const diff = pullRequest.locator(".session-hovercard__diff");
        expect(await diff.locator(".session-hovercard__files").textContent()).toBe("7 files");
        expect(await diff.locator(".session-hovercard__additions").textContent()).toBe("+128");
        expect(await diff.locator(".session-hovercard__deletions").textContent()).toBe("−34");

        const progress = card.locator(".session-progress-card");
        await expect.poll(() => progress.textContent()).toContain("Release candidate");
        expect(await progress.locator(".session-progress-card__heading").textContent()).toContain(
          "2/3",
        );
        const pullRequestBox = await pullRequest.boundingBox();
        const progressBox = await progress.boundingBox();
        expect(pullRequestBox && progressBox).toBeTruthy();
        expect(progressBox?.y).toBeGreaterThan(pullRequestBox?.y ?? 0);
        await captureProof(page, "hovercard-pr-chips.png");
      },
    );
  });

  it("renders branch diff details and a no-PR link", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:branch-hovercard";
    const createUrl =
      "https://github.com/openclaw/openclaw/compare/main...steipete:openclaw:session-hovercard-branch?expand=1";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              {
                createdActor: { type: "human", id: "profile-zoe", label: "Zoe Chen" },
                key: sessionKey,
                kind: "direct",
                label: "Branch ready for PR",
                startedAt: now - 2 * 60 * 60_000,
                updatedAt: now - 8 * 60_000,
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.hover();

        const watchedKey = await waitForPullRequestSubscription(gateway, sessionKey);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [watchedKey]: {
              branch: {
                additions: 42,
                branch: "steipete/session-hovercard-branch",
                changedFiles: 3,
                createUrl,
                deletions: 9,
                owner: "openclaw",
                repo: "openclaw",
              },
              pullRequests: [],
              rateLimited: false,
              status: "ready",
            },
          },
        });

        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        const branch = card.locator(".session-hovercard__branch-chip");
        await expect
          .poll(() => branch.textContent())
          .toContain("openclaw/openclaw · steipete/session-hovercard-branch");
        const diff = card.locator(".session-hovercard__diff");
        expect(await diff.locator(".session-hovercard__files").textContent()).toBe("3 files");
        expect(await diff.locator(".session-hovercard__additions").textContent()).toBe("+42");
        expect(await diff.locator(".session-hovercard__deletions").textContent()).toBe("−9");
        const noPullRequest = card.getByRole("link", { name: "No PR yet" });
        expect(await noPullRequest.getAttribute("href")).toBe(createUrl);
        expect(await noPullRequest.getAttribute("target")).toBe("_blank");
        await captureProof(page, "hovercard-branch-no-pr.png");
      },
    );
  });

  it("keeps the portaled progress dialog keyboard-reachable and viewport-contained", async () => {
    const selectedSessionKey = "agent:main:selected-focus";
    const sessionKey = "agent:main:focusable-progress";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": {
              cases: [
                { match: { sessionKey: selectedSessionKey }, response: { card: null } },
                {
                  match: { sessionKey },
                  response: {
                    card: {
                      markdown: "[Open build log](https://example.com/build)",
                      revision: 1,
                      sessionKey,
                      updatedAt: 1,
                    },
                  },
                },
              ],
            },
            "sessions.list": chatSessionListResponse([
              {
                key: selectedSessionKey,
                kind: "direct",
                label: "Selected session",
                updatedAt: 2,
              },
              {
                key: sessionKey,
                kind: "direct",
                label: "Focusable progress",
                updatedAt: 1,
              },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        const trigger = row.locator(".sidebar-recent-session__link");
        const card = page.locator(".session-progress-hovercard");
        // Let pointer intent finish the one-time lazy upgrade before asserting
        // the runtime's distinct keyboard-focus policy.
        await row.hover();
        await card.waitFor({ state: "visible" });
        await page.mouse.move(1270, 890);
        await expect.poll(() => card.count()).toBe(0);
        await trigger.focus();
        expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("progressCard.get")).filter(
                (request) => isRecord(request.params) && request.params.sessionKey === sessionKey,
              ).length,
          )
          .toBe(1);

        await card.waitFor({ state: "visible" });
        expect(await card.getAttribute("role")).toBe("dialog");
        expect(await trigger.getAttribute("aria-haspopup")).toBe("dialog");
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(await trigger.getAttribute("aria-controls")).toBe(await card.getAttribute("id"));
        const box = await card.boundingBox();
        expect(box).not.toBeNull();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect(box?.y).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1280);
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900);

        await page.keyboard.press("Tab");
        await expect
          .poll(() => page.locator(":focus").getAttribute("href"))
          .toBe("https://example.com/build");
        await captureProof(page, "keyboard-focus.png");
      },
    );
  });

  it("opens session details when the session has no progress card", async () => {
    const sessionKey = "agent:main:no-progress-card";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "No progress card",
                updatedAt: 1,
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        expect(await row.getAttribute("title")).toBeNull();
        expect(await row.locator(".sidebar-recent-session__link").getAttribute("title")).toBeNull();
        await row.hover();

        await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        await expect.poll(() => card.textContent()).toContain("No progress card");
        expect(await card.locator(".session-progress-card").count()).toBe(0);
      },
    );
  });

  it("does not mount an empty card when no source has session information", async () => {
    const selectedSessionKey = "agent:main:selected-empty";
    const unknownSessionKey = "agent:main:not-in-sidebar-registry";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              {
                key: selectedSessionKey,
                kind: "direct",
                label: "Selected session",
                updatedAt: 1,
              },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        await page
          .locator(`.sidebar-recent-session[data-session-key="${selectedSessionKey}"]`)
          .waitFor({ state: "visible" });
        await page.evaluate(
          (keys) => {
            const source = document.querySelector<HTMLElement>(
              `[data-session-key="${keys.selectedSessionKey}"]`,
            );
            if (!source) {
              return;
            }
            const target = source.cloneNode(true);
            if (!(target instanceof HTMLElement)) {
              return;
            }
            target.dataset.sessionKey = keys.unknownSessionKey;
            target.dataset.emptyHovercardTarget = "true";
            source.after(target);
          },
          { selectedSessionKey, unknownSessionKey },
        );

        await page.locator("[data-empty-hovercard-target]").hover();
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("progressCard.get")).filter(
                (request) =>
                  isRecord(request.params) && request.params.sessionKey === unknownSessionKey,
              ).length,
          )
          .toBe(1);
        await expect.poll(() => page.locator(".session-progress-hovercard").count()).toBe(0);
      },
    );
  });
});
