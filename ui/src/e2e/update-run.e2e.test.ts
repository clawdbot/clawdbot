import path from "node:path";
import { expect, it } from "vitest";
import type { UpdateRunPhase, UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createUpdateRunFixture } from "./update-run.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI update run E2E" });

suite.define(() => {
  it("resumes the same update after restart and keeps its successful report visible", async () => {
    const proofDir = createControlUiE2eArtifactDir("update-run", ".artifacts/control-ui-e2e");
    const viewport = { height: 1100, width: 1440 };
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: proofDir, size: viewport },
        serviceWorkers: "block",
        viewport,
      },
      async ({ context, page }) => {
        let run = createUpdateRunFixture();
        const config = { update: { auto: { enabled: false }, channel: "stable" } };
        const configResponse = {
          config,
          hash: "update-run-config",
          issues: [],
          raw: JSON.stringify(config),
          runtimeConfig: config,
          valid: true,
        };
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          agentModel: "openai/gpt-5.6-luna",
          models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
          updateAvailable: {
            channel: "stable",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          },
          methodResponses: {
            "config.get": configResponse,
            "update.run": { ok: true, runId: run.runId, result: { status: "ok" } },
            "update.runs.get": { run },
            "update.status": { activeRun: null, lastRun: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await gateway.waitForRequest("config.get");
        await page.getByRole("button", { name: "Update now", exact: true }).click();
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByRole("button", { name: "Update and restart", exact: true }).waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "01-before-confirm.png"),
        });

        await dialog.getByRole("button", { name: "Update and restart", exact: true }).click();
        await gateway.waitForRequest("update.run");
        expect((await gateway.waitForRequest("update.runs.get")).params).toEqual({
          runId: run.runId,
        });
        const runView = dialog.locator("openclaw-update-run-view");
        await runView
          .getByText("⬆️ OpenClaw update in progress: staging.", { exact: true })
          .waitFor();
        await runView.getByText("Downloading the update package.", { exact: false }).waitFor();
        expect(await runView.locator('[data-step="repairing"]').count()).toBe(0);
        await page.screenshot({ path: path.join(proofDir, "02-staging.png") });

        const advance = async (phase: UpdateRunPhase, detail: string) => {
          run = {
            ...run,
            phase,
            updatedAtMs: run.updatedAtMs + 1000,
            steps: [
              ...run.steps
                .filter((step) => step.step !== phase)
                .map((step) => Object.assign({}, step, { status: "completed" as const })),
              { step: phase, status: "in_progress", detail },
            ],
          };
          const reads = (await gateway.getRequests("update.runs.get")).length;
          await gateway.setMethodResponse("update.runs.get", { run });
          await gateway.emitGatewayEvent("update.run.changed", {
            runId: run.runId,
            phase: run.phase,
            status: run.status,
            updatedAtMs: run.updatedAtMs,
          });
          await gateway.waitForRequest("update.runs.get", { after: reads });
          await runView.getByText(detail, { exact: false }).waitFor();
        };
        await advance("validating", "Package integrity and startup checks passed.");
        await advance("activating", "Activating the verified package.");
        await advance("restarting", "Waiting for the Gateway to reconnect.");
        await gateway.setOnline(false);
        await runView.getByText("Gateway restarting…", { exact: true }).waitFor();
        expect(await dialog.count()).toBe(1);
        await page.screenshot({ path: path.join(proofDir, "03-restarting.png") });

        run = {
          ...run,
          phase: "verifying",
          updatedAtMs: run.updatedAtMs + 1000,
          after: { version: "2.0.0" },
          steps: [
            ...run.steps.map((step) => Object.assign({}, step, { status: "completed" as const })),
            {
              step: "verifying",
              status: "in_progress",
              detail: "Checking channels and readiness.",
            },
          ],
          verification: { booted: true, serviceRunning: true, runningVersion: "2.0.0" },
        };
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.setMethodResponse("update.status", { activeRun: run, lastRun: run });
        const readsBeforeReconnect = (await gateway.getRequests("update.runs.get")).length;
        await gateway.setGatewayBootId("update-run-restarted");
        await gateway.setOnline(true);
        expect(
          (await gateway.waitForRequest("update.runs.get", { after: readsBeforeReconnect })).params,
        ).toEqual({ runId: run.runId });
        await runView.getByText("Checking channels and readiness.", { exact: false }).waitFor();
        expect(await runView.locator('[data-step="repairing"]').count()).toBe(0);
        await page.screenshot({ path: path.join(proofDir, "04-verifying.png") });

        await advance("repairing", "Repairing the installed candidate after verification failed.");
        expect(await runView.locator('[data-step="repairing"]').getAttribute("data-status")).toBe(
          "in_progress",
        );
        await page.screenshot({ path: path.join(proofDir, "04-repairing.png") });
        await advance("verifying", "Verifying the repaired candidate.");

        const finishedAtMs = run.updatedAtMs + 1000;
        run = {
          ...run,
          phase: "finished",
          status: "succeeded",
          updatedAtMs: finishedAtMs,
          finishedAtMs,
          confirmedAtMs: finishedAtMs,
          downtimeMs: 1000,
          steps: run.steps.map((step) => Object.assign({}, step, { status: "completed" as const })),
          verification: {
            ...run.verification,
            versionMatch: true,
            pluginErrors: [],
            channelsReady: true,
          },
        } satisfies UpdateRunRecord;
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
        await gateway.emitGatewayEvent("update.run.changed", {
          runId: run.runId,
          phase: run.phase,
          status: run.status,
          updatedAtMs: run.updatedAtMs,
        });
        const headline = "✅ OpenClaw updated to 2.0.0 (from 1.0.0).";
        await runView.getByText(headline, { exact: true }).first().waitFor();
        await runView.getByText("Gateway downtime: 1s.", { exact: false }).waitFor();
        expect(await runView.locator('[data-oracle][data-state="pass"]').count()).toBe(4);
        expect(await runView.locator('[data-step="repairing"]').getAttribute("data-status")).toBe(
          "completed",
        );
        await page.screenshot({ path: path.join(proofDir, "05-after-success.png") });
        expect(await gateway.getRequests("update.run")).toHaveLength(1);

        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await page
          .locator("openclaw-update-run-view")
          .getByText(headline, { exact: true })
          .first()
          .waitFor();
        await page.locator(".update-run-view__report").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(proofDir, "06-settings-report.png") });

        // A fresh page has no in-memory run ID and must discover the last run from status.
        const freshPage = await context.newPage();
        const freshGateway = await installMockGateway(freshPage, {
          communityInvite: false,
          agentModel: "openai/gpt-5.6-luna",
          models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
          methodResponses: {
            "update.status": { activeRun: null, lastRun: run },
            "update.runs.get": { run },
            "config.get": configResponse,
          },
        });
        await freshPage.goto(`${suite.server.baseUrl}settings/updates`);
        await freshGateway.waitForRequest("update.status");
        await freshPage
          .locator("openclaw-update-run-view")
          .getByText(headline, { exact: true })
          .first()
          .waitFor();
        expect(await freshGateway.getRequests("update.run")).toHaveLength(0);
        await freshPage.locator(".update-run-view__report").scrollIntoViewIfNeeded();
        await freshPage.screenshot({ path: path.join(proofDir, "07-reopened-report.png") });
      },
    );
  });
});
