import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
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

async function emitPullRequestSnapshot(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  sessionKey: string,
): Promise<void> {
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
          {
            additions: 72,
            branch: "steipete/session-hovercard-unify",
            changedFiles: 4,
            checks: { state: "pending", passed: 8, failed: 0, skipped: 0, running: 5 },
            deletions: 12,
            number: 418,
            owner: "openclaw",
            repo: "openclaw",
            state: "draft",
            title: "Follow-up polish",
            url: "https://github.com/openclaw/openclaw/pull/418",
          },
          {
            additions: 14,
            branch: "steipete/session-hovercard-unify",
            changedFiles: 2,
            checks: { state: "failing", passed: 10, failed: 2, skipped: 0, running: 0 },
            deletions: 21,
            number: 419,
            owner: "openclaw",
            repo: "openclaw",
            state: "closed",
            title: "Accessibility follow-up",
            url: "https://github.com/openclaw/openclaw/pull/419",
          },
          {
            additions: 83,
            branch: "steipete/session-hovercard-unify",
            changedFiles: 6,
            checks: { state: "passing", passed: 18, failed: 0, skipped: 1, running: 0 },
            deletions: 29,
            number: 420,
            owner: "openclaw",
            repo: "openclaw",
            state: "merged",
            title: "Merged hovercard follow-up",
            url: "https://github.com/openclaw/openclaw/pull/420",
          },
          {
            branch: "steipete/session-hovercard-unify",
            number: 421,
            owner: "openclaw",
            repo: "openclaw",
            state: "open",
            title: "Hidden by summary",
            url: "https://github.com/openclaw/openclaw/pull/421",
          },
        ],
        rateLimited: false,
        status: "ready",
      },
    },
  });
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    {
      open: async (_page: Page, row: Locator) => {
        await row.locator("[data-session-menu]").click();
      },
      source: "More",
    },
    {
      open: async (_page: Page, row: Locator) => {
        await row.click({ button: "right" });
      },
      source: "context menu",
    },
    {
      open: async (page: Page, row: Locator) => {
        await row.locator(".sidebar-recent-session__link").focus();
        await page.keyboard.press("Shift+F10");
      },
      source: "keyboard",
    },
  ])("dismisses the session hovercard before opening its menu from $source", async ({ open }) => {
    const selectedSessionKey = "agent:main:selected-menu";
    const sessionKey = "agent:main:hovered-menu";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": { card: null },
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
                label: "Hovered session",
                updatedAt: 1,
              },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        const trigger = row.locator("[data-session-menu]");
        const card = page.locator(".session-progress-hovercard");
        const menu = page.getByRole("menu", { name: "Actions for Hovered session" });
        await row.waitFor({ state: "visible" });
        await row.hover();
        await card.waitFor({ state: "visible" });

        await open(page, row);

        await menu.waitFor({ state: "visible" });
        await expect.poll(() => card.count()).toBe(0);
        await expect.poll(() => menu.isVisible()).toBe(true);
        await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      },
    );
  });

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
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
        });
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          presenceUsers: [
            { self: true, id: "profile-self", name: "You" },
            { id: "profile-mira", name: "Mira" },
            { id: "profile-riley", name: "Riley" },
            { id: "profile-ada", name: "Ada King" },
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
                createdAt: now - 89 * 24 * 60 * 60_000,
                key: sessionKey,
                kind: "direct",
                label: "Other session",
                displayName: "Other session",
                participants: [
                  { type: "human", id: "profile-ada", label: "Ada King" },
                  { type: "human", id: "profile-self", label: "You" },
                  { type: "human", id: "profile-mira", label: "Mira" },
                  { type: "human", id: "profile-riley", label: "Riley" },
                ],
                participantCount: 6,
                startedAt: now - 89 * 24 * 60 * 60_000,
                updatedAt: now - 21 * 24 * 60 * 60_000,
                worktree: {
                  id: "wt-hovercard-proof",
                  branch: "feature/session-hovercards",
                  repoRoot: "/work/openclaw",
                },
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
        await waitForPullRequestSubscription(gateway, sessionKey);
        await emitPullRequestSnapshot(gateway, sessionKey);

        await card.waitFor({ state: "visible" });
        expect(["left", "right"]).toContain(await card.getAttribute("data-side"));
        await expect
          .poll(() => card.locator(".session-hovercard__title").textContent())
          .toBe("Other session");
        await expect
          .poll(() => card.locator(".session-progress-card__heading").textContent())
          .toContain("1/3");
        await expect.poll(() => card.locator(".session-hovercard__pr-row").count()).toBe(4);
        await captureProof(page, "sidebar-row-hovercard-maximum.png");
        await expect
          .poll(() => card.locator(".session-hovercard__identity-row").textContent())
          .toContain("Ada King");
        expect(await card.locator(".session-hovercard__identity-row").textContent()).toContain(
          "Mira",
        );
        expect(await card.locator(".session-hovercard__identity-row").textContent()).not.toContain(
          "You",
        );
        expect(await card.locator(".session-hovercard__context-text").allTextContents()).toEqual([
          "openclaw",
          "feature/session-hovercards",
        ]);
        await expect
          .poll(() => card.locator(".session-hovercard__created-age").textContent())
          .toBe("3mo");
        const avatar = card.locator("openclaw-viewer-avatar.session-hovercard__creator-avatar");
        await avatar.waitFor({ state: "visible" });
        await expect
          .poll(async () => (await avatar.locator(".viewer-avatar").textContent())?.trim())
          .toBe("AK");
        expect(await card.locator("openclaw-channel-avatar").count()).toBe(0);
        const pullRequest = card.locator(".session-hovercard__pr-row").first();
        await expect
          .poll(() => pullRequest.locator(".session-hovercard__pr-number").textContent())
          .toBe("#417");
        expect(
          await pullRequest.locator(".session-hovercard__pr-state-icon").getAttribute("title"),
        ).toBe("Open · CI checks passing");
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
        expect(
          await card
            .locator(
              ".session-progress-card__step--completed .session-progress-card__step-marker svg",
            )
            .count(),
        ).toBe(1);
        expect(
          await card
            .locator(
              ".session-progress-card__step--in_progress .session-progress-card__step-marker .session-run-spinner",
            )
            .count(),
        ).toBe(1);
        expect(
          await card
            .locator(
              ".session-progress-card__step--pending .session-progress-card__step-marker polyline",
            )
            .count(),
        ).toBe(1);
        const markerPresentation = await card
          .locator(".session-progress-card__step-marker")
          .evaluateAll((markers) =>
            markers.slice(1).map((marker) => ({
              color: getComputedStyle(marker).color,
              dot: getComputedStyle(marker, "::after").content,
              spinnerAnimation:
                marker.querySelector(".session-run-spinner") instanceof HTMLElement
                  ? getComputedStyle(marker.querySelector(".session-run-spinner") as HTMLElement)
                      .animationName
                  : null,
              spinnerColor:
                marker.querySelector(".session-run-spinner") instanceof HTMLElement
                  ? getComputedStyle(marker.querySelector(".session-run-spinner") as HTMLElement)
                      .borderTopColor
                  : null,
            })),
          );
        expect(markerPresentation[0]?.dot).toBe("none");
        expect(markerPresentation[0]?.spinnerAnimation).toBe("session-run-spin");
        expect(markerPresentation[0]?.spinnerColor).toBe(markerPresentation[1]?.color);
        expect(markerPresentation[1]?.dot).toBe("none");
        expect(await card.locator(".session-hovercard__progress-footer:last-child").count()).toBe(
          1,
        );
        expect(await page.evaluate(() => "__progressCardPwned" in window)).toBe(false);
        await captureProof(page, "sidebar-row-hovercard-avatar.png");
        await captureProof(page, "sidebar-row-hovercard-progress.png");

        const link = page.locator(
          `.chat-thread a.markdown-session-link[data-session-key="${sessionKey}"]`,
        );
        await link.waitFor({ state: "visible" });
        await expect.poll(() => link.textContent()).toBe("Other session");
        expect(await link.getAttribute("href")).toBe("/chat/main/other-session");
        await link.hover();
        await card.waitFor({ state: "visible" });
        await waitForPullRequestSubscription(gateway, sessionKey);
        await emitPullRequestSnapshot(gateway, sessionKey);
        await expect
          .poll(async () =>
            ["bottom", "top"].includes((await card.getAttribute("data-side")) ?? ""),
          )
          .toBe(true);
        await expect
          .poll(() => card.locator(".session-hovercard__title").textContent())
          .toBe("Other session");
        await expect
          .poll(() => card.locator(".session-hovercard__pr-number").first().textContent())
          .toBe("#417");
        await expect.poll(() => card.locator("strong").textContent()).toContain("Building");
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

  it("honors cold, bridge, sweep, and menu-suppression timing on real sidebar rows", async () => {
    const selectedSessionKey = "agent:main:timing-selected";
    const firstSessionKey = "agent:main:timing-first";
    const secondSessionKey = "agent:main:timing-second";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              { key: selectedSessionKey, kind: "direct", label: "Selected", updatedAt: 3 },
              { key: firstSessionKey, kind: "direct", label: "First timing row", updatedAt: 2 },
              { key: secondSessionKey, kind: "direct", label: "Second timing row", updatedAt: 1 },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const first = page.locator(`[data-session-key="${firstSessionKey}"]`);
        const second = page.locator(`[data-session-key="${secondSessionKey}"]`);
        const card = page.locator(".session-progress-hovercard");
        await first.waitFor({ state: "visible" });
        expect(
          await page.evaluate(
            () => customElements.get("openclaw-session-progress-hovercard-provider") === undefined,
          ),
        ).toBe(true);

        const pointer = async (
          locator: typeof first,
          type: "pointerover" | "pointerout",
          coordinates: { clientX?: number; clientY?: number } = {},
        ) =>
          locator.dispatchEvent(type, {
            bubbles: true,
            composed: true,
            ...coordinates,
            pointerType: "mouse",
            relatedTarget: null,
          });

        await first.hover();
        expect(await card.count()).toBe(0);
        await page.waitForTimeout(300);
        expect(await card.count()).toBe(0);
        await card.waitFor({ state: "visible" });
        const firstBounds = await first.boundingBox();
        expect(firstBounds).not.toBeNull();
        const cardBounds = await card.boundingBox();
        expect(cardBounds).not.toBeNull();
        await pointer(first, "pointerout", {
          clientX: (firstBounds?.x ?? 0) + (firstBounds?.width ?? 0),
          clientY: (firstBounds?.y ?? 0) + (firstBounds?.height ?? 0) / 2,
        });
        await page.waitForTimeout(150);
        expect(await card.count()).toBe(1);
        await page.mouse.move(
          (cardBounds?.x ?? 0) + (cardBounds?.width ?? 0) / 2,
          (cardBounds?.y ?? 0) + (cardBounds?.height ?? 0) / 2,
        );
        expect(await card.count()).toBe(1);
        await page.mouse.move(900, 800);
        await page.waitForTimeout(50);
        expect(await card.count()).toBe(1);
        await expect.poll(() => card.count()).toBe(0);
        await page.waitForTimeout(300);

        await first.hover();
        await first.locator("a.sidebar-recent-session__link").focus();
        await card.waitFor({ state: "visible" });
        await expect
          .poll(() => card.locator(".session-hovercard__title").textContent())
          .toBe("First timing row");
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        await page.mouse.move(900, 800);
        await page.waitForTimeout(300);

        await first.hover();
        expect(await card.count()).toBe(0);
        await card.waitFor({ state: "visible" });

        await second.hover();
        await page.waitForTimeout(40);
        expect(await card.locator(".session-hovercard__title").textContent()).toBe(
          "First timing row",
        );
        await expect
          .poll(() => card.locator(".session-hovercard__title").textContent())
          .toBe("Second timing row");

        await card.hover();
        expect(await card.count()).toBe(1);
        await page.mouse.move(900, 800);
        await expect.poll(() => card.count()).toBe(0);
        await page.waitForTimeout(300);

        await first.hover();
        await card.waitFor({ state: "visible" });
        await first
          .getByRole("button", { name: "Open session menu: First timing row" })
          .dispatchEvent("click");
        await expect.poll(() => card.count()).toBe(0);
        await expect
          .poll(() => page.locator("openclaw-session-menu").getByRole("menuitem").count())
          .toBeGreaterThan(0);
        await second.dispatchEvent("pointerover", { pointerType: "mouse" });
        await page.waitForTimeout(500);
        expect(await card.count()).toBe(0);
      },
    );
  });

  it("renders and dismisses synthetic catalog-session hovercards", async () => {
    const selectedSessionKey = "agent:main:catalog-selected";
    const catalogSessionKey = "catalog:codex:gateway%3Acodex:thread-1";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const nowSeconds = Math.floor(Date.now() / 1000);
        await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            "sessions.catalog.list",
          ],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              { key: selectedSessionKey, kind: "direct", label: "Selected", updatedAt: 1 },
            ]),
            "sessions.catalog.list": {
              catalogs: [
                {
                  id: "codex",
                  label: "Codex",
                  capabilities: { continueSession: true, archive: true },
                  hosts: [
                    {
                      hostId: "gateway:codex",
                      label: "Local Codex",
                      kind: "gateway",
                      connected: true,
                      sessions: [
                        {
                          threadId: "thread-1",
                          name: "Catalog release review",
                          cwd: "/work/openclaw",
                          gitBranch: "catalog-hovercard",
                          createdAt: nowSeconds - 2 * 60 * 60,
                          updatedAt: nowSeconds - 5 * 60,
                          status: "stored",
                          archived: false,
                          canContinue: true,
                          canArchive: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(`[data-session-key="${catalogSessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.hover();
        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        expect(await card.locator(".session-hovercard__title").textContent()).toBe(
          "Catalog release review",
        );
        expect(await card.locator(".session-hovercard__created-age").textContent()).toBe("2 hr");
        expect(await card.locator(".session-hovercard__context-text").allTextContents()).toEqual([
          "openclaw",
          "catalog-hovercard",
        ]);

        await row.getByRole("button", { name: "Open session menu" }).dispatchEvent("click");
        await expect.poll(() => card.count()).toBe(0);
        await expect
          .poll(() => page.locator("openclaw-catalog-session-menu").getByRole("menuitem").count())
          .toBeGreaterThan(0);
        await page
          .locator(`[data-session-key="${selectedSessionKey}"]`)
          .dispatchEvent("pointerover", { pointerType: "mouse" });
        await page.waitForTimeout(500);
        expect(await card.count()).toBe(0);
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
        await expect
          .poll(() => card.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
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
        await gateway.setMethodResponse("progressCard.get", {
          cases: [
            { match: { sessionKey: selectedSessionKey }, response: { card: null } },
            {
              match: { sessionKey },
              response: {
                card: {
                  markdown: "Updated build: [Open build log](https://example.com/build)",
                  revision: 2,
                  sessionKey,
                  updatedAt: 2,
                },
              },
            },
          ],
        });
        await gateway.emitGatewayEvent("progressCard.changed", { revision: 2, sessionKey });
        await expect.poll(() => card.textContent()).toContain("Updated build");
        await expect
          .poll(() => page.locator(":focus").getAttribute("href"))
          .toBe("https://example.com/build");
        await gateway.setMethodResponse("progressCard.get", {
          cases: [
            { match: { sessionKey: selectedSessionKey }, response: { card: null } },
            {
              match: { sessionKey },
              response: {
                card: {
                  markdown: "Updated build complete",
                  revision: 3,
                  sessionKey,
                  updatedAt: 3,
                },
              },
            },
          ],
        });
        await gateway.emitGatewayEvent("progressCard.changed", { revision: 3, sessionKey });
        await expect.poll(() => card.textContent()).toContain("Updated build complete");
        expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(await card.count()).toBe(1);
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(await trigger.getAttribute("aria-haspopup")).toBeNull();
        expect(await trigger.getAttribute("aria-expanded")).toBeNull();
        await captureProof(page, "keyboard-focus.png");
      },
    );
  });

  it("shows the latest turn and authenticates channel avatars", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:no-progress-card";
    const avatarSessionKey = "agent:main:channel-avatar";
    const channelAvatarUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(sessionKey)}`;
    const successfulChannelAvatarUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(avatarSessionKey)}`;
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
        await page.route(`**${channelAvatarUrl}`, async (route) => {
          expect(await route.request().headerValue("authorization")).toBe(
            "Bearer e2e-device-token",
          );
          await route.fulfill({ status: 404 });
        });
        await page.route(`**${successfulChannelAvatarUrl}`, async (route) => {
          expect(await route.request().headerValue("authorization")).toBe(
            "Bearer e2e-device-token",
          );
          await route.fulfill({
            body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#64748b"/><text x="32" y="40" fill="white" font-size="24" text-anchor="middle">A</text></svg>`,
            contentType: "image/svg+xml",
            status: 200,
          });
        });
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
                channelAvatarUrl,
                createdActor: { type: "human", id: "profile-ada", label: "Ada King" },
                key: sessionKey,
                kind: "direct",
                label: "No progress card",
                displayName: "No progress card",
                lastMessagePreview,
                updatedAt: now - 5 * 60_000,
              },
              {
                channelAvatarUrl: successfulChannelAvatarUrl,
                createdActor: { type: "human", id: "profile-ada", label: "Ada King" },
                key: avatarSessionKey,
                kind: "direct",
                label: "Channel avatar",
                updatedAt: now - 6 * 60_000,
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
        expect(["left", "right"]).toContain(await card.getAttribute("data-side"));
        const avatar = card.locator("openclaw-channel-avatar.session-hovercard__creator-avatar");
        await expect
          .poll(() => avatar.locator(".session-hovercard__creator-avatar-fallback").textContent())
          .toBe("AK");
        expect(await avatar.locator("img.channel-avatar").count()).toBe(0);
        expect(await card.locator("openclaw-viewer-avatar").count()).toBe(0);
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

        const avatarRow = page.locator(
          `.sidebar-recent-session[data-session-key="${avatarSessionKey}"]`,
        );
        await avatarRow.hover();
        await expect
          .poll(() => card.locator(".session-hovercard__title").textContent())
          .toBe("Channel avatar");
        const successfulAvatar = card.locator(
          "openclaw-channel-avatar.session-hovercard__creator-avatar",
        );
        await expect.poll(() => successfulAvatar.locator("img.channel-avatar").count()).toBe(1);
        expect(
          await successfulAvatar
            .locator("img.channel-avatar")
            .evaluate((image: HTMLImageElement) => ({
              complete: image.complete,
              naturalHeight: image.naturalHeight,
              naturalWidth: image.naturalWidth,
            })),
        ).toEqual({ complete: true, naturalHeight: 64, naturalWidth: 64 });
        await captureProof(page, "sidebar-row-hovercard-last-turn.png");
      },
    );
  });
});
