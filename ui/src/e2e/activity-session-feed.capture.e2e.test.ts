import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session activity feed capture",
  startServerBeforeBrowser: true,
});

const outputDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/session-activity-feed");

suite.define(() => {
  it("captures online, global activity, and person-filtered activity surfaces", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await page.route("**/plugins/geolocation/lookup?ip=203.0.113.20", async (route) => {
          await route.fulfill({
            contentType: "application/json",
            json: {
              found: true,
              city: "Vienna",
              region: "Vienna",
              attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
            },
          });
        });
        const current = new Date();
        // Keep the automation fixtures on one local calendar day in every timezone.
        const now = new Date(
          current.getFullYear(),
          current.getMonth(),
          current.getDate() - 1,
          12,
        ).getTime();
        const releaseKey = "agent:main:release-readiness";
        const designKey = "agent:main:design-review";
        const gatewayHandoffKey = "agent:main:gateway-handoff";
        const nightlyMaintenanceKey = "agent:main:nightly-maintenance";
        const incidentNotesKey = "agent:main:incident-notes";
        const automationKeys = [designKey, gatewayHandoffKey, nightlyMaintenanceKey];
        const nonAutomationKeys = [releaseKey, incidentNotesKey];
        const sessionList = {
          people: [
            {
              identity: { type: "profile", id: "profile-alice" },
              label: "Alice Chen",
              sessionCount: 3,
            },
            {
              identity: { type: "profile", id: "profile-bob" },
              label: "Bob Rivera",
              sessionCount: 2,
            },
            {
              identity: { type: "profile", id: "profile-carol" },
              label: "Carol Singh",
              sessionCount: 2,
            },
          ],
          peopleSessionCount: 5,
          count: 5,
          creators: [
            { id: "profile-alice", label: "Alice Chen" },
            { id: "profile-bob", label: "Bob Rivera" },
            { id: "profile-carol", label: "Carol Singh" },
          ],
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              key: releaseKey,
              kind: "direct",
              displayName: "Release readiness",
              agentId: "main",
              channel: "webchat",
              createdActor: {
                type: "human",
                id: "profile-alice",
                identity: { type: "profile", id: "profile-alice" },
                label: "Alice Chen",
              },
              owner: {
                actor: {
                  type: "human",
                  id: "profile-alice",
                  identity: { type: "profile", id: "profile-alice" },
                  label: "Alice Chen",
                },
              },
              participants: [
                { identity: { type: "profile", id: "profile-bob" }, label: "Bob Rivera" },
              ],
              activeRunIds: ["mock run:a/b"],
              hasActiveRun: true,
              observerDigest: {
                headline: "Waiting on a fictional mock approval",
                health: "waiting-on-user",
                revision: 1,
                runId: "mock run:a/b",
                updatedAt: now - 4 * 60_000,
              },
              status: "running",
              updatedAt: now - 4 * 60_000,
            },
            {
              key: designKey,
              kind: "direct",
              displayName: "Control UI design review",
              agentId: "main",
              createdActor: {
                type: "human",
                id: "profile-bob",
                identity: { type: "profile", id: "profile-bob" },
                label: "Bob Rivera",
              },
              owner: {
                actor: {
                  type: "human",
                  id: "profile-bob",
                  identity: { type: "profile", id: "profile-bob" },
                  label: "Bob Rivera",
                },
              },
              createdVia: "cron",
              participants: [
                { identity: { type: "profile", id: "profile-alice" }, label: "Alice Chen" },
              ],
              hasAutomation: true,
              updatedAt: now - 42 * 60_000,
            },
            {
              key: gatewayHandoffKey,
              kind: "direct",
              displayName: "Gateway handoff",
              agentId: "main",
              createdActor: {
                type: "human",
                id: "profile-carol",
                identity: { type: "profile", id: "profile-carol" },
                label: "Carol Singh",
              },
              owner: {
                actor: {
                  type: "human",
                  id: "profile-carol",
                  identity: { type: "profile", id: "profile-carol" },
                  label: "Carol Singh",
                },
              },
              createdVia: "cron",
              hasAutomation: true,
              updatedAt: now - 2 * 60 * 60_000,
            },
            {
              key: nightlyMaintenanceKey,
              kind: "direct",
              displayName: "Nightly mock maintenance",
              agentId: "main",
              createdActor: {
                type: "human",
                id: "profile-carol",
                identity: { type: "profile", id: "profile-carol" },
                label: "Carol Singh",
              },
              owner: {
                actor: {
                  type: "human",
                  id: "profile-carol",
                  identity: { type: "profile", id: "profile-carol" },
                  label: "Carol Singh",
                },
              },
              createdVia: "cron",
              hasAutomation: true,
              updatedAt: now - 3 * 60 * 60_000,
            },
            {
              key: incidentNotesKey,
              kind: "direct",
              displayName: "Incident follow-up",
              agentId: "main",
              createdActor: {
                type: "human",
                id: "profile-alice",
                identity: { type: "profile", id: "profile-alice" },
                label: "Alice Chen",
              },
              owner: {
                actor: {
                  type: "human",
                  id: "profile-alice",
                  identity: { type: "profile", id: "profile-alice" },
                  label: "Alice Chen",
                },
              },
              updatedAt: now - 50 * 60 * 60_000,
            },
          ],
          ts: now,
        };
        await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            {
              self: true,
              id: "profile-self",
              identity: { type: "profile", id: "profile-self" },
              name: "Operator",
            },
            {
              id: "profile-alice",
              identity: { type: "profile", id: "profile-alice" },
              name: "Alice Chen",
              email: "alice@example.test",
              host: "Alice's MacBook Pro",
              platform: "macOS 26.5",
              deviceFamily: "Mac",
              ip: "203.0.113.20",
              lastInputSeconds: 32,
              watchedSessions: [releaseKey, designKey],
            },
            {
              id: "profile-bob",
              identity: { type: "profile", id: "profile-bob" },
              name: "Bob Rivera",
              email: "bob@example.test",
              host: "Bob's Mac Studio",
              platform: "macOS 26.5",
              deviceFamily: "Mac",
              lastInputSeconds: 640,
              watchedSessions: [],
            },
            {
              id: "profile-carol",
              identity: { type: "profile", id: "profile-carol" },
              name: "Carol Singh",
              lastInputSeconds: 14,
              watchedSessions: [releaseKey],
            },
            {
              id: "profile-dan",
              identity: { type: "profile", id: "profile-dan" },
              name: "Dan Wu",
              lastInputSeconds: 70,
              watchedSessions: [designKey],
            },
          ],
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { involvingProfileId: "profile-carol" },
                  response: {
                    ...sessionList,
                    count: 2,
                    sessions: sessionList.sessions.filter((row) =>
                      [gatewayHandoffKey, nightlyMaintenanceKey].includes(row.key),
                    ),
                  },
                },
                {
                  match: { involvingProfileId: "profile-alice" },
                  response: {
                    ...sessionList,
                    count: 3,
                    sessions: sessionList.sessions.filter((row) =>
                      [releaseKey, designKey, incidentNotesKey].includes(row.key),
                    ),
                  },
                },
                { response: sessionList },
              ],
            },
          },
          sessionKey: releaseKey,
        });

        const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, releaseKey));
        expect(response?.status()).toBe(200);
        const onlineToggle = page.getByRole("button", { name: "Online", exact: true });
        await expect.poll(() => onlineToggle.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(4);
        await mkdir(outputDir, { recursive: true });
        await page.locator(".sidebar").screenshot({
          animations: "disabled",
          path: path.join(outputDir, "01-sidebar-online-default-open-light.png"),
        });

        await onlineToggle.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => onlineToggle.getAttribute("aria-expanded")).toBe("false");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(0);
        await expect
          .poll(() =>
            page.locator(".sidebar-online .viewer-facepile").getAttribute("data-viewer-count"),
          )
          .toBe("4");
        await expect
          .poll(() => page.locator(".sidebar-online .viewer-avatar--overflow").textContent())
          .toContain("+2");
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.locator(".sidebar").screenshot({
          animations: "disabled",
          path: path.join(outputDir, "02-sidebar-online-user-collapsed-light.png"),
        });

        expect(
          await page.evaluate(() => {
            const value = localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections");
            return value ? JSON.parse(value) : [];
          }),
        ).toEqual(expect.arrayContaining(["work", "online"]));
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

        await page.reload();
        await expect.poll(() => onlineToggle.getAttribute("aria-expanded")).toBe("false");
        await page.emulateMedia({ colorScheme: "dark" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
        await page.locator(".sidebar").screenshot({
          animations: "disabled",
          path: path.join(outputDir, "03-sidebar-online-persisted-collapsed-dark.png"),
        });
        await onlineToggle.focus();
        await page.keyboard.press("Space");
        await expect.poll(() => onlineToggle.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(4);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.locator(".sidebar").screenshot({
          animations: "disabled",
          path: path.join(outputDir, "04-sidebar-online-user-expanded-dark.png"),
        });

        await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime?: { context: { navigate: (routeId: string) => void } };
          };
          app.runtime?.context.navigate("activity");
        });
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        const activityPage = page.locator("openclaw-activity-page");
        await expect.poll(() => activityPage.count()).toBe(1);
        const titleLeft = await activityPage
          .locator(".page-title")
          .evaluate((element) => element.getBoundingClientRect().left);
        const tabsLeft = await activityPage
          .locator(".activity-mode-tabs")
          .evaluate((element) => element.getBoundingClientRect().left);
        expect(Math.abs(titleLeft - tabsLeft)).toBeLessThanOrEqual(8);
        await activityPage.locator(".activity-feed__people-trigger").click();
        await expect
          .poll(() =>
            activityPage
              .locator(
                '.activity-feed__people-row[data-activity-person]:not([data-activity-person=""])',
              )
              .count(),
          )
          .toBe(3);
        await page.keyboard.press("Escape");
        const activityFeed = activityPage.locator(".activity-feed");
        const activitySession = (key: string) =>
          activityFeed.locator(`[data-activity-session="${key}"]`);
        const automationGroup = activityFeed.locator("[data-activity-automation-group]");
        await expect.poll(() => automationGroup.count()).toBe(1);
        await expect.poll(() => automationGroup.getAttribute("aria-expanded")).toBe("false");
        for (const key of nonAutomationKeys) {
          await expect.poll(() => activitySession(key).count()).toBe(1);
        }
        for (const key of automationKeys) {
          await expect.poll(() => activitySession(key).count()).toBe(0);
        }
        await automationGroup.click();
        await expect.poll(() => automationGroup.getAttribute("aria-expanded")).toBe("true");
        for (const key of automationKeys) {
          await expect.poll(() => activitySession(key).count()).toBe(1);
        }
        await automationGroup.click();
        await expect.poll(() => automationGroup.getAttribute("aria-expanded")).toBe("false");
        for (const key of automationKeys) {
          await expect.poll(() => activitySession(key).count()).toBe(0);
        }
        for (const key of nonAutomationKeys) {
          await expect.poll(() => activitySession(key).count()).toBe(1);
        }

        const liveRow = activitySession(releaseKey);
        await expect.poll(() => liveRow.locator(".activity-feed__run-dot").count()).toBe(1);
        await expect
          .poll(() => liveRow.locator(".activity-feed__session-headline").textContent())
          .toContain("Waiting on a fictional mock approval");
        const inspectRun = liveRow.locator("xpath=following-sibling::a");
        await liveRow.hover();
        await expect
          .poll(() => inspectRun.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        await inspectRun.focus();
        await expect
          .poll(() => inspectRun.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await inspectRun.getAttribute("href")).toBe(
          "/activity?view=run&run=mock%20run%3Aa%2Fb",
        );
        const timeFilter = activityPage.locator(".activity-feed__time-filter");
        expect(
          await timeFilter
            .locator(".settings-segmented__btn")
            .evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim())),
        ).toEqual(["Last 24 hours", "Last 7 days", "Last 30 days", "All time"]);
        await page.screenshot({
          animations: "disabled",
          path: path.join(outputDir, "05-global-activity.png"),
        });

        await page.locator('[data-online-user-id="profile-alice"]').click();
        const personCard = page.getByRole("dialog", { name: "Activity for Alice Chen" });
        await personCard.waitFor({ state: "visible" });
        await personCard.getByRole("link", { name: "View activity", exact: true }).click();
        await expect
          .poll(() => new URL(page.url()).searchParams.get("person"))
          .toBe("profile-alice");
        await expect
          .poll(() => activityPage.locator('[data-activity-identity="profile-alice"]').isVisible())
          .toBe(true);
        const attributionIcon = activityPage.locator(".activity-feed__device-attribution");
        await expect.poll(() => attributionIcon.locator("svg").count()).toBe(1);
        await expect.poll(async () => (await attributionIcon.boundingBox())?.width).toBe(16);
        await expect
          .poll(() =>
            activityPage.locator(".activity-feed__viewing-list .activity-feed__session").count(),
          )
          .toBe(2);
        await page.screenshot({
          animations: "disabled",
          path: path.join(outputDir, "06-person-activity.png"),
        });

        await activityPage.locator(".activity-feed__people-clear").click();
        await expect.poll(() => new URL(page.url()).searchParams.get("person")).toBeNull();
        await activityPage.locator(".activity-feed__people-trigger").click();
        await activityPage.locator('[data-activity-person="profile-carol"]').click();
        await expect
          .poll(() => new URL(page.url()).searchParams.get("person"))
          .toBe("profile-carol");
        await expect.poll(() => activitySession(nightlyMaintenanceKey).count()).toBe(1);
        await expect
          .poll(() =>
            activitySession(nightlyMaintenanceKey)
              .locator('[data-activity-created-via="cron"]')
              .count(),
          )
          .toBe(1);
        await page.screenshot({
          animations: "disabled",
          path: path.join(outputDir, "06-automation-creator-desktop.png"),
        });

        await activityPage.locator(".activity-feed__people-clear").click();
        await expect.poll(() => new URL(page.url()).searchParams.get("person")).toBeNull();
        await page.setViewportSize({ height: 844, width: 390 });

        const peopleControl = activityPage.locator(".activity-feed__people-control");
        const timeButtonTops = await timeFilter
          .locator(".settings-segmented__btn")
          .evaluateAll((buttons) =>
            buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
          );
        expect(new Set(timeButtonTops)).toHaveLength(1);
        await expect
          .poll(async () => {
            const [timeFilterBox, peopleControlBox] = await Promise.all([
              timeFilter.boundingBox(),
              peopleControl.boundingBox(),
            ]);
            if (!timeFilterBox || !peopleControlBox) {
              return Number.POSITIVE_INFINITY;
            }
            return Math.abs(timeFilterBox.y - peopleControlBox.y);
          })
          .toBeLessThan(2);
        const automationGroupChildTops = await automationGroup
          .locator(":scope > *")
          .evaluateAll((children) =>
            children.map((child) => Math.round(child.getBoundingClientRect().top)),
          );
        expect(
          Math.max(...automationGroupChildTops) - Math.min(...automationGroupChildTops),
        ).toBeLessThan(3);
        expect(
          await activityFeed.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              backgroundColor: style.backgroundColor,
              borderTopWidth: style.borderTopWidth,
            };
          }),
        ).toEqual({ backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px" });
        await activityPage.locator(".activity-feed__people-trigger").click();
        await activityPage.locator('[data-activity-person="profile-carol"]').click();
        await expect
          .poll(() => new URL(page.url()).searchParams.get("person"))
          .toBe("profile-carol");
        await expect.poll(() => activitySession(nightlyMaintenanceKey).count()).toBe(1);
        await expect
          .poll(() => activityFeed.locator('[data-activity-created-via="cron"]').count())
          .toBe(2);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(outputDir, "07-automation-creator-mobile.png"),
        });
      },
    );
  });
});
