import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateMenuItem,
  controlUiSessionPath,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sessions and cron primary QA",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-cron-primary",
);

async function captureUiProof(page: Page, fileName: string) {
  if (!captureProof) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

function cronJob(
  id: string,
  name: string,
  schedule: Record<string, unknown>,
  state: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: Date.parse("2026-08-03T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-08-03T08:05:00.000Z"),
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: `${name} fired` },
    state: { lastRunStatus: "ok", ...state },
  };
}

function cronListResponse(jobs: unknown[]) {
  return {
    jobs,
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

suite.define(() => {
  it("covers session listing, filtering, transcript history, and archive feedback", async () => {
    const timestamp = Date.parse("2026-08-03T09:00:00.000Z");
    const main = sessionRow("agent:main:main", "Main", timestamp);
    const research = sessionRow("agent:main:research", "Research notes", timestamp - 60_000);
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "sessions.search"],
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "The deployment history is ready to review." }],
          timestamp,
        },
      ],
      methodResponses: {
        "sessions.list": sessionsListResponse([main, research]),
        "sessions.patch": {},
        "sessions.search": {
          results: [
            {
              messageId: "message-research",
              role: "assistant",
              score: 2.5,
              sessionId: "research",
              sessionKey: research.key,
              snippet: "The deployment history is ready to review.",
              timestamp,
            },
          ],
        },
      },
      sessionKey: main.key,
    });

    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const mainRow = page
        .locator(".session-data-row")
        .filter({ has: page.locator(`.session-label-chip[title="${main.label}"]`) });
      const researchRow = page
        .locator(".session-data-row")
        .filter({ has: page.locator(`.session-label-chip[title="${research.label}"]`) });
      await mainRow.waitFor({ state: "visible", timeout: 10_000 });
      await researchRow.waitFor({ state: "visible", timeout: 10_000 });

      const rosterFilter = page.locator('.sessions-toolbar__search input[type="text"]');
      await rosterFilter.fill("Research");
      await expect.poll(() => mainRow.count()).toBe(0);
      await researchRow.waitFor({ state: "visible" });
      await captureUiProof(page, "01-session-filter.png");
      await rosterFilter.fill("");
      await mainRow.waitFor({ state: "visible" });

      const transcriptSearch = page.getByRole("search", { name: "Search transcripts" });
      const transcriptInput = transcriptSearch.getByRole("searchbox", {
        name: "Search thread transcripts",
      });
      await transcriptInput.fill("deployment history");
      await transcriptInput.press("Enter");
      const result = page.locator(".sessions-transcript-search__result");
      await result.waitFor({ state: "visible", timeout: 10_000 });
      expect((await gateway.getRequests("sessions.search"))[0]?.params).toEqual({
        agentId: "main",
        limit: 25,
        query: "deployment history",
        sessionKeys: [main.key, research.key],
      });
      await result.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(research.key));
      await page
        .locator(".chat-group.assistant")
        .getByText("The deployment history is ready to review.", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      await captureUiProof(page, "02-session-history.png");

      await page.goto(`${suite.server.baseUrl}sessions`);
      const actionRow = page
        .locator(".session-data-row")
        .filter({ has: page.locator(`.session-label-chip[title="${research.label}"]`) });
      await actionRow.waitFor({ state: "visible", timeout: 10_000 });
      await actionRow.getByRole("button", { name: "Open thread menu" }).click();
      await activateMenuItem(
        page.locator("openclaw-session-menu").getByRole("menuitem", {
          name: "Archive thread",
        }),
      );
      const patch = await waitForPatch(
        gateway,
        (params) => params.key === research.key && params.archived === true,
      );
      expect(requireRecord(patch.params)).toMatchObject({
        archived: true,
        key: research.key,
      });
      const toast = page
        .locator("openclaw-toast-host .app-toast")
        .filter({ hasText: "Thread archived" });
      await toast.waitFor({ state: "visible", timeout: 10_000 });
      await toast.getByRole("button", { name: "Undo" }).waitFor({ state: "visible" });
      await captureUiProof(page, "03-session-archive-feedback.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("covers cron listing, filtering, schedule creation, and run feedback", async () => {
    const intervalJob = cronJob("hourly-digest", "Hourly digest", {
      kind: "every",
      everyMs: 3_600_000,
    });
    const nightlyJob = cronJob("nightly-maintenance", "Nightly maintenance", {
      kind: "cron",
      expr: "0 1 * * *",
      tz: "UTC",
    });
    const createdJob = cronJob(
      "weekday-report",
      "Weekday report",
      { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
      { runningAtMs: Date.parse("2026-08-03T09:05:00.000Z") },
    );
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.add": { id: createdJob.id },
        "cron.list": {
          cases: [
            {
              match: { lastRunStatus: "error" },
              response: cronListResponse([]),
            },
            {
              match: { scheduleKind: "cron" },
              response: cronListResponse([nightlyJob]),
            },
            { response: cronListResponse([intervalJob, nightlyJob]) },
          ],
        },
        "cron.run": { ok: true, ran: false, reason: "already-running" },
        "cron.runs": {
          entries: [],
          total: 0,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        },
        "cron.status": {
          enabled: true,
          jobs: 2,
          nextWakeAtMs: Date.parse("2026-08-03T10:00:00.000Z"),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}cron`);
      const jobTitle = (name: string) =>
        page.locator(".cron-table__name-text", { hasText: new RegExp(`^${name}$`, "u") });
      await jobTitle(intervalJob.name).waitFor({ state: "visible", timeout: 10_000 });
      await jobTitle(nightlyJob.name).waitFor({ state: "visible", timeout: 10_000 });

      await page.locator(".cron-filter-popover__trigger").click();
      await page.locator('[data-test-id="cron-jobs-schedule-filter"]').selectOption("cron");
      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.list")).some(
            (request) => requireRecord(request.params).scheduleKind === "cron",
          ),
        )
        .toBe(true);
      await jobTitle(nightlyJob.name).waitFor({ state: "visible" });
      await expect.poll(() => jobTitle(intervalJob.name).count()).toBe(0);
      await captureUiProof(page, "04-cron-filter.png");

      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator("#cron-name").fill(createdJob.name);
      await page.locator("#cron-payload-text").fill("Prepare the weekday report");
      await page.locator('[data-test-id="cron-schedule-kind-cron"]').click();
      await page.locator("#cron-cron-expr").fill("0 9 * * 1-5");
      await page.locator("#cron-cron-tz").fill("UTC");
      await expect
        .poll(() => page.locator(".cron-schedule-summary").textContent())
        .toContain("0 9 * * 1-5");
      await gateway.setMethodResponse("cron.list", {
        cases: [
          {
            match: { lastRunStatus: "error" },
            response: cronListResponse([]),
          },
          { response: cronListResponse([nightlyJob, createdJob]) },
        ],
      });
      await page.locator('[data-test-id="cron-submit"]').click();

      const addRequest = await gateway.waitForRequest("cron.add");
      expect(requireRecord(addRequest.params)).toMatchObject({
        name: createdJob.name,
        payload: {
          kind: "agentTurn",
          message: "Prepare the weekday report",
        },
        schedule: {
          kind: "cron",
          expr: "0 9 * * 1-5",
          tz: "UTC",
        },
      });
      await jobTitle(createdJob.name).waitFor({ state: "visible", timeout: 10_000 });
      await captureUiProof(page, "05-cron-created.png");

      await jobTitle(createdJob.name).click();
      await page.locator('[data-test-id="cron-run-now"]').click();
      const runRequest = await gateway.waitForRequest("cron.run");
      expect(requireRecord(runRequest.params)).toEqual({
        id: createdJob.id,
        mode: "force",
      });
      await expect
        .poll(() => page.locator(".cron-error-banner").textContent())
        .toContain("This automation is already running.");
      await captureUiProof(page, "06-cron-run-feedback.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
