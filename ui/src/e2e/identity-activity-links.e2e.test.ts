import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

let proofDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    proofDir = createControlUiE2eArtifactDir("identity-activity-links");
  }
});

async function captureProof(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens identity activity links and preserves pretty URLs through filters and reloads", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:identity-selected";
    const sessionKey = "agent:main:identity-hovered";
    const adaId = "a1b2c3d4-1234-4567-89ab-0123456789ab";
    const adaPath = "/activity/ada-king-a1b2c3d41234";
    const exactAdaPath = "/activity/ada-king-a1b2c3d41234456789ab0123456789ab";
    const missingId = "a1b2c3d4-1234-4567-89ab-0123456789ac";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const sessionList = {
          ...chatSessionListResponse([
            {
              key: selectedSessionKey,
              kind: "direct",
              label: "Selected session",
              updatedAt: now - 5 * 60_000,
            },
            {
              createdActor: {
                type: "human",
                id: adaId,
                identity: { type: "profile", id: adaId },
                label: "Ada King",
              },
              createdAt: now - 3 * 60 * 60_000,
              key: sessionKey,
              kind: "direct",
              label: "Ada's session",
              displayName: "Ada's session",
              owner: {
                actor: {
                  type: "human",
                  id: adaId,
                  identity: { type: "profile", id: adaId },
                  label: "Ada King",
                },
              },
              participants: [
                { identity: { type: "profile", id: adaId }, label: "Ada King" },
                { identity: { type: "profile", id: "profile-mira" }, label: "Mira" },
              ],
              participantCount: 2,
              updatedAt: now - 10 * 60_000,
            },
          ]),
          people: [
            {
              identity: { type: "profile", id: adaId },
              label: "Ada King",
              sessionCount: 1,
            },
            { identity: { type: "profile", id: "profile-mira" }, label: "Mira", sessionCount: 1 },
          ],
          peopleSessionCount: 2,
          peopleIncomplete: false,
        };
        const associatedSessions = sessionList.sessions.slice(1);
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            {
              self: true,
              id: "profile-self",
              identity: { type: "profile", id: "profile-self" },
              name: "You",
            },
            {
              id: adaId,
              identity: { type: "profile", id: adaId },
              name: "Ada King",
            },
          ],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": {
              cases: [
                {
                  match: { involvingProfileId: "a1b2c3d41234", search: "no-matching-sessions" },
                  response: {
                    ...sessionList,
                    involvingProfileId: adaId,
                    people: [],
                    sessions: [],
                    count: 0,
                    totalCount: 0,
                  },
                },
                ...[missingId, missingId.replaceAll("-", "")].map((involvingProfileId) => ({
                  match: { involvingProfileId },
                  response: { ...sessionList, people: [], sessions: [], count: 0, totalCount: 0 },
                })),
                ...[adaId, adaId.replaceAll("-", ""), "a1b2c3d41234", "profile-mira"].map(
                  (involvingProfileId) => ({
                    match: { involvingProfileId },
                    response: {
                      ...sessionList,
                      involvingProfileId:
                        involvingProfileId === "profile-mira" ? "profile-mira" : adaId,
                      sessions: associatedSessions,
                      count: 1,
                      totalCount: 1,
                    },
                  }),
                ),
                { response: sessionList },
              ],
            },
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        const card = page.locator(".session-progress-hovercard");
        await row.waitFor({ state: "visible" });
        await row.hover();
        await card.waitFor({ state: "visible" });

        await captureProof(page, "hovercard-identity-rest.png");
        const trigger = row.locator("a.sidebar-recent-session__link");
        const identity = card.locator("a.session-hovercard__attribution-name");
        const participant = card.locator("openclaw-viewer-facepile a.person-activity-avatar-link");
        await expect.poll(() => identity.textContent()).toBe("Ada King");
        expect(await identity.getAttribute("href")).toBe(adaPath);
        await expect
          .poll(async () =>
            (
              await card
                .locator(
                  ".session-hovercard__attribution-name, .session-hovercard__attribution-others",
                )
                .allTextContents()
            )
              .join(" ")
              .replace(/\s+/gu, " ")
              .trim(),
          )
          .toBe("Ada King & 1 other");
        await expect
          .poll(() => participant.locator(".viewer-avatar").getAttribute("aria-label"))
          .toBe("Mira");
        expect(await participant.getAttribute("href")).toBe("/activity/profile-mira");
        await identity.hover();
        expect(
          await identity.evaluate((element) => getComputedStyle(element).textDecorationLine),
        ).toBe("underline");
        await captureProof(page, "hovercard-identity-link.png");
        await participant.hover();
        await captureProof(page, "hovercard-participant-link.png");

        // The decorative avatar link stays out of the tab order; the name link is the target.
        await trigger.focus();
        await page.keyboard.press("Tab");
        expect(await identity.evaluate((element) => document.activeElement === element)).toBe(true);
        await identity.click();

        await waitForControlUiRoute(page, { pathname: adaPath, routeId: "activity", search: "" });
        await expect.poll(() => card.count()).toBe(0);
        const activityPage = page.locator("openclaw-activity-page");
        await expect
          .poll(() => activityPage.locator(`[data-activity-identity="${adaId}"]`).count())
          .toBe(1);
        await expect
          .poll(() => activityPage.locator(`[data-activity-session="${sessionKey}"]`).count())
          .toBe(1);
        expect(
          await activityPage.locator(`[data-activity-session="${selectedSessionKey}"]`).count(),
        ).toBe(0);
        expect(
          await page
            .locator(`.sidebar-recent-session[data-session-key="${selectedSessionKey}"]`)
            .count(),
        ).toBe(1);
        await captureProof(page, "hovercard-identity-activity.png");

        await page.goBack();
        await row.waitFor({ state: "visible" });
        await row.hover();
        await card.waitFor({ state: "visible" });
        await participant.click();
        await waitForControlUiRoute(page, {
          pathname: "/activity/profile-mira",
          routeId: "activity",
          search: "",
        });
        await expect
          .poll(() => activityPage.locator('[data-activity-identity="profile-mira"]').count())
          .toBe(1);
        await captureProof(page, "hovercard-participant-activity.png");

        await page.goto(new URL(adaPath, suite.server.baseUrl).href);
        await waitForControlUiRoute(page, { pathname: adaPath, routeId: "activity", search: "" });
        await expect
          .poll(() => activityPage.locator(`[data-activity-identity="${adaId}"]`).isVisible())
          .toBe(true);
        expect(await gateway.getRequests("sessions.list")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              params: expect.objectContaining({ involvingProfileId: "a1b2c3d41234" }),
            }),
          ]),
        );

        await activityPage.getByRole("button", { name: "Last 30 days", exact: true }).click();
        await waitForControlUiRoute(page, {
          pathname: adaPath,
          routeId: "activity",
          search: "?time=30d",
        });
        await activityPage.getByRole("searchbox").fill("Ada");
        const filterSearch = "?time=30d&q=Ada";
        await waitForControlUiRoute(page, {
          pathname: adaPath,
          routeId: "activity",
          search: filterSearch,
        });
        await page.reload();
        await waitForControlUiRoute(page, {
          pathname: adaPath,
          routeId: "activity",
          search: filterSearch,
        });
        await expect.poll(() => activityPage.getByRole("searchbox").inputValue()).toBe("Ada");
        await expect
          .poll(() => activityPage.locator(`[data-activity-identity="${adaId}"]`).isVisible())
          .toBe(true);
        expect(await gateway.getRequests("sessions.list")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              params: expect.objectContaining({
                involvingProfileId: "a1b2c3d41234",
                search: "Ada",
                activeMinutes: 43200,
              }),
            }),
          ]),
        );
        await captureProof(page, "pretty-person-activity-filters.png");

        await activityPage.getByRole("searchbox").fill("no-matching-sessions");
        await expect
          .poll(() => activityPage.locator(".activity-feed__empty").isVisible())
          .toBe(true);
        await page.reload();
        await expect
          .poll(() => activityPage.locator(".activity-feed__empty").isVisible())
          .toBe(true);
        await expect
          .poll(() => activityPage.locator(`[data-activity-identity="${adaId}"]`).isVisible())
          .toBe(true);
        expect(await activityPage.locator(".activity-feed__people-clear").isVisible()).toBe(true);
        expect(new URL(page.url()).pathname).toBe(adaPath);

        const legacyUrl = new URL(`/activity?person=${adaId}&time=30d&q=Ada`, suite.server.baseUrl);
        await page.goto(legacyUrl.href);
        await waitForControlUiRoute(page, {
          pathname: exactAdaPath,
          routeId: "activity",
          search: filterSearch,
        });
        await expect
          .poll(() => activityPage.locator(`[data-activity-session="${sessionKey}"]`).isVisible())
          .toBe(true);
        await activityPage.locator(".activity-feed__people-clear").click();
        await waitForControlUiRoute(page, {
          pathname: "/activity",
          routeId: "activity",
          search: filterSearch,
        });
        await expect.poll(() => activityPage.locator("[data-activity-identity]").count()).toBe(0);

        // An exact missing bookmark must never broaden into another person's shared prefix.
        const missingUrl = new URL(`/activity?person=${missingId}`, suite.server.baseUrl);
        await page.goto(missingUrl.href);
        await expect
          .poll(() => activityPage.getByText("Person not found", { exact: true }).isVisible())
          .toBe(true);
        expect(page.url()).toBe(missingUrl.href);
        await activityPage.getByRole("button", { name: "Last 30 days", exact: true }).click();
        await waitForControlUiRoute(page, {
          pathname: `/activity/${missingId.replaceAll("-", "")}`,
          routeId: "activity",
          search: "?time=30d",
        });
        await page.reload();
        await expect
          .poll(() => activityPage.getByText("Person not found", { exact: true }).isVisible())
          .toBe(true);
        expect(await activityPage.locator(`[data-activity-identity="${adaId}"]`).count()).toBe(0);
      },
    );
  });

  it("opens an activity feed from the chat header identities and a peer message author", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:shared-thread";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const sessionList = {
          ...chatSessionListResponse([
            {
              createdActor: {
                type: "human",
                id: "profile-ada",
                identity: { type: "profile", id: "profile-ada" },
                label: "Ada King",
              },
              createdAt: now - 3 * 60 * 60_000,
              key: sessionKey,
              kind: "direct",
              label: "Shared thread",
              displayName: "Shared thread",
              owner: {
                actor: {
                  type: "human",
                  id: "profile-ada",
                  identity: { type: "profile", id: "profile-ada" },
                  label: "Ada King",
                },
              },
              participants: [{ identity: { type: "profile", id: "profile-mira" }, label: "Mira" }],
              participantCount: 1,
              updatedAt: now - 60_000,
            },
          ]),
          people: [
            {
              identity: { type: "profile", id: "profile-ada" },
              label: "Ada King",
              sessionCount: 1,
            },
            { identity: { type: "profile", id: "profile-mira" }, label: "Mira", sessionCount: 1 },
          ],
          peopleSessionCount: 1,
          peopleIncomplete: false,
        };
        const associatedSessions = sessionList.sessions;
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            {
              self: true,
              id: "profile-self",
              identity: { type: "profile", id: "profile-self" },
              name: "You",
            },
            {
              id: "profile-ada",
              identity: { type: "profile", id: "profile-ada" },
              name: "Ada King",
            },
            { id: "profile-mira", identity: { type: "profile", id: "profile-mira" }, name: "Mira" },
          ],
          historyMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "Historical attribution stays display-only." }],
              timestamp: now - 180_000,
              // The same raw ID in a historical row is not profile provenance.
              __openclaw: {
                id: "legacy-ada-message",
                senderId: "profile-ada",
                senderName: "Historical Ada",
              },
            },
            {
              role: "user",
              content: [{ type: "text", text: "Handing this over." }],
              timestamp: now - 120_000,
              __openclaw: {
                id: "ada-message",
                senderId: "profile-ada",
                senderIdentity: { type: "profile", id: "profile-ada" },
                senderName: "Ada King",
              },
            },
          ],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": {
              cases: [
                ...["profile-ada", "profile-mira"].map((involvingProfileId) => ({
                  match: { involvingProfileId },
                  response: {
                    ...sessionList,
                    involvingProfileId,
                    sessions: associatedSessions,
                    count: 1,
                    totalCount: 1,
                  },
                })),
                { response: sessionList },
              ],
            },
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

        const ownerLink = page.locator(
          ".chat-pane__header a.person-activity-avatar-link:has(openclaw-session-owner-chip)",
        );
        await ownerLink.waitFor({ state: "visible" });
        expect(await ownerLink.getAttribute("href")).toBe("/activity/profile-ada");
        const participantLink = page.locator(
          ".chat-pane__participants a.person-activity-avatar-link",
        );
        expect(await participantLink.getAttribute("href")).toBe("/activity/profile-mira");

        const authorGroup = page.locator(".chat-group.user", { hasText: "Handing this over." });
        const author = authorGroup.locator("a.chat-sender-name");
        await author.waitFor({ state: "visible" });
        await expect.poll(() => author.textContent()).toBe("Ada King");
        expect(await author.getAttribute("href")).toBe("/activity/profile-ada");
        const legacyGroup = page.locator(".chat-group.user", {
          hasText: "Historical attribution stays display-only.",
        });
        await legacyGroup.locator(".chat-sender-name").waitFor({ state: "visible" });
        expect(await legacyGroup.locator(".chat-sender-name").textContent()).toBe("Historical Ada");
        expect(await legacyGroup.locator('a[href*="/activity/"]').count()).toBe(0);
        await captureProof(page, "chat-identity-links.png");

        await participantLink.click();
        await waitForControlUiRoute(page, {
          pathname: "/activity/profile-mira",
          routeId: "activity",
          search: "",
        });
        await expect
          .poll(() =>
            page
              .locator("openclaw-activity-page")
              .locator('[data-activity-identity="profile-mira"]')
              .count(),
          )
          .toBe(1);
        await captureProof(page, "chat-participant-activity.png");

        await page.goBack();
        await author.waitFor({ state: "visible" });
        // The persistent-identity footer only takes pointer events once its group is hovered,
        // which is what reaching for the name does anyway.
        await authorGroup.hover();
        await author.click();
        await waitForControlUiRoute(page, {
          pathname: "/activity/profile-ada",
          routeId: "activity",
          search: "",
        });
        await captureProof(page, "chat-author-activity.png");
      },
    );
  });
});
