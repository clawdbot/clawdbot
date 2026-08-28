import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
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
const proofDirectory = path.resolve(".artifacts/control-ui-e2e/people-activity-cards");
const recentLabel =
  "Review the complete cross-platform launch readiness checklist before release";
const updatedRecentLabel = `${recentLabel} with every regional owner`;
const focusUpdatedRecentLabel = `${updatedRecentLabel} and final approval`;

function scenario(recentSessionLabel = recentLabel) {
  const now = Date.now();
  return {
    sessionKey: selected,
    presenceUsers: [
      {
        id: "alice",
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
          createdActor: { type: "human", id: "alice" },
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
      renderedLines:
        element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight),
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
              user: { id: "alice", name: "Alice" },
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
        await page.mouse.move(1100, 850);
        expect(await card.count()).toBe(1);
        await page.mouse.click(1100, 850);
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
});
