import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const selected = "agent:main:card-selected";
const watched = "agent:main:card-viewing";
const proofDirectory = path.resolve(".artifacts/control-ui-e2e/presence-namespaces");
const recentLabel = "Review the complete cross-platform launch readiness checklist before release";
const updatedRecentLabel = `${recentLabel} with every regional owner`;
const focusUpdatedRecentLabel = `${updatedRecentLabel} and final approval`;

const id = "synthetic-shared-id";
const rawSession = "agent:main:raw-watch";
const profileSession = "agent:main:profile-watch";
const profile = { id, identity: { type: "profile" as const, id }, name: "Profile person" };
const raw = { id, name: "Unqualified sender" };

function scenario(recentSessionLabel = recentLabel) {
  const now = Date.now();
  return {
    sessionKey: selected,
    presenceUsers: [
      {
        id: "alice",
        identity: { type: "profile" as const, id: "alice" },
        name: "Alice",
        onlineSince: now - 2_700_000,
        lastActivityAt: now - 60_000,
        deviceFamily: "Mac",
        platform: "macOS",
        timeZone: "Europe/Paris",
        watchedSessions: [watched, "agent:main:main", "agent:private:hidden"],
      },
    ],
    methodResponses: {
      "sessions.list": chatSessionListResponse([
        { key: "agent:main:main", kind: "direct", label: "", updatedAt: now - 90_000 },
        { key: selected, kind: "direct", label: "Selected session", updatedAt: now },
        {
          key: watched,
          kind: "direct",
          label: "Release checklist",
          updatedAt: now - 60_000,
          boardFace: "dashboard",
        },
        {
          key: "agent:main:card-recent",
          kind: "direct",
          label: recentSessionLabel,
          updatedAt: now - 120_000,
          createdActor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
        },
      ]),
    },
  };
}

async function expectInlineLastActivity(card: Locator) {
  const positions = await card
    .locator(".person-activity-card__facts dd")
    .last()
    .evaluate((value) => {
      const time = value.querySelector("time");
      const text = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
      let suffix = text.nextNode();
      while (suffix && suffix.textContent?.trim() !== "ago") {
        suffix = text.nextNode();
      }
      if (!time || !suffix) {
        throw new Error("Expected last activity duration and suffix");
      }
      const range = document.createRange();
      range.selectNodeContents(suffix);
      return { time: time.getBoundingClientRect().top, suffix: range.getBoundingClientRect().top };
    });
  expect(Math.abs(positions.time - positions.suffix)).toBeLessThan(2);
}

async function expectMultilineTitle(title: Locator) {
  const layout = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      lineClamp: style.getPropertyValue("-webkit-line-clamp"),
      renderedLines: element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace,
    };
  });
  expect(layout.lineClamp).toBe("2");
  expect(layout.renderedLines).toBeGreaterThan(1.5);
  expect(layout.whiteSpace).toBe("normal");
}

async function capturePeopleCard(page: Page, filename: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(proofDirectory, filename),
    fullPage: true,
    animations: "disabled",
  });
}

suite.define(() => {
  it("opens one person row, preserves focus on updates, and keeps activity navigation in the card", async () => {
    await suite.withPage(
      {
        hasTouch: false,
        colorScheme: "light",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: proofDirectory, size: { width: 1280, height: 900 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, scenario());
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        const row = page
          .locator(".sidebar-online__row")
          .filter({ has: page.locator('[data-online-user-id="alice"]') });
        const person = row.getByRole("button", { name: "Details for Alice" });
        const card = page.getByRole("dialog", { name: "Activity for Alice" });
        await person.waitFor({ state: "visible" });
        expect(await card.count()).toBe(0);
        expect(await row.locator("a, button").count()).toBe(1);
        await person.hover();
        await card.waitFor({ state: "visible" });
        expect(await card.textContent()).toContain("Reported time zone: Europe/Paris");
        await expect
          .poll(() => card.locator("a").allTextContents())
          .toEqual(
            expect.arrayContaining([
              expect.stringContaining("Release checklist"),
              expect.stringContaining("Main Session"),
              expect.stringContaining(recentLabel),
              expect.stringContaining("View activity"),
            ]),
          );
        expect(await card.innerHTML()).not.toContain("agent:private:hidden");
        await expectInlineLastActivity(card);
        await capturePeopleCard(page, "desktop-light-open.png");
        const bounds = await row.boundingBox();
        const cardBounds = await card.boundingBox();
        if (!bounds || !cardBounds) {
          throw new Error("Expected person row and card bounds");
        }
        await page.mouse.move(bounds.x + bounds.width + 4, bounds.y + bounds.height / 2);
        await page.mouse.move(cardBounds.x + 8, cardBounds.y + 20);
        expect(await card.count()).toBe(1);
        const recent = card
          .getByRole("heading", { name: "Recent sessions" })
          .locator("..")
          .getByRole("link");
        const recentTitle = recent.locator(".person-activity-card__session-name");
        await recent.hover();
        const initialShift = await recentTitle.evaluate((element) =>
          element.style.getPropertyValue("--hover-marquee-shift"),
        );
        expect(initialShift).not.toBe("");
        const listRequests = (await gateway.getRequests("sessions.list")).length;
        const updatedScenario = scenario(updatedRecentLabel);
        await gateway.setMethodResponse(
          "sessions.list",
          updatedScenario.methodResponses["sessions.list"],
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "update",
          sessionKey: "agent:main:card-recent",
        });
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list")).length)
          .toBeGreaterThan(listRequests);
        await expect.poll(() => recentTitle.textContent()).toBe(updatedRecentLabel);
        await expect
          .poll(() =>
            recentTitle.evaluate((element) =>
              element.style.getPropertyValue("--hover-marquee-shift"),
            ),
          )
          .not.toBe(initialShift);
        await page.mouse.move(cardBounds.x + 8, cardBounds.y + 20);
        await expect
          .poll(() =>
            recentTitle.evaluate((element) =>
              element.classList.contains("hover-marquee--scrolling"),
            ),
          )
          .toBe(false);
        await person.focus();
        await page.keyboard.press("Tab");
        const session = card.getByRole("link", { name: "Release checklist" });
        await expect
          .poll(() => session.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await session.getAttribute("href")).toContain("/dashboard/");
        const current = scenario().presenceUsers[0]!;
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              ...current,
              user: { id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
              lastInputSeconds: 600,
              ts: Date.now(),
              lastActivityAt: Date.now(),
            },
            { user: { id: "bob", name: "Bob" }, ts: Date.now(), lastInputSeconds: 0 },
          ],
        });
        await expect
          .poll(() =>
            page.locator(".sidebar-online__person").first().getAttribute("data-online-user-id"),
          )
          .toBe("bob");
        expect(await session.evaluate((element) => document.activeElement === element)).toBe(true);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await expect
          .poll(() => recent.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await expect
          .poll(() =>
            recentTitle.evaluate((element) =>
              element.classList.contains("hover-marquee--scrolling"),
            ),
          )
          .toBe(true);
        const focusedShift = await recentTitle.evaluate((element) =>
          element.style.getPropertyValue("--hover-marquee-shift"),
        );
        const focusedListRequests = (await gateway.getRequests("sessions.list")).length;
        const focusUpdatedScenario = scenario(focusUpdatedRecentLabel);
        await gateway.setMethodResponse(
          "sessions.list",
          focusUpdatedScenario.methodResponses["sessions.list"],
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "update",
          sessionKey: "agent:main:card-recent",
        });
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list")).length)
          .toBeGreaterThan(focusedListRequests);
        await expect.poll(() => recentTitle.textContent()).toBe(focusUpdatedRecentLabel);
        await expect
          .poll(() =>
            recentTitle.evaluate((element) =>
              element.style.getPropertyValue("--hover-marquee-shift"),
            ),
          )
          .not.toBe(focusedShift);
        await expect
          .poll(() =>
            recentTitle.evaluate((element) =>
              element.classList.contains("hover-marquee--scrolling"),
            ),
          )
          .toBe(true);
        await page.keyboard.press("Tab");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expectMultilineTitle(recentTitle);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        expect(await person.evaluate((element) => document.activeElement === element)).toBe(true);
        await person.click();
        await card.waitFor({ state: "visible" });
        await page.mouse.move(1100, 200);
        expect(await card.count()).toBe(1);
        await page.mouse.click(1100, 200);
        await expect.poll(() => card.count()).toBe(0);
        await person.click();
        await card.waitFor({ state: "visible" });
        await card.getByRole("link", { name: "View activity", exact: true }).click();
        await expect.poll(() => page.url()).toContain("/activity?person=alice");
        await expect.poll(() => card.count()).toBe(0);
      },
    );
  });

  it("opens touch details inside a narrow viewport and follows the session's saved face", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        isMobile: true,
        colorScheme: "dark",
        reducedMotion: "no-preference",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 390, height: 650 },
      },
      async ({ page }) => {
        await installMockGateway(page, scenario());
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
        const person = page.getByRole("button", { name: "Details for Alice" });
        await person.tap();
        const card = page.getByRole("dialog", { name: "Activity for Alice" });
        await card.waitFor({ state: "visible" });
        await page.keyboard.press("Tab");
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        expect(await person.isVisible()).toBe(true);
        expect(await person.evaluate((element) => document.activeElement === element)).toBe(true);
        await person.tap();
        await card.waitFor({ state: "visible" });
        expect(await card.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
          "auto",
        );
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
        const session = card.getByRole("link", { name: "Release checklist" });
        await session.click({ trial: true });
        const recent = card.getByRole("link", { name: recentLabel });
        const recentTitle = recent.locator(".person-activity-card__session-name");
        await expectMultilineTitle(recentTitle);
        await recent.focus();
        expect(await recentTitle.evaluate((element) => getComputedStyle(element).textIndent)).toBe(
          "0px",
        );
        await expectMultilineTitle(recentTitle);
        await expectInlineLastActivity(card);
        await capturePeopleCard(page, "touch-dark-open.png");
        await session.tap();
        await expect.poll(() => page.url()).toContain("/dashboard/");
        await expect.poll(() => card.count()).toBe(0);
      },
    );
  });
  it("keeps colliding people, watches, owner exclusion and open cards separate through updates", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const actor = { type: "human", id, identity: profile.identity, label: profile.name };
        const sessions = chatSessionListResponse([
          {
            key: selected,
            kind: "direct",
            label: "Namespace isolation",
            updatedAt: 3,
            owner: { actor },
            participantCount: 1,
          },
          {
            key: profileSession,
            kind: "direct",
            label: "Profile watch",
            updatedAt: 2,
            createdActor: actor,
          },
          { key: rawSession, kind: "direct", label: "Raw watch", updatedAt: 1 },
        ]);
        const gateway = await installMockGateway(page, {
          sessionKey: selected,
          presenceUsers: [
            { self: true, id: "self", identity: { type: "profile", id: "self" }, name: "Self" },
            { ...profile, watchedSessions: [selected, profileSession] },
            { ...raw, watchedSessions: [selected, rawSession] },
          ],
          methodResponses: { "sessions.list": sessions },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        const profileButton = page.getByRole("button", {
          name: "Details for Profile person",
          exact: true,
        });
        await profileButton.waitFor({ state: "visible" });
        if (captureUiProofEnabled) {
          await mkdir(proofDirectory, { recursive: true });
          await page.screenshot({
            path: path.join(proofDirectory, "initial.png"),
            animations: "disabled",
          });
        }
        expect(await page.locator(".sidebar-online__person").count()).toBe(2);
        const rawButton = page.getByRole("button", {
          name: "Details for Unqualified sender",
          exact: true,
        });
        await rawButton.click();
        const rawCard = page.getByRole("dialog", {
          name: "Activity for Unqualified sender",
          exact: true,
        });
        await rawCard.waitFor({ state: "visible" });
        expect(await rawCard.getByRole("link", { name: /^Raw watch(?:\s|$)/ }).count()).toBe(1);
        expect(await rawCard.getByRole("link", { name: /^Profile watch(?:\s|$)/ }).count()).toBe(0);
        expect(
          await rawCard.getByRole("link", { name: "View activity", exact: true }).count(),
        ).toBe(0);
        const headerFaces = page.locator(".chat-pane__presence [data-viewer-id]");
        await expect.poll(() => headerFaces.getAttribute("aria-label")).toBe(raw.name);
        if (captureUiProofEnabled) {
          await page.screenshot({
            path: path.join(proofDirectory, "raw-card.png"),
            animations: "disabled",
          });
        }
        const rawLink = rawCard.getByRole("link", { name: /^Raw watch(?:\s|$)/ });
        await rawLink.focus();
        await gateway.emitGatewayEvent("presence", {
          presence: [
            { user: raw, watchedSessions: [rawSession, selected], lastInputSeconds: 600 },
            { user: profile, watchedSessions: [profileSession, selected], lastInputSeconds: 0 },
          ],
        });
        await expect
          .poll(() => rawLink.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await gateway.emitGatewayEvent("presence", {
          presence: [{ user: raw, watchedSessions: [rawSession, selected] }],
        });
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(1);
        expect(await rawLink.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(await rawCard.count()).toBe(1);
        await gateway.emitGatewayEvent("presence", {
          presence: [
            { user: raw, reason: "disconnect", watchedSessions: [rawSession] },
            { user: profile, watchedSessions: [profileSession] },
          ],
        });
        await expect.poll(() => rawCard.count()).toBe(0);
        await profileButton.click();
        const profileCard = page.getByRole("dialog", {
          name: "Activity for Profile person",
          exact: true,
        });
        await profileCard.waitFor({ state: "visible" });
        expect(await profileCard.getByRole("link", { name: /^Raw watch(?:\s|$)/ }).count()).toBe(0);
        const activity = profileCard.getByRole("link", { name: "View activity", exact: true });
        expect(await activity.getAttribute("href")).toBe(`/activity?person=${id}`);
        if (captureUiProofEnabled) {
          await page.screenshot({
            path: path.join(proofDirectory, "profile-card.png"),
            animations: "disabled",
          });
        }
        expect((await gateway.getRequests("connect")).length).toBeGreaterThan(0);
        expect((await gateway.getRequests("sessions.list")).length).toBeGreaterThan(0);
      },
    );
  });
  it.each([true, false])(
    "keeps a same-ID peer visible and typing enabled for profile self: %s",
    async (qualified) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, locale: "en-US" },
        async ({ page }) => {
          const self = qualified ? profile : raw;
          const peer = qualified ? raw : profile;
          const gateway = await installMockGateway(page, {
            sessionKey: selected,
            featureMethods: [...defaultControlUiFeatureMethods, "session.typing"],
            presenceUsers: [
              { ...self, self: true, watchedSessions: [selected] },
              { ...peer, watchedSessions: [selected] },
            ],
            methodResponses: {
              "session.typing": { ok: true, broadcast: true },
              "sessions.list": chatSessionListResponse([
                {
                  key: selected,
                  kind: "direct",
                  label: "Namespace isolation",
                  updatedAt: 1,
                  sessionId: "namespace-session",
                },
              ]),
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
          await page
            .getByRole("button", { name: `Details for ${peer.name}`, exact: true })
            .waitFor({ state: "visible" });
          expect(await page.locator(".sidebar-online__person").count()).toBe(1);
          await expect
            .poll(() =>
              page.locator(".chat-pane__presence [data-viewer-id]").getAttribute("aria-label"),
            )
            .toBe(peer.name);
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("A synthetic typing draft");
          const typing = await gateway.waitForRequest("session.typing");
          expect(typing.params).toMatchObject({ sessionKey: selected, typing: true });
        },
      );
    },
  );
});
