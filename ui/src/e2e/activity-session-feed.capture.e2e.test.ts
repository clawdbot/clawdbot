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
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const now = Date.now();
        const releaseKey = "agent:main:release-readiness";
        const designKey = "agent:main:design-review";
        await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            { self: true, id: "profile-self", name: "Operator" },
            {
              id: "profile-alice",
              name: "Alice Chen",
              email: "alice@example.test",
              host: "Alice's MacBook Pro",
              platform: "macOS 26.5",
              deviceFamily: "Mac",
              lastInputSeconds: 32,
              watchedSessions: [releaseKey, designKey],
            },
            {
              id: "profile-bob",
              name: "Bob Rivera",
              email: "bob@example.test",
              host: "Bob's Mac Studio",
              platform: "macOS 26.5",
              deviceFamily: "Mac",
              lastInputSeconds: 640,
              watchedSessions: [],
            },
          ],
          methodResponses: {
            "sessions.list": {
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
                  createdActor: { type: "human", id: "profile-alice", label: "Alice Chen" },
                  owner: {
                    actor: { type: "human", id: "profile-alice", label: "Alice Chen" },
                  },
                  participants: [{ type: "human", id: "profile-bob", label: "Bob Rivera" }],
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
                  createdActor: { type: "human", id: "profile-bob", label: "Bob Rivera" },
                  owner: {
                    actor: { type: "human", id: "profile-bob", label: "Bob Rivera" },
                  },
                  participants: [{ type: "human", id: "profile-alice", label: "Alice Chen" }],
                  hasAutomation: true,
                  updatedAt: now - 42 * 60_000,
                },
                {
                  key: "agent:main:gateway-handoff",
                  kind: "direct",
                  displayName: "Gateway handoff",
                  agentId: "main",
                  createdActor: { type: "human", id: "profile-carol", label: "Carol Singh" },
                  owner: {
                    actor: { type: "human", id: "profile-carol", label: "Carol Singh" },
                  },
                  hasAutomation: true,
                  updatedAt: now - 2 * 60 * 60_000,
                },
                {
                  key: "agent:main:nightly-maintenance",
                  kind: "direct",
                  displayName: "Nightly mock maintenance",
                  agentId: "main",
                  createdActor: { type: "human", id: "profile-carol", label: "Carol Singh" },
                  owner: {
                    actor: { type: "human", id: "profile-carol", label: "Carol Singh" },
                  },
                  hasAutomation: true,
                  updatedAt: now - 3 * 60 * 60_000,
                },
                {
                  key: "agent:main:incident-notes",
                  kind: "direct",
                  displayName: "Incident follow-up",
                  agentId: "main",
                  createdActor: { type: "human", id: "profile-alice", label: "Alice Chen" },
                  owner: {
                    actor: { type: "human", id: "profile-alice", label: "Alice Chen" },
                  },
                  updatedAt: now - 50 * 60 * 60_000,
                },
              ],
              ts: now,
            },
          },
          sessionKey: releaseKey,
        });

        const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, releaseKey));
        expect(response?.status()).toBe(200);
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(2);
        await expect
          .poll(() => page.locator('[data-online-user-id="profile-bob"]').getAttribute("class"))
          .toContain("sidebar-online__person--away");
        await mkdir(outputDir, { recursive: true });
        await page.locator(".sidebar").screenshot({
          animations: "disabled",
          path: path.join(outputDir, "01-sidebar-online.png"),
        });

        await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime?: { context: { navigate: (routeId: string) => void } };
          };
          app.runtime?.context.navigate("activity");
        });
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        await page.locator(".activity-feed__people-trigger").click();
        await expect
          .poll(() =>
            page
              .locator(
                '.activity-feed__people-row[data-activity-person]:not([data-activity-person=""])',
              )
              .count(),
          )
          .toBe(3);
        await page.keyboard.press("Escape");
        const automationGroup = page.locator("[data-activity-automation-group]");
        await expect.poll(() => automationGroup.count()).toBe(1);
        await expect.poll(() => automationGroup.getAttribute("aria-expanded")).toBe("false");
        await expect.poll(() => page.locator("[data-activity-session]").count()).toBe(2);
        await automationGroup.click();
        await expect.poll(() => page.locator("[data-activity-session]").count()).toBe(5);
        await automationGroup.click();
        await expect.poll(() => page.locator("[data-activity-session]").count()).toBe(2);

        const liveRow = page.locator(`[data-activity-session="${releaseKey}"]`);
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
        await page.screenshot({
          animations: "disabled",
          path: path.join(outputDir, "02-global-activity.png"),
        });

        await page.locator('[data-online-user-id="profile-alice"]').click();
        await expect
          .poll(() => new URL(page.url()).searchParams.get("person"))
          .toBe("profile-alice");
        await expect
          .poll(() => page.locator('[data-activity-identity="profile-alice"]').isVisible())
          .toBe(true);
        await expect
          .poll(() => page.locator(".activity-feed__viewing-list .activity-feed__session").count())
          .toBe(2);
        await page.screenshot({
          animations: "disabled",
          path: path.join(outputDir, "03-person-activity.png"),
        });
      },
    );
  });
});
