import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
// Control UI tests cover automation grouping and tagging behavior.
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation grouping E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function cronJob(
  id: string,
  name: string,
  group: string,
  tags: string[],
  payload: Record<string, unknown> = { kind: "systemEvent", text: `${name} fired` },
) {
  return {
    id,
    name,
    group,
    tags,
    effectiveGroup: group,
    configRevision: `config-revision-${id}`,
    enabled: true,
    createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload,
    state: {},
  };
}

function cronListResponse(jobs: unknown[]) {
  return {
    jobs,
    snapshotRevision: "cron-grouping-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

suite.define(() => {
  it("renders groups and tags, groups rows, filters through the Gateway, and edits metadata", async () => {
    const workJob = cronJob("work-job", "Weekly report", "Work", ["reports", "weekly"]);
    const githubJob = cronJob("github-job", "Issue digest", "GitHub", ["issues", "daily"]);
    const updatedGithubJob = { ...githubJob, group: "Engineering", tags: ["issues", "triage"] };
    const jobs = [workJob, githubJob];

    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              cases: [
                { match: { group: "GitHub" }, response: cronListResponse([githubJob]) },
                { match: {}, response: cronListResponse(jobs) },
              ],
            },
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
            "cron.update": updatedGithubJob,
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-row-work-job"]').waitFor();
        expect(
          await page
            .locator('[data-test-id="cron-row-work-job"] .cron-table__group-badge')
            .textContent(),
        ).toBe("Work");
        expect(
          await page
            .locator('[data-test-id="cron-row-work-job"] .cron-table__tag')
            .allTextContents(),
        ).toEqual(["reports", "weekly"]);

        await page.locator(".cron-filter-popover__trigger").click();
        await page.locator('[data-test-id="cron-jobs-group-by"]').selectOption("group");
        await expect
          .poll(async () =>
            (await page.locator('[data-test-id="cron-job-group"]').allTextContents()).map((text) =>
              text.replace(/\s+/gu, " ").trim(),
            ),
          )
          .toEqual(["Work1", "GitHub1"]);

        const listRequestsBeforeFilter = (await gateway.getRequests("cron.list")).length;
        await page.locator('[data-test-id="cron-jobs-group-filter"]').fill("GitHub");
        const filteredRequest = await gateway.waitForRequest("cron.list", {
          after: listRequestsBeforeFilter,
        });
        expect(requestParams(filteredRequest)).toMatchObject({ group: "GitHub" });
        await page.locator('[data-test-id="cron-row-github-job"]').waitFor();
        await expect(page.locator('[data-test-id="cron-row-work-job"]').count()).resolves.toBe(0);

        await page.locator('[data-test-id="cron-row-github-job"]').click();
        await page.locator("#cron-group").waitFor();
        expect(await page.locator("#cron-group").inputValue()).toBe("GitHub");
        expect(await page.locator("#cron-tags").inputValue()).toBe("issues, daily");

        const updateRequestsBeforeSave = (await gateway.getRequests("cron.update")).length;
        await page.locator("#cron-group").fill("Engineering");
        await page.locator("#cron-tags").fill("issues, triage");
        await page.locator('[data-test-id="cron-submit"]').click();
        const updateRequest = await gateway.waitForRequest("cron.update", {
          after: updateRequestsBeforeSave,
        });
        expect(requestParams(updateRequest)).toMatchObject({
          id: githubJob.id,
          patch: { group: "Engineering", tags: ["issues", "triage"] },
        });

        await page.screenshot({
          path: `${suite.artifactDir}/automation-grouping.png`,
          fullPage: true,
        });
        console.log(
          JSON.stringify({
            observed: [
              "Work row displayed its group and two tags",
              "group-by=group rendered Work and GitHub sections",
              "group=GitHub reached cron.list and hid the Work row",
              "edit form round-tripped GitHub and issues,daily",
              "cron.update received Engineering and issues,triage",
            ],
            screenshot: `${suite.artifactDir}/automation-grouping.png`,
          }),
        );
      },
    );
  });
});
