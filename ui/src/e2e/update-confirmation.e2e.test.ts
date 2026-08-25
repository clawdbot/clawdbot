import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update confirmation E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const UPDATE_AVAILABLE = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
} as const;
const UPDATE_RUN_RESPONSE = {
  ok: true,
  restart: null,
  result: { after: { version: "2.0.0" }, status: "ok" },
} as const;
const PROOF_DIR = path.resolve(".artifacts/control-ui-e2e/update-confirmation");

/** The dialog element lives in a shadow root; its visible copy is slotted light DOM. */
function confirmationCopy(page: Page) {
  return page.locator("openclaw-modal-dialog");
}

function confirmationDialog(page: Page) {
  return page.getByRole("dialog", { name: "Update Gateway", exact: true });
}

async function openUpdateCard(page: Page, baseUrl: string, compact = false) {
  const gateway = await installMockGateway(page, {
    methodResponses: { "update.run": UPDATE_RUN_RESPONSE },
  });
  expect((await page.goto(`${baseUrl}chat`))?.status()).toBe(200);
  await gateway.waitForRequest("chat.startup");
  await gateway.emitGatewayEvent("update.available", { updateAvailable: UPDATE_AVAILABLE });
  if (compact) {
    await page.locator(".chat-header-session-menu__trigger").click();
    const updateButton = page.getByText("Update available v2.0.0", { exact: true });
    await updateButton.waitFor({ timeout: 10_000 });
    return { compact, gateway, updateButton };
  }
  await page.locator(".sidebar-issues-button").click();
  const updateIssue = page.locator(
    'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
  );
  await updateIssue.locator("summary").click();
  const updateButton = updateIssue.locator(".sidebar-update-card__action");
  await updateButton.waitFor({ timeout: 10_000 });
  return { compact, gateway, updateButton };
}

async function openConfirmation(page: Page, updateButton: Locator, compact = false) {
  await updateButton.click();
  if (compact) {
    await page.getByRole("button", { name: "Update now", exact: true }).click();
  }
}

suite.define(() => {
  it("shares one dismissal across the footer and Inbox until the Gateway boot changes", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 720, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          gatewayBootId: "gateway-boot-a",
          operatorScopes: ["operator.admin", "operator.read"],
          updateAvailable: UPDATE_AVAILABLE,
          updateSchedule: {
            channel: "stable",
            autoEnabled: false,
            target: { kind: "package", version: "2.0.0" },
          },
        });
        expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");

        const footerUpdate = page.locator(".sidebar-footer-update");
        await footerUpdate.waitFor();
        expect(await footerUpdate.isEnabled()).toBe(true);
        expect(
          await page
            .locator("openclaw-sidebar-attention")
            .evaluate((attention) =>
              [...attention.children]
                .map((child) => child.className)
                .filter((className) => typeof className === "string" && className.length > 0),
            ),
        ).toEqual(["sr-only", "sidebar-issues-button", "sidebar-footer-update-slot"]);
        expect((await footerUpdate.boundingBox())?.width).toBe(28);
        const inboxBox = await page.locator(".sidebar-issues-button").boundingBox();
        const updateSlotBox = await page.locator(".sidebar-footer-update-slot").boundingBox();
        expect(inboxBox).not.toBeNull();
        expect(updateSlotBox).not.toBeNull();
        expect(updateSlotBox!.x - (inboxBox!.x + inboxBox!.width)).toBe(8);
        await page.locator(".sidebar-issues-button").click();
        await page
          .locator('openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]')
          .waitFor();
        await page.locator(".sidebar-issues-button").click();

        await footerUpdate.hover();
        await expect.poll(async () => (await footerUpdate.boundingBox())?.width).toBe(76);
        const expandedInboxBox = await page.locator(".sidebar-issues-button").boundingBox();
        expect(expandedInboxBox).not.toBeNull();
        const dismissButton = page.locator(".sidebar-footer-update__dismiss");
        expect(await dismissButton.getAttribute("aria-label")).toBe(
          "Hide until next restart or update",
        );
        await expect
          .poll(() => dismissButton.evaluate((button) => getComputedStyle(button).opacity))
          .toBe("1");
        await dismissButton.hover();
        await expect.poll(async () => (await footerUpdate.boundingBox())?.width).toBe(76);
        await expect
          .poll(async () => {
            const inboxBoxOnDismiss = await page.locator(".sidebar-issues-button").boundingBox();
            return Math.abs(inboxBoxOnDismiss!.x - expandedInboxBox!.x);
          })
          .toBeLessThanOrEqual(0.5);
        await dismissButton.click();
        await footerUpdate.waitFor({ state: "detached" });
        await page.locator(".sidebar-issues-button").click();
        expect(
          await page
            .locator('openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]')
            .count(),
        ).toBe(0);
        await page.locator(".sidebar-issues-button").click();

        await page.locator(".sidebar-identity-card").click();
        await page.getByText("Update available", { exact: true }).waitFor();
        await page.keyboard.press("Escape");

        await page.reload();
        await gateway.waitForRequest("chat.startup");
        expect(await page.locator(".sidebar-footer-update").count()).toBe(0);

        await gateway.setGatewayBootId("gateway-boot-b");
        await gateway.setOnline(false);
        await gateway.setOnline(true);
        await page.locator(".sidebar-footer-update").waitFor();
      },
    );
  });

  it("keeps the update visible but non-dismissible for read-only operators", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 720, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          gatewayBootId: "gateway-boot-read-only",
          operatorScopes: ["operator.read"],
          updateAvailable: UPDATE_AVAILABLE,
          updateSchedule: {
            channel: "stable",
            autoEnabled: false,
            target: { kind: "package", version: "2.0.0" },
          },
        });
        expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");

        const footerUpdate = page.locator(".sidebar-footer-update");
        await footerUpdate.waitFor();
        expect(await footerUpdate.isDisabled()).toBe(true);
        expect(await page.locator(".sidebar-footer-update__dismiss").count()).toBe(0);

        await page.locator(".sidebar-issues-button").click();
        const updateIssue = page.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        await updateIssue.waitFor();
        expect(await updateIssue.locator(".sidebar-issues-panel__dismiss").count()).toBe(0);
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      },
    );
  });

  it("opens a confirmation that states the action, target, versions, and restart impact", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 720, width: 1280 } },
      async ({ page }) => {
        const { gateway, updateButton } = await openUpdateCard(page, suite.server.baseUrl);
        await page.screenshot({
          animations: "disabled",
          path: path.join(PROOF_DIR, "01-update-affordance-light.png"),
        });

        await openConfirmation(page, updateButton);

        const dialog = confirmationDialog(page);
        await dialog.waitFor();
        expect(await dialog.getAttribute("aria-label")).toBe("Update Gateway");
        const dialogText = await confirmationCopy(page).textContent();
        expect(dialogText).toContain(
          "Installs the available update on the connected Gateway and restarts it.",
        );
        expect(dialogText).toContain("this Control UI disconnects until the Gateway is back");
        expect(dialogText).toContain("Installed v1.0.0 · Available v2.0.0");
        // The first click must not reach the Gateway.
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await page.screenshot({
          animations: "disabled",
          path: path.join(PROOF_DIR, "02-confirmation-light.png"),
        });
      },
    );
  });

  it("renders the same confirmation in dark mode and on a compact viewport", async () => {
    for (const variant of [
      { colorScheme: "dark", name: "03-confirmation-dark", viewport: { height: 720, width: 1280 } },
      {
        colorScheme: "light",
        name: "04-confirmation-compact",
        viewport: { height: 780, width: 420 },
      },
    ] as const) {
      await suite.withPage(
        {
          colorScheme: variant.colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: variant.viewport,
        },
        async ({ page }) => {
          const compact = variant.viewport.width < 600;
          const { gateway, updateButton } = await openUpdateCard(
            page,
            suite.server.baseUrl,
            compact,
          );
          await openConfirmation(page, updateButton, compact);
          await confirmationDialog(page).waitFor();
          expect(
            await confirmationCopy(page)
              .getByRole("button", { name: "Update and restart", exact: true })
              .isVisible(),
          ).toBe(true);
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          await page.screenshot({
            animations: "disabled",
            path: path.join(PROOF_DIR, `${variant.name}.png`),
          });
        },
      );
    }
  });

  it.each([
    { dismiss: "Escape" as const, name: "Escape" },
    { dismiss: "cancel" as const, name: "Cancel" },
  ])("makes no update request when the operator dismisses with $name", async ({ dismiss }) => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 720, width: 1280 } },
      async ({ page }) => {
        const { gateway, updateButton } = await openUpdateCard(page, suite.server.baseUrl);
        await openConfirmation(page, updateButton);
        await confirmationDialog(page).waitFor();

        if (dismiss === "Escape") {
          await page.keyboard.press("Escape");
        } else {
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
        }
        await confirmationDialog(page).waitFor({ state: "detached" });

        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      },
    );
  });

  it("keeps the update-opening keypress from confirming and lets a later Return confirm once", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 720, width: 1280 } },
      async ({ page }) => {
        const { gateway, updateButton } = await openUpdateCard(page, suite.server.baseUrl);

        await updateButton.focus();
        await page.keyboard.press("Enter");
        const dialog = confirmationDialog(page);
        await dialog.waitFor();

        // The keypress that opened the dialog lands on Cancel, never on the confirm action.
        const cancel = page.getByRole("button", { name: "Cancel", exact: true });
        await expect
          .poll(() => cancel.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await page.screenshot({
          animations: "disabled",
          path: path.join(PROOF_DIR, "05-confirmation-initial-focus.png"),
        });

        const confirm = confirmationCopy(page).getByRole("button", {
          name: "Update and restart",
          exact: true,
        });
        await confirm.focus();
        await page.screenshot({
          animations: "disabled",
          path: path.join(PROOF_DIR, "06-confirmation-confirm-focus.png"),
        });
        await page.keyboard.press("Enter");

        await gateway.waitForRequest("update.run");
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
      },
    );
  });

  it("sends exactly one update request when the confirm action is clicked", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 720, width: 1280 } },
      async ({ page }) => {
        const { gateway, updateButton } = await openUpdateCard(page, suite.server.baseUrl);
        await openConfirmation(page, updateButton);
        await confirmationDialog(page).waitFor();

        await confirmationCopy(page)
          .getByRole("button", { name: "Update and restart", exact: true })
          .click();
        await gateway.waitForRequest("update.run");
        await confirmationCopy(page)
          .getByRole("button", { name: "Updating…", exact: true })
          .waitFor();
        await page.screenshot({
          animations: "disabled",
          path: path.join(PROOF_DIR, "07-update-running.png"),
        });

        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        const footerUpdate = page.locator(".sidebar-footer-update");
        await expect.poll(() => footerUpdate.isDisabled()).toBe(true);
        await page.locator(".sidebar-issues-button").click();
        const updateIssue = page.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        await updateIssue.locator("summary").click();
        expect(await updateIssue.locator(".sidebar-update-card__action").isDisabled()).toBe(true);
      },
    );
  });

  it("applies the same confirmation to the Settings update row", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const config = { update: { auto: { enabled: false }, channel: "stable" } };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "config.set", "update.run"],
          methodResponses: {
            "config.get": {
              config,
              hash: "update-confirmation-1",
              issues: [],
              raw: JSON.stringify(config),
              runtimeConfig: config,
              valid: true,
            },
            "update.run": UPDATE_RUN_RESPONSE,
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
        await gateway.waitForRequest("config.get");
        await gateway.emitGatewayEvent("update.available", { updateAvailable: UPDATE_AVAILABLE });
        await page.getByRole("button", { name: "Update now", exact: true }).click();

        const dialog = confirmationDialog(page);
        await dialog.waitFor();
        expect(await confirmationCopy(page).textContent()).toContain(
          "Installed v1.0.0 · Available v2.0.0",
        );
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await page.screenshot({
          animations: "disabled",
          path: path.join(PROOF_DIR, "08-settings-confirmation.png"),
        });

        await confirmationCopy(page)
          .getByRole("button", { name: "Update and restart", exact: true })
          .click();
        await gateway.waitForRequest("update.run");
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
      },
    );
  });
});
