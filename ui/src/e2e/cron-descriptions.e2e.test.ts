import fs from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron saved descriptions E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

function cronJob(id: string, name: string) {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: `${name} fired` },
    state: {},
  };
}

const captureDurationProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const requireDurationRecord = createRequireRecord("record", "expected-object-value");

function durationResponses(jobs: unknown[]) {
  const list = (entries: unknown[]) => ({
    jobs: entries,
    snapshotRevision: "exact-duration-fixture",
    total: entries.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  });
  return {
    "cron.list": {
      cases: [{ match: { lastRunStatus: "error" }, response: list([]) }, { response: list(jobs) }],
    },
    "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

async function captureDurationProof(page: Page, name: string, observed: unknown) {
  if (!captureDurationProofEnabled) {
    return;
  }
  await page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`), fullPage: true });
  await fs.writeFile(
    path.join(suite.artifactDir, `${name}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
}

suite.define(() => {
  it("shows saved descriptions in list rows and task details for every payload kind", async () => {
    const jobs = [
      {
        ...cronJob("described-event", "System reminder"),
        description: "  Explain the system reminder without opening advanced settings  ",
        payload: { kind: "systemEvent", text: "Run the system reminder" },
      },
      {
        ...cronJob("described-agent", "Agent digest"),
        description: "Summarize the overnight activity",
        payload: { kind: "agentTurn", message: "List overnight deployment activity" },
      },
      {
        ...cronJob("described-command", "Command check"),
        description: "Run the infrastructure health check",
        payload: { kind: "command", argv: ["echo", "healthy"] },
      },
      {
        ...cronJob("described-script", "Script check"),
        description: "Inspect the scripted health check",
        payload: { kind: "script", script: "return 'healthy'" },
      },
      {
        ...cronJob("described-heartbeat", "Heartbeat check"),
        description: "Explain the system-owned heartbeat",
        payload: { kind: "heartbeat" },
      },
    ] as const;
    const undescribedJob = cronJob("without-description", "Plain task");
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              jobs: [...jobs, undescribedJob],
              snapshotRevision: "cron-descriptions-fixture",
              total: jobs.length + 1,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
            "cron.status": { enabled: true, jobs: jobs.length + 1, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${jobs[0].id}"]`).waitFor({ timeout: 10_000 });

        for (const job of jobs) {
          const description = page.locator(`[data-test-id="cron-row-description-${job.id}"]`);
          expect((await description.textContent())?.trim()).toBe(job.description.trim());
          expect(await description.getAttribute("title")).toBe(
            `Description: ${job.description.trim()}`,
          );
        }
        expect(
          await page.locator(`[data-test-id="cron-row-description-${undescribedJob.id}"]`).count(),
        ).toBe(0);

        for (const job of jobs) {
          const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
          await row.locator(".cron-table__name-text").click();
          const detailDescription = page.locator('[data-test-id="cron-detail-description"]');
          await detailDescription.waitFor({ state: "visible" });
          expect((await detailDescription.textContent())?.replace(/\s+/g, " ").trim()).toBe(
            `Description: ${job.description.trim()}`,
          );

          await page.locator('[data-test-id="cron-detail-tab-history"]').click();
          expect((await detailDescription.textContent())?.replace(/\s+/g, " ").trim()).toBe(
            `Description: ${job.description.trim()}`,
          );
          await page.locator('[data-test-id="cron-back"]').click();
          await row.waitFor({ timeout: 10_000 });
        }
      },
    );
  });

  it("configured duration precision: shows exact saved intervals in rows and details", async () => {
    const cases = [
      { id: "minute-control", name: "One-minute control", everyMs: 60_000, text: "Every 1m" },
      {
        id: "mixed-interval",
        name: "Ninety-second cadence",
        everyMs: 90_000,
        text: "Every 1m 30s",
      },
      {
        id: "precise-interval",
        name: "Full cadence",
        everyMs: 3_661_001,
        text: "Every 1h 1m 1s 1ms",
      },
    ] as const;
    const jobs = cases.map(({ id, name, everyMs }) => ({
      ...cronJob(id, name),
      enabled: false,
      configRevision: `${id}-definition`,
      schedule: { kind: "every", everyMs },
    }));
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
        ...(captureDurationProofEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1_280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: durationResponses(jobs),
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${cases[0].id}"]`).waitFor();
        const rows = await page
          .locator(".cron-table__schedule .cron-table__cell-value")
          .allTextContents();
        await captureDurationProof(page, "interval-list", { rows, jobs });
        const observed: Array<{
          id: string;
          row: string | undefined;
          detail: string | undefined;
        }> = [];
        for (const job of jobs) {
          const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
          expect(await row.getAttribute("class")).toContain("cron-table__row--paused");
          const rowText = (
            await row.locator(".cron-table__schedule .cron-table__cell-value").textContent()
          )?.trim();
          await row.locator(".cron-table__name-text").click();
          const subtitle = page.locator(".cron-detail-meta > .cron-detail-sub");
          await subtitle.waitFor();
          const detail = (await subtitle.textContent())?.trim();
          observed.push({ id: job.id, row: rowText, detail });
          await captureDurationProof(page, job.id, {
            everyMs: job.schedule.everyMs,
            row: rowText,
            detail,
          });
          await page.locator('[data-test-id="cron-back"]').click();
          await row.waitFor();
        }
        expect(observed).toEqual(cases.map(({ id, text }) => ({ id, row: text, detail: text })));
        expect(await gateway.getRequests("cron.run")).toHaveLength(0);
      },
    );
  });

  it("configured duration precision: preserves stagger milliseconds when changing the expression", async () => {
    const job = {
      ...cronJob("precise-stagger", "Paused stagger cadence"),
      enabled: false,
      configRevision: "precise-stagger-definition",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 1_001 },
    };
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
        ...(captureDurationProofEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1_280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: durationResponses([job]),
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`).click();
        await page.locator("details.cron-advanced > summary").click();
        const amount = page.locator("#cron-stagger-amount");
        const loadedStagger = await amount.inputValue();
        await captureDurationProof(page, "stagger-loaded", {
          loadedStagger,
          schedule: job.schedule,
        });
        await page.locator("#cron-cron-expr").fill("*/5 * * * *");
        const previousUpdates = (await gateway.getRequests("cron.update")).length;
        await gateway.deferNext("cron.update");
        await page.locator('[data-test-id="cron-submit"]').click();
        const request = await gateway.waitForRequest("cron.update", { after: previousUpdates });
        const patch = requireDurationRecord(requireDurationRecord(request.params).patch);
        await captureDurationProof(page, "stagger-submitted", { loadedStagger, request });
        // Echo the actual wire patch, so a lossy submission cannot become a correct fixture response.
        const updatedJob = { ...job, ...patch, configRevision: "precise-stagger-updated" };
        const previousLists = (await gateway.getRequests("cron.list")).length;
        await gateway.setMethodResponse("cron.list", durationResponses([updatedJob])["cron.list"]);
        await gateway.resolveDeferred("cron.update", updatedJob);
        await gateway.waitForRequest("cron.list", { after: previousLists });
        await expect
          .poll(() => page.locator('[data-test-id="cron-submit"]').isDisabled())
          .toBe(false);
        const reloadedStagger = await amount.inputValue();
        await captureDurationProof(page, "stagger-readback", {
          loadedStagger,
          request,
          reloadedStagger,
        });
        expect({ loadedStagger, request: request.params, reloadedStagger }).toMatchObject({
          loadedStagger: "1.001",
          request: {
            id: job.id,
            expectedConfigRevision: job.configRevision,
            patch: {
              enabled: false,
              schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC", staggerMs: 1_001 },
            },
          },
          reloadedStagger: "1.001",
        });
        expect(await gateway.getRequests("cron.run")).toHaveLength(0);
      },
    );
  });
});
