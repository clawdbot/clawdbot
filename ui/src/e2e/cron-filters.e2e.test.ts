// Control UI tests cover cron filters behavior.
import { chromium, type Browser, type Page } from "playwright";
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
      setTimeout(resolve, 50);
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

      await page.locator("details.cron-filter-popover > summary").click();
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
      await expect.poll(() => activityTab.getAttribute("aria-selected")).toBe("true");
      await expect
        .poll(() => page.getByRole("tabpanel", { name: "Run history" }).isVisible())
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
