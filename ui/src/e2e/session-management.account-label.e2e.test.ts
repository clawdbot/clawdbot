import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
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
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
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
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
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

  it("opens a generated dashboard title as editable text", async () => {
    const key = "agent:main:dashboard:generated-title";
    const generatedTitle = "Hide OS tooltips for custom hovers";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          { ...sessionRow(key, generatedTitle, Date.now()), label: undefined },
        ]),
      },
      sessionKey: key,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      const title = page.locator(".chat-pane__session-title-button");
      await expect.poll(() => title.textContent()).toContain(generatedTitle);

      await title.click();
      const field = page.locator(".chat-pane__session-title-input");
      await field.waitFor({ state: "visible" });
      expect(await field.inputValue()).toBe(generatedTitle);

      await field.fill("Editable generated title");
      await field.press("Enter");
      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(patchRequest.params).toMatchObject({
        key,
        label: "Editable generated title",
      });
    } finally {
      await context.close();
    }
  });
});
