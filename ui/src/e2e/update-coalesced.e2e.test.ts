import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI coalesced update E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";
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
        const run = createUpdateRunFixture({
          phase: "finished",
          status: "failed",
          reason: "global-install-failed",
          finishedAtMs: Date.now(),
          steps: [
            {
              step: "install",
              status: "failed",
              detail: "Package install did not verify on disk.",
            },
          ],
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "update.run": {
              ok: false,
              runId: run.runId,
              result: { reason: run.reason, status: "error" },
            },
            "update.runs.get": { run },
            "update.status": { activeRun: null, lastRun: null },
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
          .getByText("⚠️ OpenClaw update failed: global-install-failed.", { exact: true })
          .first()
          .waitFor();
        expect(await dialog.textContent()).toContain("openclaw triage");
        expect(await dialog.textContent()).toContain("Package install did not verify on disk.");
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
        await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
        await dialog.getByRole("button", { name: "Review update", exact: true }).click();
        await page.waitForURL("**/settings/updates");
        await page.locator("openclaw-config-page").waitFor();
        expect(await dialog.count()).toBe(0);
        expect(await page.locator("openclaw-sidebar-attention").count()).toBe(0);
        await page
          .locator("openclaw-update-run-view")
          .getByText("⚠️ OpenClaw update failed: global-install-failed.", { exact: true })
          .first()
          .waitFor();
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
        const run = createUpdateRunFixture({ phase: "restarting" });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "update.run": {
              ok: true,
              runId: run.runId,
              restart: { coalesced: true },
              result: { after: { version: "2.0.0" }, status: "ok" },
            },
            "update.runs.get": { run },
            "update.status": { activeRun: null, lastRun: null },
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
          .getByText("⬆️ OpenClaw update in progress: restarting.", { exact: true })
          .first()
          .waitFor();
        await updateIssue.locator(".sidebar-update-card__action").click();
        await page
          .locator("openclaw-modal-dialog")
          .getByText("⬆️ OpenClaw update in progress: restarting.", { exact: true })
          .waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        expect(await page.locator(".sidebar-issues-button__count").count()).toBe(1);
        expect(pageErrors).toEqual([]);
        await captureUpdateProof(page, artifactDir, "coalesced-restart-banner.png");
      },
    );
  });

  it.each([
    {
      artifactName: "response-first",
      expectedText: "Expected v2.0.0, running v1.0.0",
      name: "after the response arrives before disconnect",
      responseFirst: true,
    },
    {
      artifactName: "disconnect-first",
      expectedText: "Expected v2.0.0, running v1.0.0",
      name: "when disconnect arrives before the response",
      responseFirst: false,
    },
  ])("settles the managed update $name", async ({ artifactName, expectedText, responseFirst }) => {
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
        let run = createUpdateRunFixture({
          phase: "restarting",
          before: { version: "1.0.0" },
          target: { kind: "package", version: "2.0.0" },
        });
        const response = { ok: true, runId: run.runId, handoff: { status: "started" } };
        const gateway = await installMockGateway(page, {
          deferredMethods: ["update.run"],
          methodResponses: {
            "update.runs.get": { run },
            "update.status": { activeRun: null, lastRun: null },
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
          await gateway.resolveDeferred("update.run", response);
          await page.getByRole("button", { name: "Updating…", exact: true }).waitFor();
        }
        await gateway.setOnline(false);
        run = {
          ...run,
          phase: "finished",
          status: "failed",
          reason: "version-mismatch",
          updatedAtMs: run.updatedAtMs + 1,
          finishedAtMs: Date.now(),
          after: { version: "1.0.0" },
          verification: {
            booted: true,
            serviceRunning: true,
            runningVersion: "1.0.0",
            versionMatch: false,
          },
          steps: [{ step: "verifying", status: "failed", detail: expectedText }],
        };
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
        await gateway.setGatewayBootId(`managed-handoff-${artifactName}`);
        await gateway.setOnline(true);

        try {
          const dialog = page.locator("openclaw-modal-dialog");
          await dialog.getByText(expectedText, { exact: false }).first().waitFor();
          expect(await dialog.locator('[data-oracle="version"]').getAttribute("data-state")).toBe(
            "fail",
          );
          expect(await dialog.locator("[data-run-id]").getAttribute("data-run-id")).toBe(run.runId);
        } catch (error) {
          await captureControlUiE2eFailureDiagnostics(page, {
            error: error instanceof Error ? error : new Error(String(error)),
            label: `managed-handoff-${artifactName}`,
            pageErrors,
          });
          throw error;
        }
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        expect(pageErrors).toEqual([]);
        await captureUpdateProof(page, artifactDir, `managed-handoff-${artifactName}.png`);
      },
    );
  });

  it.each(["available", "failed", "skipped"] as const)(
    "routes the %s sidebar update through live Mac app ownership",
    async (outcome) => {
      const artifactDir = captureUiProofEnabled
        ? path.join(suite.artifactDir, `update-ownership-${outcome}`)
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
      const run =
        outcome === "available"
          ? null
          : createUpdateRunFixture({
              phase: "finished",
              status: outcome,
              finishedAtMs: Date.now(),
            });
      const gateway = await installMockGateway(page, {
        featureMethods: ["openclaw.chat", "update.run"],
        methodResponses: {
          "update.status": { activeRun: null, lastRun: run },
          "update.runs.get": { run },
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
        if (run) {
          await page.getByRole("button", { name: "Retry update", exact: true }).click();
        }
        expect(await page.locator("openclaw-modal-dialog").getAttribute("label")).toBe(
          "Update Mac app + Gateway",
        );
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await captureUpdateProof(page, artifactDir, "native-update-confirmation.png");
        await page.getByRole("button", { name: "Update Mac app and restart", exact: true }).click();
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { openClawUpdateMessages: unknown[] }).openClawUpdateMessages,
          ),
        ).toEqual([{ type: "start-update" }]);
        expect(await gateway.getRequests("update.run")).toHaveLength(0);

        await page.keyboard.press("Control+Shift+,");
        await page.locator(".shell--settings").waitFor();
        expect(await page.locator("openclaw-sidebar-attention").count()).toBe(0);
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
    },
  );
});
