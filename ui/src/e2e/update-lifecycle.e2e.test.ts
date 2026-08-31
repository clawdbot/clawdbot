// Proves the operator-visible lifecycle of a dev-channel Gateway update: the
// confirmation, the multi-minute install, the reconnect result, and a failure
// that names the cause the updater recorded.
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update lifecycle E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const DEV_UPDATE_AVAILABLE = {
  channel: "dev",
  commitsBehind: 246,
  currentSha: "1111111111111111111111111111111111111111",
  currentVersion: "2026.8.1",
  latestVersion: "2026.8.1",
  upstreamRef: "origin/main",
  upstreamSha: "9f3c21a0000000000000000000000000000000aa",
} as const;

const DEV_UPDATE_SCHEDULE = {
  autoEnabled: false,
  channel: "dev",
  install: { kind: "git" as const, git: { status: "behind" as const, commitsBehind: 246 } },
  target: {
    kind: "git" as const,
    commitsBehind: 246,
    upstreamRef: "origin/main",
    upstreamSha: "9f3c21a0000000000000000000000000000000aa",
  },
};

const HANDOFF_STARTED_RESPONSE = {
  ok: true,
  handoff: { status: "started" },
  result: { reason: "managed-service-handoff-started", status: "skipped" },
} as const;

const HANDOFF_PENDING_SENTINEL = {
  sentinel: {
    kind: "update",
    status: "skipped",
    stats: { reason: "managed-service-handoff-started" },
  },
};

async function openUpdateConfirmation(page: Page): Promise<void> {
  await page.locator(".sidebar-issues-button").click();
  const updateIssue = page.locator(
    'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
  );
  await updateIssue.locator("summary").click();
  await updateIssue.locator(".sidebar-update-card__action").click();
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "narrates a dev-channel update through to its recorded success (%s)",
    async (colorScheme) => {
      const artifactDir = createControlUiE2eArtifactDir(`update-lifecycle-${colorScheme}`);
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 720, width: 1280 },
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(String(error)));
          const gateway = await installMockGateway(page, {
            deferredMethods: ["update.run"],
            methodResponses: {
              "update.run": HANDOFF_STARTED_RESPONSE,
              "update.status": {
                sequence: [
                  HANDOFF_PENDING_SENTINEL,
                  {
                    sentinel: {
                      kind: "update",
                      status: "ok",
                      // A git install keeps its version and moves its commit;
                      // the post-restart finalizer stamps both.
                      stats: {
                        after: {
                          sha: "9f3c21a0000000000000000000000000000000aa",
                          version: "2026.8.1",
                        },
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
            schedule: DEV_UPDATE_SCHEDULE,
            updateAvailable: DEV_UPDATE_AVAILABLE,
          });

          await openUpdateConfirmation(page);
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Update and restart", exact: true })
            .waitFor();
          // The modal fades in; capture it settled so the proof is readable.
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(artifactDir, "1-confirm-dialog.png") });
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Update and restart", exact: true })
            .click();

          const updating = page.getByRole("button", { name: "Updating…", exact: true });
          await updating.waitFor();
          expect(await updating.isEnabled()).toBe(false);
          await page.getByText("Installing the update on the Gateway", { exact: false }).waitFor();
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
          await page.screenshot({ path: path.join(artifactDir, "2-installing.png") });

          await gateway.resolveDeferred("update.run", HANDOFF_STARTED_RESPONSE);
          await gateway.closeLatest(1012, "managed update handoff");

          await page.getByText("The Gateway is restarting", { exact: false }).waitFor();
          await page.screenshot({ path: path.join(artifactDir, "3-restarting.png") });

          // The replacement Gateway reports the installed revision, so the
          // operator gets a result instead of a silently reverted banner. The
          // verified install also reloads this stale document, so the outcome
          // has to survive that reload to be seen at all.
          await page
            .getByText("Gateway updated · now on 9f3c21a.", { exact: true })
            .waitFor({ timeout: 20_000 });
          await page.screenshot({ path: path.join(artifactDir, "4-success-toast.png") });
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );

  it.each(["light", "dark"] as const)(
    "names the recorded cause when the install fails (%s)",
    async (colorScheme) => {
      const artifactDir = createControlUiE2eArtifactDir(`update-failure-cause-${colorScheme}`);
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 720, width: 1280 },
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(String(error)));
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "update.run": HANDOFF_STARTED_RESPONSE,
              "update.status": {
                sequence: [
                  HANDOFF_PENDING_SENTINEL,
                  {
                    sentinel: {
                      kind: "update",
                      status: "error",
                      stats: {
                        reason: "deps-install-failed",
                        steps: [
                          { name: "fetch", log: { exitCode: 0, stderrTail: "" } },
                          {
                            name: "install",
                            log: {
                              exitCode: 1,
                              stderrTail:
                                "Progress: resolved 1204\nENOSPC: no space left on device, write",
                            },
                          },
                        ],
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
            schedule: DEV_UPDATE_SCHEDULE,
            updateAvailable: DEV_UPDATE_AVAILABLE,
          });

          await openUpdateConfirmation(page);
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Update and restart", exact: true })
            .click();
          await page.getByRole("button", { name: "Updating…", exact: true }).waitFor();
          await gateway.closeLatest(1012, "managed update handoff");

          // The initiating dialog owns the recorded outcome in place.
          await page
            .locator("openclaw-modal-dialog")
            .getByText(
              "The update failed at install: ENOSPC: no space left on device, write. Dependency install failed. Fix the install error and retry.",
              { exact: true },
            )
            .waitFor({ timeout: 20_000 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(artifactDir, "5-failure-in-dialog.png") });
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );
});
