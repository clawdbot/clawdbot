import path from "node:path";
import type { Locator } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureSessionOwnerPageProof,
  captureSessionOwnerProof,
  captureUiProofEnabled,
  openSidebarSortMenu,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI person-grouped session presence",
});

async function selectMenuValue(menu: Locator, value: string) {
  await menu.evaluate((element, selectedValue) => {
    element.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: selectedValue } },
      }),
    );
  }, value);
}

function sessionsList() {
  const ada = {
    type: "human" as const,
    id: "profile-ada",
    identity: { type: "profile" as const, id: "profile-ada" },
    label: "Ada",
    avatarUrl: "/api/users/profile-ada/avatar?v=1",
  };
  const bob = {
    type: "human" as const,
    id: "profile-bob",
    identity: { type: "profile" as const, id: "profile-bob" },
    label: "Bob",
    avatarUrl: "/api/users/profile-bob/avatar?v=1",
  };
  return {
    count: 2,
    owners: [ada, bob],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada",
        kind: "direct",
        label: "Ada research",
        createdActor: ada,
        owner: { actor: ada },
        updatedAt: 2,
      },
      {
        key: "agent:main:bob",
        kind: "direct",
        label: "Bob operations",
        createdActor: bob,
        owner: { actor: bob },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

suite.define(() => {
  it("shows row owners only for live presence under person headers", async () => {
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "session-owner-stack"),
              size: { height: 800, width: 1200 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    await routeAvatarFixtures(page, [
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
      { id: "profile-morgan", background: "#66508c", label: "M" },
    ]);
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-self", name: "Self" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList() },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
      await page.getByText("Ada research", { exact: true }).first().waitFor();
      const menu = await openSidebarSortMenu(page);
      await selectMenuValue(menu, "grouping:person");
      const adaSection = page.locator('[data-session-section="person:profile:profile-ada"]');
      const bobSection = page.locator('[data-session-section="person:profile:profile-bob"]');
      await expectBrowser(adaSection).toContainText("Ada research");
      await expectBrowser(bobSection).toContainText("Bob operations");

      await gateway.emitGatewayEvent("presence", {
        presence: [
          {
            instanceId: "ada-browser",
            mode: "webchat",
            reason: "connect",
            ts: Date.now(),
            user: {
              id: "profile-ada",
              identity: { type: "profile", id: "profile-ada" },
              name: "Ada",
              avatarUrl: "/api/users/profile-ada/avatar?v=1",
            },
            watchedSessions: ["agent:main:ada"],
          },
          {
            instanceId: "morgan-browser",
            mode: "webchat",
            reason: "connect",
            ts: Date.now(),
            user: {
              id: "profile-morgan",
              identity: { type: "profile", id: "profile-morgan" },
              name: "Morgan",
              avatarUrl: "/api/users/profile-morgan/avatar?v=1",
            },
            watchedSessions: ["agent:main:bob"],
          },
        ],
      });
      await expectBrowser(
        adaSection.locator(".session-owner-chip:not(.session-owner-chip--away)"),
      ).toHaveCount(1);
      await expectBrowser(bobSection.locator('[data-viewer-id="profile-morgan"]')).toHaveCount(1);
      await captureSessionOwnerProof(suite, page, "person-grouping-live-presence.png");
      await expectBrowser(bobSection.locator("openclaw-session-owner-chip")).toHaveCount(0);
      const adaHeader = adaSection.locator(".sidebar-recent-sessions__head");
      await adaHeader.hover();
      await captureSessionOwnerProof(suite, page, "person-grouping-header-hover.png");
      await page.mouse.move(0, 0);
      await captureSessionOwnerProof(suite, page, "person-grouping-owner-online.png");

      const textColor = await page.locator(".sidebar-sessions").evaluate((sidebar) => {
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(sidebar).getPropertyValue("--text");
        sidebar.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await adaHeader.hover();
      await expectBrowser
        .poll(() =>
          adaHeader
            .locator(".sidebar-recent-sessions__label-text")
            .evaluate((label) => getComputedStyle(label).color),
        )
        .toBe(textColor);
      await expectBrowser(adaSection.locator(".sidebar-session-group-presence")).toHaveCount(1);
      await expectBrowser(bobSection.locator(".sidebar-session-group-presence")).toHaveCount(0);

      await adaSection.locator("[data-person-card]").hover();
      const adaCard = page.getByRole("dialog", { name: "Activity for Ada" });
      await expectBrowser(adaCard).toBeVisible();
      await captureSessionOwnerPageProof(suite, page, "person-grouping-header-card.png");
      await page.mouse.move(0, 0);
      await adaCard.waitFor({ state: "detached" });
      await bobSection.locator("[data-person-card]").hover();
      const bobCard = page.getByRole("dialog", { name: "Activity for Bob" });
      await expectBrowser(bobCard).toBeVisible();
      await expectBrowser(bobCard).toContainText("Offline");
      await expectBrowser(bobCard.locator("dl")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
