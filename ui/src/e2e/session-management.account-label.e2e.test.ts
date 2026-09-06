import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  trimmedTextContents,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

/**
 * An ordinary Gateway direct-chat row: an origin-derived `displayName`, no user
 * label, and the `accountId` the Gateway projects from the canonical route
 * (src/gateway/session-classification.ts). Without both traits this would
 * exercise the label branch instead of the shipped one.
 */
function gatewayDirectRow(key: string, updatedAt: number, accountId?: string) {
  return { ...sessionRow(key, "Alice", updatedAt), accountId, label: undefined };
}

suite.define(() => {
  it("disambiguates same-name sessions from different Telegram accounts in the sidebar", async () => {
    const defaultKey = "agent:main:telegram:direct:42";
    const cardsKey = "agent:main:telegram:cards:direct:42";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          gatewayDirectRow(defaultKey, 2),
          gatewayDirectRow(cardsKey, 1, "cards"),
        ]),
      },
      sessionKey: defaultKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, defaultKey));
      const defaultRow = page.locator(`[data-session-key="${defaultKey}"]`);
      const cardsRow = page.locator(`[data-session-key="${cardsKey}"]`);
      await defaultRow.waitFor({ state: "visible", timeout: 10_000 });
      await cardsRow.waitFor({ state: "visible" });
      await expect
        .poll(() => trimmedTextContents(defaultRow.locator(".sidebar-recent-session__name")))
        .toEqual(["Alice"]);
      await expect
        .poll(() => trimmedTextContents(cardsRow.locator(".sidebar-recent-session__name")))
        .toEqual(["Alice · cards"]);
      await captureUiProof(suite, page, "telegram-account-session-labels.png");
    } finally {
      await context.close();
    }
  });

  it("opens rename on the stored label, not the account-decorated name", async () => {
    const cardsKey = "agent:main:telegram:cards:direct:42";
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([gatewayDirectRow(cardsKey, Date.now(), "cards")]),
      },
      sessionKey: cardsKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, cardsKey));
      const row = page.locator(`[data-session-key="${cardsKey}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      // The row itself carries the account discriminator, so a rename field that
      // echoed the rendered name would look plausible while persisting it.
      await expect
        .poll(() => trimmedTextContents(row.locator(".sidebar-recent-session__name")))
        .toEqual(["Alice · cards"]);

      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await page.getByRole("menuitem", { name: "Rename…" }).click();
      const field = page
        .locator('openclaw-modal-dialog[label="Rename session"]')
        .getByRole("textbox", { name: "Rename session" });
      await field.waitFor({ state: "visible" });
      // This row has no stored label, so the field starts empty. Submitting the
      // decorated name here is what used to freeze it into persisted state.
      expect(await field.inputValue()).toBe("");
    } finally {
      await context.close();
    }
  });

  it("opens chat pane rename on the stored label, not the account-decorated title", async () => {
    const cardsKey = "agent:main:telegram:cards:direct:42";
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([gatewayDirectRow(cardsKey, Date.now(), "cards")]),
      },
      sessionKey: cardsKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, cardsKey));
      const title = page.locator(".chat-pane__session-title-button");
      await expect.poll(() => title.textContent()).toContain("Alice · cards");
      await title.click();
      const field = page.locator(".chat-pane__session-title-input");
      await field.waitFor({ state: "visible" });
      expect(await field.inputValue()).toBe("");
    } finally {
      await context.close();
    }
  });

  it.each(["sidebar", "sessions", "header"] as const)(
    "edits a generated dashboard title through the %s",
    async (surface) => {
      const key = "agent:main:dashboard:generated-title";
      const generatedTitle = "Repository activity dashboard";
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const original = {
        ...sessionRow(key, generatedTitle, Date.now()),
        label: undefined,
        ...(surface === "sessions" ? { displayName: undefined, derivedTitle: generatedTitle } : {}),
      };
      const gateway = await installMockGateway(page, {
        methodResponses: { "sessions.list": sessionsListResponse([original]) },
        sessionKey: key,
      });

      try {
        await page.goto(
          surface === "sessions"
            ? `${suite.server.baseUrl}sessions`
            : controlUiSessionUrl(suite.server.baseUrl, key),
        );
        const row =
          surface === "sessions"
            ? page.locator(".sessions-table tbody tr", {
                has: page.getByRole("checkbox", { name: `Select session: ${key}`, exact: true }),
              })
            : page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await row.waitFor({ state: "visible" });
        const openRename = async () => {
          if (surface === "header") {
            await page.locator(".chat-pane__session-title-button").click();
          } else {
            await row.hover();
            await row.getByRole("button", { name: "Open session menu" }).click();
            await page.getByRole("menuitem", { name: "Rename…" }).click();
          }
        };
        const field = page.locator(
          surface === "header"
            ? ".chat-pane__session-title-input"
            : 'openclaw-modal-dialog[label="Rename session"] input',
        );
        await openRename();
        await field.waitFor({ state: "visible" });
        await captureUiProof(suite, page, `${surface}-generated-title.png`);
        expect(await field.inputValue()).toBe(generatedTitle);
        await expect
          .poll(() => field.evaluate((input) => document.activeElement === input))
          .toBe(true);
        await page.keyboard.press("Enter");
        await field.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

        await openRename();
        await field.waitFor({ state: "visible" });
        await expect
          .poll(() => field.evaluate((input) => document.activeElement === input))
          .toBe(true);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type(" updated");
        expect(await field.inputValue()).toBe(`${generatedTitle} updated`);
        await page.keyboard.press("Escape");
        await field.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

        await openRename();
        await field.waitFor({ state: "visible" });
        await expect
          .poll(() => field.evaluate((input) => document.activeElement === input))
          .toBe(true);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type(" updated");
        if (surface === "header") {
          await page.keyboard.press("Enter");
        } else {
          await page.locator("openclaw-modal-dialog").getByRole("button", { name: "Save" }).click();
        }
        const patchRequest = await gateway.waitForRequest("sessions.patch");
        expect(patchRequest.params).toMatchObject({
          key,
          expectedSessionId: original.sessionId,
          label: `${generatedTitle} updated`,
        });
        await expect.poll(() => row.textContent()).toContain(`${generatedTitle} updated`);
        await openRename();
        await expect.poll(() => field.inputValue()).toBe(`${generatedTitle} updated`);
        await captureUiProof(suite, page, `${surface}-renamed-title.png`);
        await field.fill("");
        await field.press("Enter");
        await expect.poll(() => row.textContent()).not.toContain(`${generatedTitle} updated`);
        await openRename();
        await expect.poll(() => field.inputValue()).toBe(generatedTitle);
        await gateway.closeLatest();
        await field.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
      } finally {
        await context.close();
      }
    },
  );
});
