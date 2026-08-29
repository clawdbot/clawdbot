// Real routing and browser storage; Gateway/provider sign-in is mocked.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI first-run wizard cancellation ownership",
  startServerBeforeBrowser: true,
});
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
const detection = {
  candidates: [],
  manualProviders: [],
  authOptions: [{ id: "provider-login", label: "Provider login", kind: "oauth", featured: true }],
  workspace: "/tmp/openclaw-e2e",
  setupComplete: false,
};

const gatewayOptions = {
  featureMethods: [
    "openclaw.setup.detect",
    "openclaw.setup.activate",
    "openclaw.setup.auth.start",
    "wizard.next",
    "wizard.cancel",
  ],
  methodResponses: {
    "openclaw.setup.detect": detection,
    "openclaw.setup.auth.start": { done: false, status: "running" },
    "wizard.next": {
      done: false,
      status: "running",
      step: { id: "login", type: "text", message: "Complete provider sign-in" },
    },
    "wizard.cancel": { status: "cancelled" },
  },
};

suite.define(() => {
  it.each(["before return", "after return"])(
    "allows sign-in again after Cancel, route exit, and confirmed cancellation (%s)",
    async (acknowledgement) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, gatewayOptions);
          await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
          const signIn = page.locator('[data-auth-choice="provider-login"] button');
          await signIn.click();
          await page.getByText("Complete provider sign-in").waitFor();
          const readReceipt = () => page.evaluate((key) => localStorage.getItem(key), receiptKey);
          expect(await readReceipt()).not.toBeNull();
          await gateway.deferNext("wizard.cancel");
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await gateway.waitForRequest("wizard.cancel");
          await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
          await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
          await expect.poll(() => page.locator("openclaw-model-setup-page").count()).toBe(0);
          expect(await readReceipt()).not.toBeNull();
          if (acknowledgement === "before return") {
            await gateway.resolveDeferred("wizard.cancel");
          }
          await page.goBack();
          await signIn.waitFor();
          if (acknowledgement === "after return") {
            await gateway.resolveDeferred("wizard.cancel");
          }
          if (artifactDir) {
            await mkdir(artifactDir, { recursive: true });
            await page.screenshot({
              path: path.join(artifactDir, `cancel-${acknowledgement.replaceAll(" ", "-")}.png`),
              animations: "disabled",
            });
          }
          await expect.poll(readReceipt).toBeNull();
          await signIn.click();
          await page.getByText("Complete provider sign-in").waitFor();
          expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(2);
          expect(await gateway.getRequests("wizard.cancel")).toHaveLength(1);
          expect(await gateway.getRequests("openclaw.setup.activate")).toHaveLength(0);
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
        },
      );
    },
  );
  it("preserves a replacement tab's receipt when the old page confirms cancellation", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block" },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, gatewayOptions);
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        await page.locator('[data-auth-choice="provider-login"] button').click();
        await page.getByText("Complete provider sign-in").waitFor();
        await gateway.deferNext("wizard.cancel");
        await page
          .locator("openclaw-modal-dialog")
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await gateway.waitForRequest("wizard.cancel");
        await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
        await expect.poll(() => page.locator("openclaw-model-setup-page").count()).toBe(0);

        const replacement = await context.newPage();
        const nextGateway = await installMockGateway(replacement, gatewayOptions);
        // Opening ordinary Model Setup explicitly leaves first-run intent. A
        // later onboarding visit can start a separate operation in this tab.
        await replacement.goto(`${suite.server.baseUrl}settings/model-setup`);
        await replacement.locator('[data-auth-choice="provider-login"] button').waitFor();
        await expect
          .poll(() => replacement.evaluate((key) => localStorage.getItem(key), receiptKey))
          .toBeNull();
        await replacement.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        await replacement.locator('[data-auth-choice="provider-login"] button').click();
        await replacement.getByText("Complete provider sign-in").waitFor();
        const receipt = await replacement.evaluate((key) => localStorage.getItem(key), receiptKey);
        expect(receipt).not.toBeNull();
        await gateway.resolveDeferred("wizard.cancel");
        await page.goBack();
        await page.locator('[data-auth-choice="provider-login"] button').waitFor();
        expect(await replacement.evaluate((key) => localStorage.getItem(key), receiptKey)).toBe(
          receipt,
        );
        await replacement.getByText("Complete provider sign-in").waitFor();
        expect(await nextGateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
        expect(await nextGateway.getRequests("wizard.cancel")).toHaveLength(0);
        expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
        expect(new URL(replacement.url()).pathname).toBe("/settings/model-setup");
      },
    );
  });
});
