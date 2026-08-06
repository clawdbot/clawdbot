// Control UI tests cover cron filters behavior.
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function cronJob(id: string, name: string, schedule: Record<string, unknown>, state = {}) {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: `${name} fired` },
    state,
  };
}

function cronListResponse(jobs: unknown[], total = jobs.length) {
  return {
    jobs,
    total,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function cronRunsResponse(entries: unknown[], total = entries.length) {
  return {
    entries,
    total,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

async function waitForCronListRequest(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("cron.list");
    const match = requests.find((request) => predicate(requestParams(request)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`No matching cron.list request found: ${JSON.stringify(requests)}`);
}

type PageDiagnostics = {
  consoleMessages: string[];
  pageErrors: string[];
};

function jobTitle(page: Page, name: string) {
  return page.locator(".cron-table__name-text", { hasText: new RegExp(`^${name}$`, "u") });
}

async function dismissDropdownToNextTrigger(page: Page, trigger: Locator, nextTrigger: Locator) {
  await page.keyboard.press("Escape");
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
  expect(
    await trigger.evaluate((element) =>
      element
        .closest("wa-dropdown")
        ?.shadowRoot?.querySelector('[part="menu"]')
        ?.hasAttribute("inert"),
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect
    .poll(() => nextTrigger.evaluate((element) => element === document.activeElement))
    .toBe(true);
}

async function waitForJobTitle(
  page: Page,
  gateway: MockGatewayControls,
  diagnostics: PageDiagnostics,
  name: string,
) {
  try {
    await jobTitle(page, name).waitFor({ timeout: 10_000 });
  } catch (err) {
    const requests = await gateway.getRequests();
    const bodyText = await page.locator("body").textContent({ timeout: 1_000 }).catch(String);
    const content = await page.content().catch(String);
    throw new Error(
      [
        `Timed out waiting for cron job title: ${name}`,
        `URL: ${page.url()}`,
        `Gateway requests: ${JSON.stringify(requests)}`,
        `Page errors: ${JSON.stringify(diagnostics.pageErrors)}`,
        `Console: ${JSON.stringify(diagnostics.consoleMessages)}`,
        `Page text: ${bodyText}`,
        `Page content: ${content.slice(0, 1000)}`,
        `Original error: ${String(err)}`,
      ].join("\n"),
      { cause: err },
    );
  }
}

describeControlUiE2e("Control UI cron mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("suggests browser-supported timezones without restricting free-form input", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([]),
        "cron.runs": cronRunsResponse([]),
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}cron`);
      expect(response?.status()).toBe(200);
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator('[data-test-id="cron-schedule-kind-cron"]').click();

      const timezone = page.locator("#cron-cron-tz");
      await timezone.waitFor({ state: "visible" });
      expect(await timezone.getAttribute("list")).toBe("cron-tz-suggestions");
      const browserTimezone = await page.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      const timezoneOptions = await page
        .locator("#cron-tz-suggestions option")
        .evaluateAll((options) => options.map((option) => option.getAttribute("value")));
      expect(timezoneOptions).toContain(browserTimezone);
      expect(timezoneOptions).toContain("UTC");
      expect(timezoneOptions.length).toBeGreaterThan(100);

      await timezone.fill("Etc/GMT+3");
      expect(await timezone.inputValue()).toBe("Etc/GMT+3");
    } finally {
      await context.close();
    }
  });

  it("sends cron job table filters through the Gateway and renders the filtered page", async () => {
    const everyOk = cronJob(
      "digest-every-ok",
      "Digest every minute",
      { kind: "every", everyMs: 60_000 },
      { lastRunStatus: "ok", lastRunAtMs: Date.parse("2026-05-29T08:10:00.000Z") },
    );
    const cronUnknown = cronJob(
      "nightly-cron-unknown",
      "Nightly cron pending",
      { kind: "cron", expr: "0 1 * * *", tz: "UTC" },
      {},
    );

    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleMessages: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": {
          cases: [
            {
              match: { scheduleKind: "cron", lastRunStatus: "unknown" },
              response: cronListResponse([cronUnknown]),
            },
            {
              match: {},
              response: cronListResponse([everyOk, cronUnknown], 2),
            },
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
        "cron.status": {
          enabled: true,
          jobs: 2,
          nextWakeAtMs: Date.parse("2026-05-29T09:00:00.000Z"),
          storePath: "/tmp/openclaw-e2e/cron/jobs.json",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}cron`);
      expect(response?.status()).toBe(200);
      await waitForJobTitle(page, gateway, { consoleMessages, pageErrors }, "Digest every minute");
      await waitForJobTitle(page, gateway, { consoleMessages, pageErrors }, "Nightly cron pending");

      const initialRequest = await waitForCronListRequest(
        gateway,
        (params) => params.limit === 50 && params.scheduleKind === "all",
      );
      expect(requestParams(initialRequest)).toMatchObject({
        enabled: "all",
        includeDisabled: true,
        lastRunStatus: "all",
        limit: 50,
        offset: 0,
        scheduleKind: "all",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      });

      await page.locator(".cron-filter-popover__trigger").click();
      await page.locator('[data-test-id="cron-jobs-schedule-filter"]').selectOption("cron");
      await page.locator('[data-test-id="cron-jobs-last-status-filter"]').selectOption("unknown");

      const filteredRequest = await waitForCronListRequest(
        gateway,
        (params) => params.scheduleKind === "cron" && params.lastRunStatus === "unknown",
      );
      expect(requestParams(filteredRequest)).toMatchObject({
        enabled: "all",
        includeDisabled: true,
        lastRunStatus: "unknown",
        limit: 50,
        offset: 0,
        scheduleKind: "cron",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      });
      await waitForJobTitle(page, gateway, { consoleMessages, pageErrors }, "Nightly cron pending");
      await expect.poll(async () => jobTitle(page, "Digest every minute").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("creates a cron-scheduled task and renders the refreshed row", async () => {
    const schedule = { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" };
    const createdJob = {
      ...cronJob("weekday-report", "Weekday report", schedule),
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Prepare the weekday report" },
    };
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.add": { id: createdJob.id },
        "cron.list": cronListResponse([]),
        "cron.runs": cronRunsResponse([]),
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator("#cron-name").fill(createdJob.name);
      await page.locator("#cron-payload-text").fill(createdJob.payload.message);
      await page.locator('[data-test-id="cron-schedule-kind-cron"]').click();
      await page.locator("#cron-cron-expr").fill(schedule.expr);
      await page.locator("#cron-cron-tz").fill(schedule.tz);
      await gateway.setMethodResponse("cron.list", cronListResponse([createdJob]));
      await page.locator('[data-test-id="cron-submit"]').click();

      const addRequest = await gateway.waitForRequest("cron.add");
      expect(requestParams(addRequest)).toMatchObject({
        name: createdJob.name,
        payload: createdJob.payload,
        schedule,
      });
      await jobTitle(page, createdJob.name).waitFor({ state: "visible", timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  it("keeps read-only operators on Cron browse and history surfaces", async () => {
    const readOnlyJob = {
      ...cronJob(
        "read-only-job",
        "Read-only nightly digest",
        { kind: "cron", expr: "0 1 * * *", tz: "UTC" },
        { lastRunStatus: "ok", lastRunAtMs: Date.parse("2026-05-29T08:10:00.000Z") },
      ),
      description: "Explain the nightly digest without granting write access",
    };
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read"],
      methodResponses: {
        "cron.list": cronListResponse([readOnlyJob]),
        "cron.runs": cronRunsResponse([
          {
            ts: 1,
            jobId: readOnlyJob.id,
            jobName: readOnlyJob.name,
            status: "ok",
            summary: "Read-only history remains available",
          },
        ]),
        "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await jobTitle(page, readOnlyJob.name).waitFor({ timeout: 10_000 });
      await page.getByRole("note").filter({ hasText: "Browsing only" }).waitFor();
      expect(
        await page.locator(`[data-test-id="cron-row-description-${readOnlyJob.id}"]`).textContent(),
      ).toContain(readOnlyJob.description);

      await expect.poll(() => page.locator('[data-test-id="cron-new-task"]').count()).toBe(0);
      await expect
        .poll(() => page.locator(`[data-test-id="cron-row-run-${readOnlyJob.id}"]`).count())
        .toBe(0);
      await expect
        .poll(() => page.locator(`[data-test-id="cron-row-toggle-${readOnlyJob.id}"]`).count())
        .toBe(0);
      await expect.poll(() => page.locator("wa-dropdown.cron-job-menu").count()).toBe(0);
      await expect.poll(() => page.locator("[data-suggestion]").count()).toBe(0);
      expect(await page.locator(".cron-filter-popover__trigger").count()).toBe(1);

      await jobTitle(page, readOnlyJob.name).click();
      await page.locator("fieldset.cron-editor:disabled").waitFor();
      expect(
        await page.locator('[data-test-id="cron-detail-description"]').textContent(),
      ).toContain(readOnlyJob.description);
      await expect.poll(() => page.locator('[data-test-id="cron-run-now"]').count()).toBe(0);
      await expect.poll(() => page.locator('[data-test-id="cron-submit"]').count()).toBe(0);
      await expect.poll(() => page.locator(".cron-editor-actions").count()).toBe(0);

      await page.locator('[data-test-id="cron-detail-tab-history"]').click();
      await page.getByText("Read-only history remains available", { exact: true }).waitFor();
      expect(
        await page.locator('[data-test-id="cron-detail-description"]').textContent(),
      ).toContain(readOnlyJob.description);

      const mutationMethods = new Set(["cron.add", "cron.remove", "cron.run", "cron.update"]);
      expect(
        (await gateway.getRequests()).filter((request) => mutationMethods.has(request.method)),
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("announces selected history filters and sends their Gateway request values", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([]),
        "cron.runs": cronRunsResponse([
          {
            ts: 1,
            jobId: "filtered-job",
            status: "error",
            deliveryStatus: "delivered",
            summary: "Delivered failure",
          },
        ]),
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await page.getByRole("tab", { name: "Run history", exact: true }).click();

      const statusFilter = page.locator('[data-filter="status"]');
      const deliveryFilter = page.locator('[data-filter="delivery"]');
      const statusTrigger = statusFilter.locator(".cron-filter-dropdown__trigger");
      const deliveryTrigger = deliveryFilter.locator(".cron-filter-dropdown__trigger");
      await page.getByRole("button", { name: "Status All statuses", exact: true }).waitFor();
      await page.getByRole("button", { name: "Delivery All delivery", exact: true }).waitFor();

      const initialRequestCount = (await gateway.getRequests("cron.runs")).length;
      await statusTrigger.click();
      await statusFilter.locator('wa-dropdown-item[value="option:error"]').click();
      await page.getByRole("button", { name: "Status Error", exact: true }).waitFor();
      await statusFilter.locator('wa-dropdown-item[value="option:ok"]').click();
      await page.getByRole("button", { name: "Status OK, Error", exact: true }).waitFor();
      expect(await statusTrigger.textContent()).toContain("OK, Error");
      await statusFilter.locator('wa-dropdown-item[value="option:skipped"]').click();
      await page
        .getByRole("button", { name: "Status OK +2 (OK, Error, and Skipped)", exact: true })
        .waitFor();
      expect(await statusTrigger.textContent()).toContain("OK +2");
      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.runs")).slice(initialRequestCount).some((request) => {
            const params = requestParams(request);
            const statuses = params.statuses;
            return (
              Array.isArray(statuses) &&
              ["ok", "error", "skipped"].every((status) => statuses.includes(status))
            );
          }),
        )
        .toBe(true);

      const statusRequestCount = (await gateway.getRequests("cron.runs")).length;
      await deliveryTrigger.click();
      await deliveryFilter.locator('wa-dropdown-item[value="option:delivered"]').click();
      await page.getByRole("button", { name: "Delivery Delivered", exact: true }).waitFor();
      await deliveryFilter.locator('wa-dropdown-item[value="option:not-delivered"]').click();
      await page
        .getByRole("button", { name: "Delivery Delivered, Not delivered", exact: true })
        .waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Delivered, Not delivered");
      await deliveryFilter.locator('wa-dropdown-item[value="option:unknown"]').click();
      await page
        .getByRole("button", {
          name: "Delivery Delivered +2 (Delivered, Not delivered, and Unknown)",
          exact: true,
        })
        .waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Delivered +2");
      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.runs")).slice(statusRequestCount).some((request) => {
            const params = requestParams(request);
            const statuses = params.statuses;
            const deliveryStatuses = params.deliveryStatuses;
            return (
              Array.isArray(statuses) &&
              ["ok", "error", "skipped"].every((status) => statuses.includes(status)) &&
              Array.isArray(deliveryStatuses) &&
              ["delivered", "not-delivered", "unknown"].every((status) =>
                deliveryStatuses.includes(status),
              )
            );
          }),
        )
        .toBe(true);

      const deliveryRequestCount = (await gateway.getRequests("cron.runs")).length;
      await deliveryFilter.locator('wa-dropdown-item[value="command:clear"]').click();
      await page.getByRole("button", { name: "Delivery All delivery", exact: true }).waitFor();
      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.runs")).slice(deliveryRequestCount).some((request) => {
            const params = requestParams(request);
            const statuses = params.statuses;
            return (
              Array.isArray(statuses) &&
              ["ok", "error", "skipped"].every((status) => statuses.includes(status)) &&
              !("deliveryStatuses" in params)
            );
          }),
        )
        .toBe(true);

      const clearedDeliveryRequestCount = (await gateway.getRequests("cron.runs")).length;
      await statusTrigger.click();
      await statusFilter.locator('wa-dropdown-item[value="command:clear"]').click();
      await page.getByRole("button", { name: "Status All statuses", exact: true }).waitFor();
      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.runs"))
            .slice(clearedDeliveryRequestCount)
            .some((request) => {
              const params = requestParams(request);
              return !("statuses" in params) && !("deliveryStatuses" in params);
            }),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("localizes history filters and selects them using only native keyboard controls", async () => {
    const context = await browser.newContext({
      locale: "de-DE",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([]),
        "cron.runs": cronRunsResponse([]),
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("de");
      await page.getByRole("tab", { name: "Ausführungsverlauf", exact: true }).click();

      const statusFilter = page.locator('[data-filter="status"]');
      const deliveryFilter = page.locator('[data-filter="delivery"]');
      const statusTrigger = statusFilter.locator(".cron-filter-dropdown__trigger");
      const deliveryTrigger = deliveryFilter.locator(".cron-filter-dropdown__trigger");
      await page.getByRole("button", { name: "Status Alle Status", exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Zustellung Alle Zustellungen", exact: true })
        .waitFor();

      await statusTrigger.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => statusFilter.locator("wa-dropdown-item:focus").count()).toBe(1);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Status Fehler", exact: true }).waitFor();
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Status OK, Fehler", exact: true }).waitFor();
      expect(await statusTrigger.textContent()).toContain("OK, Fehler");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", { name: "Status OK +2 (OK, Fehler und Übersprungen)", exact: true })
        .waitFor();
      expect(await statusTrigger.textContent()).toContain("OK +2");

      await dismissDropdownToNextTrigger(page, statusTrigger, deliveryTrigger);
      await page.keyboard.press("Enter");
      await expect.poll(() => deliveryFilter.locator("wa-dropdown-item:focus").count()).toBe(1);
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", { name: "Zustellung Zugestellt, Nicht zugestellt", exact: true })
        .waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Zugestellt, Nicht zugestellt");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", {
          name: "Zustellung Zugestellt +2 (Zugestellt, Nicht zugestellt und Unbekannt)",
          exact: true,
        })
        .waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Zugestellt +2");

      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.runs")).some((request) => {
            const params = requestParams(request);
            const statuses = params.statuses;
            const deliveryStatuses = params.deliveryStatuses;
            return (
              Array.isArray(statuses) &&
              ["ok", "error", "skipped"].every((status) => statuses.includes(status)) &&
              Array.isArray(deliveryStatuses) &&
              ["delivered", "not-delivered", "unknown"].every((status) =>
                deliveryStatuses.includes(status),
              )
            );
          }),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("keeps the newest visible overview when an older history search resolves last", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([]),
        "cron.runs": cronRunsResponse([
          { ts: 1, jobId: "initial-job", status: "ok", summary: "Initial history" },
        ]),
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await page.getByRole("tab", { name: "Run history", exact: true }).click();
      await expect
        .poll(() => page.locator(".cron-run-entry", { hasText: "Initial history" }).count())
        .toBe(1);

      await gateway.deferNext("cron.runs");
      const search = page.locator(".cron-run-filter-search input");
      await search.fill("stale");
      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.runs")).some(
            (request) => requestParams(request).query === "stale",
          ),
        )
        .toBe(true);

      await gateway.setMethodResponse(
        "cron.runs",
        cronRunsResponse([
          { ts: 3, jobId: "fresh-job", status: "ok", summary: "Newest matching history" },
        ]),
      );
      await search.fill("fresh");
      await expect
        .poll(() => page.locator(".cron-run-entry", { hasText: "Newest matching history" }).count())
        .toBe(1);

      await gateway.resolveDeferred(
        "cron.runs",
        cronRunsResponse([
          { ts: 2, jobId: "stale-job", status: "ok", summary: "Stale matching history" },
        ]),
      );

      await expect
        .poll(() => page.locator(".cron-run-entry", { hasText: "Newest matching history" }).count())
        .toBe(1);
      await expect
        .poll(() => page.locator(".cron-run-entry", { hasText: "Stale matching history" }).count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps selected task history when a deferred overview refresh resolves last", async () => {
    const selectedJob = cronJob("selected-history-job", "Selected history task", {
      kind: "every",
      everyMs: 60_000,
    });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([selectedJob]),
        "cron.runs": {
          cases: [
            {
              match: { scope: "job", id: selectedJob.id },
              response: cronRunsResponse([
                {
                  ts: 2,
                  jobId: selectedJob.id,
                  status: "ok",
                  summary: "Selected task history",
                },
              ]),
            },
            {
              match: { scope: "all" },
              response: cronRunsResponse([
                { ts: 1, jobId: "overview-job", status: "ok", summary: "Overview history" },
              ]),
            },
          ],
        },
        "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await jobTitle(page, selectedJob.name).waitFor({ timeout: 10_000 });

      const previousHistoryRequestCount = (await gateway.getRequests("cron.runs")).length;
      await gateway.deferNext("cron.runs");
      await gateway.emitGatewayEvent("cron", {});
      await expect
        .poll(async () => (await gateway.getRequests("cron.runs")).length)
        .toBeGreaterThan(previousHistoryRequestCount);

      await jobTitle(page, selectedJob.name).click();
      await page.locator('[data-test-id="cron-detail-tab-history"]').click();
      await expect
        .poll(() => page.locator(".cron-run-entry", { hasText: "Selected task history" }).count())
        .toBe(1);

      await gateway.resolveDeferred(
        "cron.runs",
        cronRunsResponse([
          { ts: 3, jobId: "overview-job", status: "ok", summary: "Late overview history" },
        ]),
      );

      await expect
        .poll(() => page.locator(".cron-run-entry", { hasText: "Selected task history" }).count())
        .toBe(1);
      await expect
        .poll(() => page.locator(".cron-run-entry", { hasText: "Late overview history" }).count())
        .toBe(0);

      const statusTrigger = page.locator('[data-filter="status"] .cron-filter-dropdown__trigger');
      const deliveryTrigger = page.locator(
        '[data-filter="delivery"] .cron-filter-dropdown__trigger',
      );
      await statusTrigger.focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.locator('[data-filter="status"] wa-dropdown-item:focus').count())
        .toBe(1);
      await dismissDropdownToNextTrigger(page, statusTrigger, deliveryTrigger);
    } finally {
      await context.close();
    }
  });

  it("saves and displays agent-turn model overrides", async () => {
    const configuredModel = "openai/gpt-5.2";
    const existingJob = {
      ...cronJob("model-job", "Model-specific job", { kind: "every", everyMs: 60_000 }),
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Use the configured model", model: configuredModel },
    };
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.add": { id: "quick-created-model-job" },
        "cron.list": cronListResponse([existingJob]),
        "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
        "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await jobTitle(page, existingJob.name).waitFor({ timeout: 10_000 });

      // Selecting the task opens the detail view with its stored model override.
      await jobTitle(page, existingJob.name).click();
      await expect
        .poll(async () => page.locator("#cron-payload-model").inputValue())
        .toBe(configuredModel);

      // The create button lives on the list view; navigate back first.
      await page.locator('[data-test-id="cron-back"]').click();
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator("#cron-payload-text").fill("Run with a selected model");
      await page.locator("#cron-name").fill("Model override task");

      const modelInput = page.locator("#cron-payload-model");
      await modelInput.fill("openai/gpt-5.5");
      expect(await modelInput.getAttribute("list")).toBe("cron-model-suggestions");
      expect(
        await page
          .locator("#cron-model-suggestions option")
          .evaluateAll((options) => options.map((option) => option.getAttribute("value"))),
      ).toContain(configuredModel);

      await page.locator('[data-test-id="cron-submit"]').click();
      const addRequest = await gateway.waitForRequest("cron.add");
      expect(requestParams(addRequest)).toMatchObject({
        name: "Model override task",
        payload: {
          kind: "agentTurn",
          message: "Run with a selected model",
          model: "openai/gpt-5.5",
        },
      });
      expect(requireRecord(requestParams(addRequest).delivery).accountId).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it("creates and edits agent-turn jobs with an explicit zero timeout", async () => {
    const existingJob = {
      ...cronJob("existing-no-timeout", "Existing no-timeout task", {
        kind: "every",
        everyMs: 60_000,
      }),
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Continue until the existing task finishes",
        timeoutSeconds: 0,
      },
    };
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.add": { id: "created-no-timeout" },
        "cron.update": { id: existingJob.id },
        "cron.list": cronListResponse([existingJob]),
        "cron.runs": cronRunsResponse([]),
        "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await jobTitle(page, existingJob.name).waitFor({ timeout: 10_000 });

      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator("#cron-name").fill("Created no-timeout task");
      await page.locator("#cron-payload-text").fill("Continue until the new task finishes");
      await page.locator("details.cron-advanced > summary").click();
      await page.locator("#cron-timeout-seconds").fill("0");
      await page.locator('[data-test-id="cron-submit"]').click();

      const addRequest = await gateway.waitForRequest("cron.add");
      expect(requestParams(addRequest)).toMatchObject({
        name: "Created no-timeout task",
        payload: {
          kind: "agentTurn",
          message: "Continue until the new task finishes",
          timeoutSeconds: 0,
        },
      });

      await jobTitle(page, existingJob.name).waitFor({ timeout: 10_000 });
      await jobTitle(page, existingJob.name).click();
      await page.locator("details.cron-advanced > summary").click();
      expect(await page.locator("#cron-timeout-seconds").inputValue()).toBe("0");
      await page.locator("#cron-payload-text").fill("Continue until the edited task finishes");
      await page.locator('[data-test-id="cron-submit"]').click();

      const updateRequest = await gateway.waitForRequest("cron.update");
      expect(requestParams(updateRequest)).toMatchObject({
        id: existingJob.id,
        patch: {
          payload: {
            kind: "agentTurn",
            message: "Continue until the edited task finishes",
            timeoutSeconds: 0,
          },
        },
      });
    } finally {
      await context.close();
    }
  });

  it("defaults recurring jobs converted to one-time cleanup", async () => {
    const existingJob = {
      ...cronJob("recurring-to-once", "Recurring retention", { kind: "every", everyMs: 60_000 }),
      deleteAfterRun: false,
    };
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([existingJob]),
        "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
        "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
        "cron.update": { id: existingJob.id },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await jobTitle(page, existingJob.name).waitFor({ timeout: 10_000 });
      await jobTitle(page, existingJob.name).click();
      await page.locator("details.cron-advanced > summary").click();
      expect(
        await page
          .locator("wa-switch.settings-toggle")
          .filter({ hasText: "Delete after run" })
          .count(),
      ).toBe(0);

      await page.locator('[data-test-id="cron-schedule-kind-at"]').click();
      await page.locator("#cron-schedule-at").fill("2026-07-19T09:00");
      const expectedAt = await page.evaluate(() => new Date("2026-07-19T09:00").toISOString());
      const deleteToggle = page.locator("wa-switch.settings-toggle").filter({
        hasText: "Delete after run",
      });
      await expect
        .poll(() => deleteToggle.evaluate((element) => Reflect.get(element, "checked")))
        .toBe(true);

      await page.locator('[data-test-id="cron-submit"]').click();
      const request = await gateway.waitForRequest("cron.update");
      const params = requestParams(request);
      expect(params.id).toBe(existingJob.id);
      expect(requireRecord(params.patch)).toMatchObject({
        deleteAfterRun: true,
        schedule: { kind: "at", at: expectedAt },
      });
    } finally {
      await context.close();
    }
  });

  it("shows why a requested run was not started", async () => {
    const existingJob = cronJob(
      "already-running-job",
      "Long-running automation",
      { kind: "every", everyMs: 60_000 },
      { runningAtMs: Date.parse("2026-05-29T08:10:00.000Z") },
    );
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([existingJob]),
        "cron.run": { ok: true, ran: false, reason: "already-running" },
        "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
        "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await jobTitle(page, existingJob.name).waitFor({ timeout: 10_000 });
      await jobTitle(page, existingJob.name).click();
      await expect
        .poll(async () => (await gateway.getRequests("cron.runs")).length)
        .toBeGreaterThan(0);
      const historyRequestsBeforeRun = (await gateway.getRequests("cron.runs")).length;

      await page.locator('[data-test-id="cron-run-now"]').click();
      await gateway.waitForRequest("cron.run");

      await expect
        .poll(() => page.locator(".cron-error-banner").textContent())
        .toContain("This automation is already running.");
      expect(await gateway.getRequests("cron.runs")).toHaveLength(historyRequestsBeforeRun);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("supports skip navigation and keyboard tab activation", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse([]),
        "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      },
    });

    try {
      await page.goto(`${server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-list-tab-tasks"]').waitFor();

      await page.keyboard.press("Tab");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()))
        .toBe("Skip to main content");
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("control-ui-main");

      const tasksTab = page.getByRole("tab", { name: "Automations", exact: true });
      const activityTab = page.getByRole("tab", { name: "Run history", exact: true });
      await tasksTab.focus();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => activityTab.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => activityTab.getAttribute("aria-selected")).toBe("true");
      await expect
        .poll(() => page.getByRole("tabpanel", { name: "Run history" }).isVisible())
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
