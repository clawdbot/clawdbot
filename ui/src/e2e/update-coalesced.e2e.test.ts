import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI coalesced update E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";
const MANAGED_UPDATE_PENDING_SENTINEL = {
  kind: "update",
  status: "skipped",
  ts: 1_000,
  stats: { handoffId: "managed-update-handoff", reason: "managed-service-handoff-started" },
} as const;
const MANAGED_UPDATE_HANDOFF_RESPONSE = {
  ok: true,
  handoff: { status: "started" },
  result: { reason: "managed-service-handoff-started", status: "skipped" },
  sentinel: { payload: MANAGED_UPDATE_PENDING_SENTINEL },
} as const;

async function openUpdateConfirmation(page: Page): Promise<void> {
  await page.locator(".sidebar-issues-button").click();
  const updateIssue = page.locator(
    'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
  );
  await updateIssue.locator("summary").click();
  await updateIssue.locator(".sidebar-update-card__action").click();
}

async function captureUpdateProof(
  page: Page,
  artifactDir: string,
  fileName: string,
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({ path: path.join(artifactDir, fileName) });
}

suite.define(() => {
  it("explains a disabled update to a read-only mobile operator", async () => {
    const artifactDir = captureUiProofEnabled
      ? path.join(suite.artifactDir, "update-read-only-mobile")
      : "";
    await suite.withPage(
      {
        colorScheme: "dark",
        hasTouch: true,
        isMobile: true,
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: artifactDir, size: { height: 1200, width: 555 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 1200, width: 555 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read"],
        });

        expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: {
            channel: "stable",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          },
        });

        await page.locator(".sidebar-issues-button").click();
        const updateIssue = page.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        await updateIssue.locator("summary").click();
        const action = updateIssue.locator(".sidebar-update-card__action");
        await expect.poll(() => action.getAttribute("aria-disabled")).toBe("true");
        expect(await action.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(
          false,
        );
        await captureUpdateProof(page, artifactDir, "disabled-update.png");

        const tooltip = updateIssue.locator("openclaw-tooltip wa-tooltip");
        await tooltip.evaluate((element) => {
          element.addEventListener(
            "wa-after-show",
            () => element.setAttribute("data-e2e-after-show", ""),
            { once: true },
          );
        });
        await updateIssue.locator(".sidebar-update-card__actions").tap();
        await expect.poll(() => tooltip.getAttribute("data-e2e-after-show")).not.toBeNull();
        expect(await tooltip.textContent()).toContain("Administrator access is required");
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await captureUpdateProof(page, artifactDir, "disabled-update-tooltip.png");
      },
    );
  });

  it("shows package update failure status after the Update click", async () => {
    const artifactDir = captureUiProofEnabled
      ? path.join(suite.artifactDir, "update-package-status")
      : "";
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: artifactDir, size: { height: 720, width: 1280 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "update.run": {
              ok: false,
              result: { reason: "global-install-failed", status: "error" },
            },
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");
        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: {
            channel: "stable",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          },
        });

        await openUpdateConfirmation(page);
        await page
          .locator("openclaw-modal-dialog")
          .getByRole("button", { name: "Update and restart", exact: true })
          .click();
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog
          .getByText(
            "Update error: global-install-failed. The global package install did not verify on disk. Retry or reinstall from the CLI.",
            { exact: false },
          )
          .waitFor();
        expect(await dialog.textContent()).toContain("openclaw triage");
        expect(await dialog.textContent()).toContain("Diagnose the cause before retrying.");

        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
        // Failure triage navigates to Updates when Ask OpenClaw is unavailable.
        await page.waitForURL("**/settings/updates");
        await page.locator("openclaw-config-page").waitFor();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await page.locator(".sidebar-issues-button").click();
        const updateIssue = page.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        await updateIssue.locator("summary").click();
        const reason = updateIssue.locator(".sidebar-update-card__compact-reason");
        await reason.waitFor();
        expect(await reason.textContent()).toContain("global-install-failed");
        expect(await page.locator(".sidebar-issues-button__count").count()).toBe(1);
        expect(pageErrors).toEqual([]);
        await captureUpdateProof(page, artifactDir, "package-update-failure.png");
      },
    );
  });

  it("shows coalesced restart feedback after the Update click", async () => {
    const artifactDir = captureUiProofEnabled
      ? path.join(suite.artifactDir, "update-coalesced")
      : "";
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: artifactDir, size: { height: 720, width: 1280 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "update.run": {
              ok: true,
              restart: { coalesced: true },
              result: { after: { version: "2.0.0" }, status: "ok" },
            },
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");
        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: {
            channel: "stable",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          },
        });

        await openUpdateConfirmation(page);
        await page
          .locator("openclaw-modal-dialog")
          .getByRole("button", { name: "Update and restart", exact: true })
          .click();
        await page.getByRole("button", { name: "Updating…", exact: true }).waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.locator(".sidebar-issues-button").click();
        const updateIssue = page.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        await updateIssue.locator("summary").click();
        await updateIssue
          .getByText(
            "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
            { exact: true },
          )
          .waitFor();
        expect(await page.locator(".sidebar-issues-button__count").count()).toBe(1);
        expect(pageErrors).toEqual([]);
        await captureUpdateProof(page, artifactDir, "coalesced-restart-banner.png");
      },
    );
  });

  it.each([
    {
      artifactName: "response-first",
      expectedStatusRequests: 4,
      expectedText: "Expected v2.0.0, running v1.0.0",
      name: "after the response arrives before disconnect",
      responseFirst: true,
    },
    {
      artifactName: "disconnect-first",
      expectedStatusRequests: 4,
      expectedText: "Expected v2.0.0, running v1.0.0",
      name: "when disconnect arrives before the response",
      responseFirst: false,
    },
  ])(
    "settles the managed update $name",
    async ({ artifactName, expectedStatusRequests, expectedText, responseFirst }) => {
      const artifactDir = captureUiProofEnabled
        ? path.join(suite.artifactDir, `update-managed-handoff-${artifactName}`)
        : "";
      await suite.withPage(
        {
          locale: "en-US",
          recordVideo: captureUiProofEnabled
            ? { dir: artifactDir, size: { height: 720, width: 1280 } }
            : undefined,
          serviceWorkers: "block",
          viewport: { height: 720, width: 1280 },
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(String(error)));
          const gateway = await installMockGateway(page, {
            deferredMethods: ["update.run"],
            methodResponses: {
              "update.run": MANAGED_UPDATE_HANDOFF_RESPONSE,
              "update.status": {
                sequence: [
                  { sentinel: null },
                  { sentinel: MANAGED_UPDATE_PENDING_SENTINEL },
                  {
                    sentinel: {
                      kind: "update",
                      status: "ok",
                      ts: 2_000,
                      stats: {
                        handoffId: "managed-update-handoff",
                        after: { version: "1.0.0" },
                      },
                    },
                  },
                ],
              },
            },
          });

          expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
          await gateway.waitForRequest("chat.startup");
          await gateway.emitGatewayEvent("update.available", {
            updateAvailable: {
              channel: "stable",
              currentVersion: "1.0.0",
              latestVersion: "2.0.0",
            },
          });

          await openUpdateConfirmation(page);
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Update and restart", exact: true })
            .click();
          await gateway.waitForRequest("update.run");
          if (responseFirst) {
            await gateway.resolveDeferred("update.run", MANAGED_UPDATE_HANDOFF_RESPONSE);
            await page.getByRole("button", { name: "Updating…", exact: true }).waitFor();
          }
          await gateway.closeLatest(1012, "managed update handoff");

          try {
            // Without an Ask OpenClaw method, failure opens Updates. Its status
            // refresh must preserve the mismatch already verified on reconnect.
            await page.waitForURL("**/settings/updates");
            await expect
              .poll(async () => (await gateway.getRequests("update.status")).length)
              .toBe(expectedStatusRequests);
            await page
              .locator("openclaw-modal-dialog")
              .getByText(expectedText, { exact: false })
              .waitFor({ timeout: 15_000 });
          } catch (error) {
            await captureControlUiE2eFailureDiagnostics(page, {
              error: error instanceof Error ? error : new Error(String(error)),
              label: `managed-handoff-${artifactName}`,
              pageErrors,
            });
            throw error;
          }
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
          expect(await gateway.getRequests("update.status")).toHaveLength(expectedStatusRequests);
          expect(pageErrors).toEqual([]);
          await captureUpdateProof(page, artifactDir, `managed-handoff-${artifactName}.png`);
        },
      );
    },
  );

  it("shows and routes the update target from live Mac app ownership", async () => {
    const artifactDir = captureUiProofEnabled
      ? path.join(suite.artifactDir, "update-ownership")
      : "";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    await context.addInitScript(() => {
      const nativeWindow = window as unknown as {
        openClawUpdateMessages: unknown[];
        webkit: {
          messageHandlers: { openclawUpdate: { postMessage: (message: unknown) => void } };
        };
      };
      nativeWindow.openClawUpdateMessages = [];
      nativeWindow.webkit = {
        messageHandlers: {
          openclawUpdate: {
            postMessage: (message) => nativeWindow.openClawUpdateMessages.push(message),
          },
        },
      };
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "update.run": {
          ok: true,
          restart: null,
          result: { after: { version: "2.0.0" }, status: "ok" },
        },
      },
    });

    try {
      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("chat.startup");
      await gateway.emitGatewayEvent("update.available", {
        updateAvailable: {
          channel: "stable",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
        },
      });

      await openUpdateConfirmation(page);
      await page.getByRole("button", { name: "Update Mac app and restart", exact: true }).click();
      expect(
        await page.evaluate(
          () => (window as unknown as { openClawUpdateMessages: unknown[] }).openClawUpdateMessages,
        ),
      ).toEqual([{ type: "start-update" }]);
      expect(await gateway.getRequests("update.run")).toHaveLength(0);

      // The confirmation closes the lazy Inbox. Recovery belongs to the
      // persistent attention owner, not the now-disconnected update card.
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator(".sidebar-issues-panel").count()).toBe(0);
      await page.evaluate(
        (eventName) => window.dispatchEvent(new CustomEvent(eventName)),
        NATIVE_UPDATE_DECLINED_EVENT,
      );
      await expect.poll(async () => (await gateway.getRequests("update.run")).length).toBe(1);
      expect(pageErrors).toEqual([]);
      await captureUpdateProof(page, artifactDir, "gateway-update-target.png");
    } finally {
      await context.close();
    }
  });
});
