import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  controlUiSessionPath,
  captureNewSessionComposerUiProof,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const methods = ["chat.metadata", "chat.startup", "sessions.create", "sessions.title.prepare"];

suite.define(() => {
  it("prepares a creation title after idle and never regenerates it in an ongoing chat", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: {
          "sessions.title.prepare": { title: "Repair sidebar naming" },
          "sessions.create": { key: "agent:main:prepared-title", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.fill("repair the sidebar naming");
      await gateway.waitForRequest("sessions.title.prepare");
      expect(
        await page.getByText("When you pause, draft text is sent", { exact: false }).count(),
      ).toBe(0);
      expect(await page.getByText("Session name:", { exact: false }).count()).toBe(0);
      await captureNewSessionComposerUiProof(suite, page, "prepared-title-composer.png");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.getByRole("button", { name: "Start session" }).click();
      expect(await gateway.waitForRequest("sessions.create")).toMatchObject({
        params: { displayName: "Repair sidebar naming", message: "repair the sidebar naming" },
      });
      await page.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:prepared-title"),
      );
      await page.clock.install();
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("another topic in the ongoing chat");
      await page.clock.runFor(2_000);
      expect(await gateway.getRequests("sessions.title.prepare")).toHaveLength(1);
    });
  });

  it("recovers title preparation when blur drops compositionend", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: { "sessions.title.prepare": { title: "Composed draft" } },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.clock.install();
      const message = page.locator(".new-session-page__message");
      await message.dispatchEvent("compositionstart");
      await message.fill("compose a draft through an input method editor");
      await page.clock.runFor(2_000);
      expect(await gateway.getRequests("sessions.title.prepare")).toHaveLength(0);
      await message.blur();
      await page.clock.runFor(1_500);
      expect(await gateway.getRequests("sessions.title.prepare")).toHaveLength(1);
      await page.getByRole("button", { name: "Start session" }).click();
      expect(await gateway.waitForRequest("sessions.create")).toMatchObject({
        params: { displayName: "Composed draft" },
      });
    });
  });

  it("starts without waiting for a pending title and disables draft inference in incognito", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        deferredMethods: ["sessions.title.prepare"],
        methodResponses: {
          "sessions.create": { key: "agent:main:pending-title", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.fill("prepare a draft name without blocking");
      await gateway.waitForRequest("sessions.title.prepare");
      await page.getByRole("button", { name: "Start session" }).click();
      const created = await gateway.waitForRequest("sessions.create");
      expect(created.params).not.toHaveProperty("displayName");
      await gateway.resolveDeferred("sessions.title.prepare", { title: "Too late to rename" });
      await page.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:pending-title"),
      );
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await page.goto(`${suite.server.baseUrl}new`);
      await page.getByRole("switch", { name: "Incognito", exact: true }).click();
      await page.clock.install();
      await message.fill("this incognito draft must not be sent");
      await page.clock.runFor(2_000);
      expect(await gateway.getRequests("sessions.title.prepare")).toHaveLength(0);
    });
  });
});
