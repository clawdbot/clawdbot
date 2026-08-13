import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Tasks mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/tasks");
const baseTime = Date.parse("2026-07-05T18:00:00.000Z");

const runningTask = {
  id: "task-running",
  taskId: "task-running",
  kind: "subagent",
  runtime: "subagent",
  status: "running",
  title: "Review gateway changes",
  agentId: "main",
  childSessionKey: "agent:main:subagent:review",
  createdAt: baseTime - 5_000,
  updatedAt: baseTime,
  progressSummary: "Reading subscription paths",
};

const queuedTask = {
  id: "task-queued",
  taskId: "task-queued",
  kind: "cron",
  runtime: "cron",
  status: "queued",
  title: "Nightly cleanup",
  agentId: "main",
  sessionKey: "agent:main:cron:cleanup",
  createdAt: baseTime - 10_000,
  updatedAt: baseTime - 1_000,
};

const completedTask = {
  id: "task-completed",
  taskId: "task-completed",
  kind: "cli",
  runtime: "cli",
  status: "completed",
  title: "Generate media index",
  createdAt: baseTime - 30_000,
  updatedAt: baseTime - 20_000,
  terminalSummary: "Index generated",
};

const failedTask = {
  id: "task-failed",
  taskId: "task-failed",
  kind: "acp",
  runtime: "acp",
  status: "failed",
  title: "Run ACP worker",
  createdAt: baseTime - 40_000,
  updatedAt: baseTime - 30_000,
  error: "Worker exited",
};

const readOnlyRetainedTask = {
  id: "synthetic-retained-task",
  taskId: "synthetic-retained-task",
  kind: "subagent",
  runtime: "subagent",
  status: "completed",
  title: "Sanitized retained task",
  agentId: "main",
  createdAt: baseTime - 60_000,
  updatedAt: baseTime - 50_000,
  deliveryStatus: "dismissed",
  terminalOutcome: "blocked",
  terminalSummary: "Synthetic task completed; delivery was dismissed.",
};

const readOnlyRetainedResult = "Synthetic retained result copied by a read-only operator.";

const pageTwoSentinel = {
  id: "task-page-two-sentinel",
  taskId: "task-page-two-sentinel",
  kind: "subagent",
  runtime: "subagent",
  status: "running",
  title: "Page two running sentinel",
  agentId: "main",
  childSessionKey: "agent:main:subagent:page-two-sentinel",
  createdAt: baseTime + 4_000,
  updatedAt: baseTime + 5_000,
  progressSummary: "Visible only after active pagination",
};

const activePageOneTasks = [
  runningTask,
  queuedTask,
  ...Array.from({ length: 498 }, (_, index) => ({
    id: `task-page-one-${index}`,
    taskId: `task-page-one-${index}`,
    kind: "cron",
    runtime: "cron",
    status: "running",
    title: `Page one active task ${index + 1}`,
    agentId: "main",
    createdAt: baseTime - 20_000 - index,
    updatedAt: baseTime - 10_000 - index,
  })),
];

suite.define(() => {
  it("renders every active page, applies pushed completion, and cancels a page-two task", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    const rawVideoDir = path.join(artifactDir, "raw-video");
    await mkdir(rawVideoDir, { recursive: true });
    const context = await suite.browser.newContext({
      locale: "en-US",
      recordVideo: { dir: rawVideoDir, size: { width: 1440, height: 900 } },
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const video = page.video();
    try {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "tasks.list": {
            cases: [
              {
                match: {
                  agentId: "main",
                  cursor: "active-page-2",
                  limit: 500,
                  status: ["queued", "running"],
                },
                response: { tasks: [pageTwoSentinel] },
              },
              {
                match: {
                  agentId: "main",
                  limit: 500,
                  status: ["queued", "running"],
                },
                response: {
                  tasks: activePageOneTasks,
                  nextCursor: "active-page-2",
                },
              },
              {
                match: { agentId: "main", limit: 200 },
                response: { tasks: [completedTask, failedTask] },
              },
            ],
          },
          "tasks.cancel": {
            found: true,
            cancelled: true,
            task: { ...pageTwoSentinel, status: "cancelled", updatedAt: baseTime + 6_000 },
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}tasks`);
      expect(response?.status()).toBe(200);
      const active = page.locator('[data-task-section="active"]');
      const recent = page.locator('[data-task-section="recent"]');
      await active.locator('[data-task-id="task-page-two-sentinel"]').waitFor({
        state: "visible",
      });
      await active.locator('[data-task-id="task-running"]').waitFor({ state: "visible" });
      await active.locator('[data-task-id="task-queued"]').waitFor({ state: "visible" });
      await recent.locator('[data-task-id="task-completed"]').waitFor({ state: "visible" });
      await recent.locator('[data-task-id="task-failed"]').waitFor({ state: "visible" });
      expect(await active.textContent()).toContain("Reading subscription paths");
      expect(await active.textContent()).toContain("Visible only after active pagination");
      expect(await recent.textContent()).toContain("Worker exited");
      const listRequests = await gateway.getRequests("tasks.list");
      expect(
        listRequests.filter(
          (request) => (request.params as { status?: unknown }).status !== undefined,
        ),
      ).toHaveLength(2);
      expect(
        listRequests.filter(
          (request) => (request.params as { status?: unknown }).status === undefined,
        ),
      ).toHaveLength(1);
      expect(listRequests).toContainEqual({
        id: expect.any(String),
        method: "tasks.list",
        params: {
          agentId: "main",
          cursor: "active-page-2",
          limit: 500,
          status: ["queued", "running"],
        },
      });
      await page.screenshot({
        path: path.join(artifactDir, "01-page-two-sentinel.png"),
      });

      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: {
          ...runningTask,
          status: "completed",
          updatedAt: baseTime + 1_000,
          terminalSummary: "Review complete",
        },
      });
      await recent.locator('[data-task-id="task-running"]').waitFor({ state: "visible" });
      await active.locator('[data-task-id="task-running"]').waitFor({ state: "detached" });
      expect(await recent.textContent()).toContain("Review complete");
      await page.screenshot({
        path: path.join(artifactDir, "02-pushed-completion.png"),
      });

      await active
        .locator('[data-task-id="task-page-two-sentinel"]')
        .getByRole("button", { name: "Cancel Page two running sentinel" })
        .click();
      const cancelRequest = await gateway.waitForRequest("tasks.cancel");
      expect(cancelRequest.params).toEqual({ taskId: "task-page-two-sentinel" });
      expect(await gateway.getRequests("tasks.cancel")).toHaveLength(1);
      const cancelledSentinel = recent.locator('[data-task-id="task-page-two-sentinel"]');
      await cancelledSentinel.waitFor({
        state: "visible",
      });
      await active.locator('[data-task-id="task-page-two-sentinel"]').waitFor({
        state: "detached",
      });
      await cancelledSentinel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(artifactDir, "03-page-two-cancelled.png"),
      });
    } finally {
      await context.close();
      if (video) {
        await copyFile(await video.path(), path.join(artifactDir, "tasks-flow.webm"));
      }
      await rm(rawVideoDir, { force: true, recursive: true });
    }
  });

  it("lets an operator.read-only user copy a retained result without mutations", async () => {
    await mkdir(artifactDir, { recursive: true });
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(suite.server.baseUrl).origin,
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        methodResponses: {
          "tasks.list": {
            cases: [
              {
                match: { agentId: "main", limit: 500, status: ["queued", "running"] },
                response: { tasks: [] },
              },
              {
                match: { agentId: "main", limit: 200 },
                response: { tasks: [readOnlyRetainedTask] },
              },
            ],
          },
          "tasks.get": {
            task: { ...readOnlyRetainedTask, result: readOnlyRetainedResult },
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}tasks`);
      expect(response?.status()).toBe(200);
      const task = page.locator('[data-task-id="synthetic-retained-task"]');
      await task.waitFor({ state: "visible" });
      await task.scrollIntoViewIfNeeded();
      expect(await task.textContent()).toContain("Completed; result delivery was dismissed.");
      expect(await task.getByRole("button", { name: "Retry delivery" }).count()).toBe(0);
      expect(await task.getByRole("button", { name: "Dismiss delivery" }).count()).toBe(0);
      expect(await task.getByRole("button", { name: /Cancel/ }).count()).toBe(0);
      await page.screenshot({
        path: path.join(artifactDir, "04-read-only-retained-result.png"),
      });

      const copyButton = task.getByRole("button", { name: "Copy result" });
      await copyButton.waitFor({ state: "visible" });
      await copyButton.click();
      const getRequest = await gateway.waitForRequest("tasks.get");
      expect(getRequest.params).toEqual({ taskId: readOnlyRetainedTask.taskId });
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(readOnlyRetainedResult);
      expect(await gateway.getRequests("tasks.retry")).toHaveLength(0);
      expect(await gateway.getRequests("tasks.dismiss")).toHaveLength(0);
      expect(await gateway.getRequests("tasks.cancel")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
