import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps mobile sharing inside the %s session More menu",
    async (colorScheme) => {
      const sessionKey = "agent:main:mobile-more";
      const context = await suite.browser.newContext({
        colorScheme,
        hasTouch: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        allowedSessionVisibilities: ["shared", "read-only", "suggest", "draft"],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "session.visibility.set",
          "session.members.listEvidence",
          "session.members.add",
          "session.members.remove",
        ],
        operatorScopes: ["operator.read", "operator.write"],
        sessionKey,
        methodResponses: {
          "sessions.list": sessionsListResponse([
            {
              ...sessionRow(sessionKey, "Mobile menu", Date.parse("2026-08-28T12:00:00.000Z")),
              sharingRole: "owner",
              visibility: "draft",
            },
          ]),
          "session.members.listEvidence": {
            sessionKey,
            owner: { type: "human", id: "owner", label: "Owner" },
            members: [],
            identities: [
              { type: "human", id: "owner", label: "Owner" },
              ...Array.from({ length: 30 }, (_, index) => ({
                type: "human" as const,
                id: `member-${index}`,
                label: `Member ${index}`,
              })),
            ],
            role: "owner",
            allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
          },
        },
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByRole("button", { name: "Actions for Mobile menu" }).click();
        const menu = page.getByRole("menu", { name: "Actions for Mobile menu" });
        const menuHost = page.locator("openclaw-chat-header-session-menu");
        await menu.waitFor({ state: "visible" });
        const rootItems = menuHost.locator(":scope > wa-dropdown > wa-dropdown-item");
        await expect
          .poll(() =>
            rootItems.evaluateAll((items) =>
              items.map((item) => Math.round(item.getBoundingClientRect().height)),
            ),
          )
          .toEqual(Array.from({ length: 15 }, () => 34));
        await expect
          .poll(() => menu.evaluate((element) => element.getBoundingClientRect().height))
          .toBeLessThan(550);
        const deleteIconColor = await menuHost
          .locator('wa-dropdown-item[value="delete"] .session-menu__icon')
          .evaluate((element) => getComputedStyle(element).color);
        const deleteLabelColor = await menuHost
          .locator('wa-dropdown-item[value="delete"] .session-menu__text')
          .evaluate((element) => getComputedStyle(element).color);
        expect(deleteIconColor).toBe(deleteLabelColor);
        await captureUiProof(page, `mobile-more-followup-after-${colorScheme}.png`);

        await expect
          .poll(() => page.getByRole("button", { name: "Session sharing" }).count())
          .toBe(0);
        await menuHost.locator('wa-dropdown-item[value="compact:open-sharing"]').click();
        const publish = menuHost.locator(".chat-pane__publish-draft");
        await publish.waitFor();
        await menuHost.getByText("Members", { exact: true }).waitFor();
        await expect
          .poll(() =>
            menu.evaluate((element) => Math.round(element.getBoundingClientRect().height)),
          )
          .toBeLessThanOrEqual(421);
        await expect
          .poll(() => menu.evaluate((element) => element.scrollHeight))
          .toBeGreaterThan(await menu.evaluate((element) => element.clientHeight));
        await expect
          .poll(() =>
            publish.evaluate((element) => Math.round(element.getBoundingClientRect().height)),
          )
          .toBe(34);
        await captureUiProof(page, `mobile-more-sharing-followup-after-${colorScheme}.png`);
      } finally {
        await context.close();
      }
    },
  );

  it("keeps the mobile draft indicator for non-manager sessions", async () => {
    const sessionKey = "agent:main:mobile-member-draft";
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      allowedSessionVisibilities: ["shared", "read-only", "suggest", "draft"],
      featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
      operatorScopes: ["operator.read"],
      sessionKey,
      methodResponses: {
        "sessions.list": sessionsListResponse([
          {
            ...sessionRow(sessionKey, "Member draft", Date.parse("2026-08-28T12:00:00.000Z")),
            sharingRole: "member",
            visibility: "draft",
          },
        ]),
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.locator(".chat-pane__draft-indicator").waitFor();
      await page.getByRole("button", { name: "Actions for Member draft" }).click();
      const menuHost = page.locator("openclaw-chat-header-session-menu");
      await expect
        .poll(() => menuHost.locator('wa-dropdown-item[value="compact:open-sharing"]').count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });
});
