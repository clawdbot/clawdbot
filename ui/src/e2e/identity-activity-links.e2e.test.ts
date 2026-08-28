import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
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
  "identity-activity-links",
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

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens each identity's activity feed from the hovercard", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:identity-selected";
    const sessionKey = "agent:main:identity-hovered";

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
                id: "profile-ada",
                identity: { type: "profile", id: "profile-ada" },
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
                  id: "profile-ada",
                  identity: { type: "profile", id: "profile-ada" },
                  label: "Ada King",
                },
              },
              participants: [
                { identity: { type: "profile", id: "profile-ada" }, label: "Ada King" },
                { identity: { type: "profile", id: "profile-mira" }, label: "Mira" },
              ],
              participantCount: 2,
              updatedAt: now - 10 * 60_000,
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
          peopleSessionCount: 2,
          peopleIncomplete: false,
        };
        const associatedSessions = sessionList.sessions.slice(1);
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [{ self: true, id: "profile-self", name: "You" }],
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
        const identity = card.locator("a.session-hovercard__identity-name");
        const participant = card.locator("a.session-hovercard__participant-name");
        await expect.poll(() => identity.textContent()).toBe("Ada King");
        expect(await identity.getAttribute("href")).toBe("/activity?person=profile-ada");
        // The locale's own "with {name}" phrasing survives per-name linking.
        await expect
          .poll(() => card.locator(".session-hovercard__participants").textContent())
          .toContain("with Mira");
        expect(await participant.textContent()).toBe("Mira");
        expect(await participant.getAttribute("href")).toBe("/activity?person=profile-mira");
        await identity.hover();
        expect(
          await identity.evaluate((element) => getComputedStyle(element).textDecorationLine),
        ).toBe("underline");
        await captureProof(page, "hovercard-identity-link.png");
        await participant.hover();
        expect(
          await participant.evaluate((element) => getComputedStyle(element).textDecorationLine),
        ).toBe("underline");
        await captureProof(page, "hovercard-participant-link.png");

        // The decorative avatar link stays out of the tab order; the name link is the target.
        await trigger.focus();
        await page.keyboard.press("Tab");
        expect(await identity.evaluate((element) => document.activeElement === element)).toBe(true);
        await identity.click();

        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        expect(new URL(page.url()).searchParams.get("person")).toBe("profile-ada");
        await expect.poll(() => card.count()).toBe(0);
        const activityPage = page.locator("openclaw-activity-page");
        await expect
          .poll(() => activityPage.locator('[data-activity-identity="profile-ada"]').count())
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
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        expect(new URL(page.url()).searchParams.get("person")).toBe("profile-mira");
        await expect
          .poll(() => activityPage.locator('[data-activity-identity="profile-mira"]').count())
          .toBe(1);
        await captureProof(page, "hovercard-participant-activity.png");
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
            { self: true, id: "profile-self", name: "You" },
            { id: "profile-ada", name: "Ada King" },
            { id: "profile-mira", name: "Mira" },
          ],
          historyMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "Handing this over." }],
              timestamp: now - 120_000,
              __openclaw: { id: "ada-message", senderId: "profile-ada", senderName: "Ada King" },
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
        expect(await ownerLink.getAttribute("href")).toBe("/activity?person=profile-ada");
        const participantLink = page.locator(
          ".chat-pane__participants a.person-activity-avatar-link",
        );
        expect(await participantLink.getAttribute("href")).toBe("/activity?person=profile-mira");

        const author = page.locator("a.chat-sender-name");
        await author.waitFor({ state: "visible" });
        await expect.poll(() => author.textContent()).toBe("Ada King");
        expect(await author.getAttribute("href")).toBe("/activity?person=profile-ada");
        await captureProof(page, "chat-identity-links.png");

        await participantLink.click();
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        expect(new URL(page.url()).searchParams.get("person")).toBe("profile-mira");
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
        const authorAgain = page.locator("a.chat-sender-name");
        await authorAgain.waitFor({ state: "visible" });
        // The persistent-identity footer only takes pointer events once its group is hovered,
        // which is what reaching for the name does anyway.
        await page.locator(".chat-group--peer").hover();
        await authorAgain.click();
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        expect(new URL(page.url()).searchParams.get("person")).toBe("profile-ada");
        await captureProof(page, "chat-author-activity.png");
      },
    );
  });
});
