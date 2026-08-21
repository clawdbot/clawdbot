// Real-Chromium coverage keeps automation condition authoring aligned with Gateway contracts.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation condition-trigger authoring",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const proofDirectory = process.env.OPENCLAW_TRIGGER_UI_PROOF_DIR;
const proofStage = process.env.OPENCLAW_TRIGGER_UI_PROOF_STAGE ?? "after";
type CronTriggerTestApp = HTMLElement & { runtime?: { context: ApplicationContext } };

const scriptJob = {
  id: "existing-script-automation",
  configRevision: "existing-script-revision",
  name: "Script health check",
  enabled: true,
  createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "script", script: "return { ready: true };" },
  state: {},
};

function listResponse(jobs: unknown[]) {
  return {
    jobs,
    snapshotRevision: "trigger-authoring-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

async function captureProof(page: Page, name: string) {
  if (!proofDirectory) {
    return;
  }
  await mkdir(proofDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(proofDirectory, `${proofStage}-${name}.png`),
  });
}

async function captureTriggerCapabilityProof(page: Page, name: string) {
  await page
    .locator(".settings-row__title")
    .filter({ hasText: "Condition trigger" })
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureProof(page, name);
}

async function selectSeconds(page: Page) {
  const unit = page.locator("wa-select").filter({
    has: page.locator('[slot="label"]', { hasText: "Unit" }),
  });
  await unit.click();
  await page.getByRole("option", { name: "Seconds", exact: true }).click();
}

suite.define(() => {
  it("prevents unsupported condition triggers while preserving valid interval submissions", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_050, width: 1_440 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.add": { id: "new-automation" },
            "cron.list": {
              cases: [
                { match: { lastRunStatus: "error" }, response: listResponse([]) },
                { response: listResponse([scriptJob]) },
              ],
            },
            "cron.runs": {
              entries: [],
              total: 0,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 1, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-row-existing-script-automation"]').click();
        await page.locator("details.cron-advanced > summary").click();

        const scriptTriggerControlCount = await page
          .locator("wa-switch.settings-toggle")
          .filter({ hasText: "Condition trigger" })
          .count();
        await page
          .getByText("Condition trigger", { exact: true })
          .evaluate((element) => element.scrollIntoView({ block: "center" }));
        await captureProof(page, "01-script-payload-condition-control");

        await page.locator('[data-test-id="cron-back"]').click();
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Conditional interval");
        await page.locator("#cron-payload-text").fill("Run when the condition matches");
        await selectSeconds(page);
        await page.locator("#cron-every-amount").fill("5");
        await page.locator("details.cron-advanced > summary").click();
        await page
          .locator(".settings-row--toggle")
          .filter({ hasText: "Condition trigger" })
          .click();
        await page.locator("#cron-trigger-script").fill("json({ fire: true })");
        await page
          .locator("#cron-every-amount")
          .evaluate((element) => element.scrollIntoView({ block: "center" }));
        await captureProof(page, "02-triggered-five-second-validation");

        expect(scriptTriggerControlCount).toBe(0);

        const intervalError = page.locator("#cron-error-everyAmount");
        await intervalError.waitFor({ state: "visible" });
        expect(await intervalError.textContent()).toMatch(/30/);
        expect(await page.locator("#cron-every-amount").getAttribute("aria-invalid")).toBe("true");
        expect(await page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(true);
        expect(await gateway.getRequests("cron.add")).toHaveLength(0);

        await page.locator("#cron-every-amount").fill("30");
        await expect.poll(async () => intervalError.count()).toBe(0);
        expect(await page.locator('[data-test-id="cron-submit"]').isEnabled()).toBe(true);
        await captureProof(page, "03-triggered-thirty-second-boundary");
        await page.locator('[data-test-id="cron-submit"]').click();

        const triggeredRequest = await gateway.waitForRequest("cron.add");
        expect(triggeredRequest.params).toMatchObject({
          name: "Conditional interval",
          schedule: { kind: "every", everyMs: 30_000 },
          trigger: { script: "json({ fire: true })", once: false },
        });
        await expect.poll(async () => page.locator('[data-test-id="cron-submit"]').count()).toBe(0);

        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Unconditional interval");
        await page.locator("#cron-payload-text").fill("Run every five seconds");
        await selectSeconds(page);
        await page.locator("#cron-every-amount").fill("5");

        expect(await page.locator("#cron-error-everyAmount").count()).toBe(0);
        expect(await page.locator('[data-test-id="cron-submit"]').isEnabled()).toBe(true);
        await captureProof(page, "04-untriggered-five-second-interval");

        const previousAdds = (await gateway.getRequests("cron.add")).length;
        await page.locator('[data-test-id="cron-submit"]').click();
        const untriggeredRequest = await gateway.waitForRequest("cron.add", {
          after: previousAdds,
        });
        expect(untriggeredRequest.params).toMatchObject({
          name: "Unconditional interval",
          schedule: { kind: "every", everyMs: 5_000 },
        });
        expect(untriggeredRequest.params).not.toHaveProperty("trigger");
      },
    );
  });

  it("keeps saved and unsaved trigger drafts separate from reconnect-refreshed scheduler capability", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_050, width: 1_440 } },
      async ({ page }) => {
        const initialConfig = { cron: { triggers: { enabled: true } } };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "trigger-config-1",
              config: initialConfig,
              configRevisionHash: "trigger-config-1",
              hash: "trigger-config-1",
              issues: [],
              raw: JSON.stringify(initialConfig),
              valid: true,
            },
            "cron.list": listResponse([]),
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("details.cron-advanced > summary").click();
        const triggerToggle = page
          .locator(".settings-row--toggle")
          .filter({ hasText: "Condition trigger" });
        await expect.poll(() => triggerToggle.count()).toBe(1);

        const unsaved = await page.evaluate(async () => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          if (!config) {
            throw new Error("Runtime config capability is unavailable");
          }
          await config.ensureLoaded();
          config.setWritesSuspended(true);
          config.patchForm(["cron", "triggers", "enabled"], false);
          return { dirty: config.state.configFormDirty, needsApply: config.state.configNeedsApply };
        });
        expect(unsaved).toEqual({ dirty: true, needsApply: false });
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        await expect.poll(() => triggerToggle.count()).toBe(1);
        await captureTriggerCapabilityProof(page, "05-unsaved-disable-keeps-active-trigger");

        const saveResult = await page.evaluate(async () => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          if (!config) {
            throw new Error("Runtime config capability is unavailable");
          }
          config.setWritesSuspended(false);
          const saved = await config.save();
          return {
            dirty: config.state.configFormDirty,
            needsApply: config.state.configNeedsApply,
            saved,
          };
        });
        expect(saveResult).toEqual({ dirty: false, needsApply: true, saved: true });
        const savedRequest = await gateway.waitForRequest("config.set");
        expect(JSON.parse(String((savedRequest.params as { raw?: string }).raw))).toEqual({
          cron: { triggers: { enabled: false } },
        });
        expect(await gateway.getRequests("config.apply")).toHaveLength(0);
        await expect.poll(() => triggerToggle.count()).toBe(1);
        await captureTriggerCapabilityProof(page, "06-saved-unapplied-keeps-active-trigger");

        const previousStatuses = (await gateway.getRequests("cron.status")).length;
        await gateway.setMethodResponse("cron.status", {
          enabled: true,
          triggersEnabled: false,
          jobs: 0,
          nextWakeAtMs: null,
        });
        await gateway.closeLatest(1012, "refresh effective trigger capability");
        await expect
          .poll(async () => (await gateway.getRequests("cron.status")).length)
          .toBeGreaterThan(previousStatuses);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("details.cron-advanced > summary").click();
        await expect.poll(() => triggerToggle.count()).toBe(0);
        await page.getByText("Condition triggers are disabled by cron.triggers.enabled.").waitFor();
        await captureTriggerCapabilityProof(page, "07-reconnect-refreshes-disabled-trigger");

        const oppositeDraft = await page.evaluate(async () => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          if (!config) {
            throw new Error("Runtime config capability is unavailable");
          }
          await config.ensureLoaded();
          config.setWritesSuspended(true);
          config.patchForm(["cron", "triggers", "enabled"], true);
          return config.state.configFormDirty;
        });
        expect(oppositeDraft).toBe(true);
        await expect.poll(() => triggerToggle.count()).toBe(0);
        await captureTriggerCapabilityProof(
          page,
          "08-unsaved-enable-cannot-author-disabled-trigger",
        );
        await page.evaluate(async () => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          await config?.discardDraft();
          config?.setWritesSuspended(false);
        });
      },
    );
  });
});
