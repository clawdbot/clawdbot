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
): Promise<void> {
  await expect
    .poll(async () => {
      const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
      return requests.some((request) => {
        const sessionKeys = isRecord(request.params) ? request.params.sessionKeys : undefined;
        return Array.isArray(sessionKeys) && sessionKeys.includes(sessionKey);
      });
    })
    .toBe(true);
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders safe progress markdown and refreshes the hovered card after a change event", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:selected";
    const sessionKey = "agent:main:other-session";
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
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          historyMessages: [
            {
              role: "assistant",
              timestamp: now - 30 * 60_000,
              content: [{ type: "text", text: `Follow progress in ${sessionKey}.` }],
            },
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
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
                label: "Other session",
                displayName: "Other session",
                startedAt: now - 2 * 60 * 60_000,
                updatedAt: now - 15 * 60_000,
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
        expect(await card.count()).toBe(0);
        expect(
          (await gateway.getRequests("progressCard.get")).filter(
            (request) => isRecord(request.params) && request.params.sessionKey === sessionKey,
          ),
        ).toHaveLength(0);

        const link = page.locator(
          `.chat-thread a.markdown-session-link[data-session-key="${sessionKey}"]`,
        );
        await link.waitFor({ state: "visible" });
        await expect.poll(() => link.textContent()).toBe("Other session");
        expect(await link.getAttribute("href")).toBe("/chat/main/other-session");
        await link.hover();

        await waitForPullRequestSubscription(gateway, sessionKey);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [sessionKey]: {
              pullRequests: [
                {
                  additions: 128,
                  branch: "steipete/session-hovercard-unify",
                  changedFiles: 7,
                  checks: { state: "passing", passed: 24, failed: 0, skipped: 2, running: 0 },
                  deletions: 34,
                  number: 417,
                  owner: "openclaw",
                  repo: "openclaw",
                  state: "open",
                  title: "Restore the session hovercard",
                  url: "https://github.com/openclaw/openclaw/pull/417",
                },
              ],
              rateLimited: false,
              status: "ready",
            },
          },
        });

        await card.waitFor({ state: "visible" });
        expect(["bottom", "top"]).toContain(await card.getAttribute("data-side"));
        await expect
          .poll(() => card.locator(".session-hovercard__title").textContent())
          .toBe("Other session");
        await expect
          .poll(() => card.locator(".session-hovercard__meta").textContent())
          .toContain("Ada King");
        const pullRequest = card.locator(".session-hovercard__pr-chip");
        await expect
          .poll(() => pullRequest.locator(".session-hovercard__pr-number").textContent())
          .toBe("#417");
        expect(await pullRequest.locator(".session-hovercard__checks").textContent()).toBe("✓");
        expect(await pullRequest.locator(".session-hovercard__files").textContent()).toBe(
          "7 files",
        );
        expect(await pullRequest.locator(".session-hovercard__additions").textContent()).toBe(
          "+128",
        );
        expect(await pullRequest.locator(".session-hovercard__deletions").textContent()).toBe(
          "−34",
        );
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
        await captureProof(page, "chat-link-hovercard-progress.png");

        await gateway.deferNext("progressCard.get", { sessionKey });
        await gateway.emitGatewayEvent("progressCard.changed", { revision: 2, sessionKey });
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("progressCard.get")).filter(
                (request) => isRecord(request.params) && request.params.sessionKey === sessionKey,
              ).length,
          )
          .toBe(2);
        await gateway.rejectDeferred("progressCard.get", {
          code: "UNAVAILABLE",
          message: "temporary refresh failure",
          retryable: true,
        });
        await expect.poll(() => card.locator("strong").textContent()).toContain("Building");
        await expect.poll(() => card.locator("progress").getAttribute("value")).toBe("3");

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
                  updatedAt: now,
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
          .toBe(3);
        await captureProof(page, "hovercard-updated.png");
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
          historyMessages: [
            {
              role: "assistant",
              timestamp: 1,
              content: [{ type: "text", text: `Open ${sessionKey} for the build log.` }],
            },
          ],
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
        const trigger = page.locator(
          `.chat-thread a.markdown-session-link[data-session-key="${sessionKey}"]`,
        );
        const card = page.locator(".session-progress-hovercard");
        await trigger.waitFor({ state: "visible" });
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

  it("shows the latest turn when the session has no progress card", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:no-progress-card";
    const lastMessagePreview =
      "The final release notes are ready for review, including <strong>plain text</strong>, rollout details, verification notes, compatibility guidance, and a concise operator checklist.";

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
          historyMessages: [
            {
              role: "assistant",
              timestamp: now - 10 * 60_000,
              content: [{ type: "text", text: `No card yet for ${sessionKey}.` }],
            },
          ],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "No progress card",
                displayName: "No progress card",
                lastMessagePreview,
                updatedAt: now - 5 * 60_000,
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
        expect(await page.locator(".session-progress-hovercard").count()).toBe(0);

        const link = page.locator(
          `.chat-thread a.markdown-session-link[data-session-key="${sessionKey}"]`,
        );
        await link.waitFor({ state: "visible" });
        await expect.poll(() => link.textContent()).toBe("No progress card");
        expect(await link.getAttribute("href")).toBe("/chat/main/no-progress-card");
        expect(await link.getAttribute("title")).toBe(sessionKey);
        await link.hover();
        await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        await expect
          .poll(() => card.locator(".session-hovercard__excerpt").textContent())
          .toBe(lastMessagePreview);
        expect(await card.locator(".session-hovercard__excerpt strong").count()).toBe(0);
        expect(await card.locator(".session-progress-card").count()).toBe(0);
        expect(
          await card
            .locator(".session-hovercard__excerpt")
            .evaluate((element) => getComputedStyle(element).webkitLineClamp),
        ).toBe("2");
        await captureProof(page, "chat-link-hovercard-last-turn.png");
      },
    );
  });
});
