import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Tasks mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

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
const olderRetainedResult = "Older retained result from the first copy activation.";
const newestRetainedResult = "Newest retained result from the second copy activation.";

type ClipboardFaultState = {
  asyncWrites: string[];
  execSucceeds: boolean;
  legacyWrites: string[];
  mode: "defer" | "missing" | "reject";
  pending: Array<{
    reject: (reason?: unknown) => void;
    resolve: () => void;
  }>;
};

const retryBlockedTask = {
  ...readOnlyRetainedTask,
  id: "task-retry-blocked",
  taskId: "task-retry-blocked",
  title: "Automation report delivery",
  deliveryStatus: "failed",
  terminalSummary: "Automation completed; result delivery is blocked.",
};

const dismissBlockedTask = {
  ...retryBlockedTask,
  id: "task-dismiss-blocked",
  taskId: "task-dismiss-blocked",
  title: "Automation cleanup delivery",
  updatedAt: baseTime - 51_000,
};

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
  it("keeps completed tasks visible when active work fills the unfiltered page", async () => {
    const artifactDir = createControlUiE2eArtifactDir("tasks-recent");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const activeTasks = activePageOneTasks.slice(0, 200);
      const terminalStatuses = ["completed", "failed", "timed_out", "cancelled"];
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "tasks.list": {
            cases: [
              {
                match: { agentId: "main", limit: 500, status: ["queued", "running"] },
                response: { tasks: activeTasks },
              },
              {
                match: { agentId: "main", limit: 200, status: terminalStatuses },
                response: { tasks: [completedTask, failedTask] },
              },
              {
                match: { agentId: "main", limit: 200 },
                response: { tasks: activeTasks },
              },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}tasks`);
      const active = page.locator('[data-task-section="active"]');
      const recent = page.locator('[data-task-section="recent"]');
      await active.locator('[data-task-id="task-running"]').waitFor({ state: "visible" });
      await recent.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifactDir, "10-recent-terminal-starvation.png") });

      expect(await recent.textContent()).toContain("Generate media index");
      expect(await recent.textContent()).toContain("Worker exited");
      expect(await gateway.getRequests("tasks.list")).toContainEqual({
        id: expect.any(String),
        method: "tasks.list",
        params: { agentId: "main", limit: 200, sortBy: "endedAt", status: terminalStatuses },
      });
    } finally {
      await context.close();
    }
  });

  it("keeps retry and dismiss outcomes authoritative across a stale refresh and reconnect", async () => {
    const actionArtifactDir = createControlUiE2eArtifactDir("task-action-outcomes");
    const rawVideoDir = path.join(actionArtifactDir, "raw-video");
    await mkdir(rawVideoDir, { recursive: true });
    const context = await suite.browser.newContext({
      locale: "en-US",
      recordVideo: { dir: rawVideoDir, size: { width: 1440, height: 900 } },
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const video = page.video();
    const listResponses = {
      cases: [
        {
          match: { agentId: "main", limit: 500, status: ["queued", "running"] },
          response: { tasks: [] },
        },
        {
          match: { agentId: "main", limit: 200 },
          response: { tasks: [retryBlockedTask, dismissBlockedTask] },
        },
      ],
    };
    const retriedTask = {
      ...retryBlockedTask,
      deliveryStatus: "session_queued",
      terminalOutcome: "succeeded",
      updatedAt: baseTime + 1_000,
    };
    const dismissedTask = {
      ...dismissBlockedTask,
      deliveryStatus: "dismissed",
      updatedAt: baseTime + 2_000,
    };
    try {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "tasks.list": listResponses,
          "tasks.retry": {
            results: [{ taskId: retryBlockedTask.taskId, ok: true, task: retriedTask }],
          },
          "tasks.dismiss": {
            results: [{ taskId: dismissBlockedTask.taskId, ok: true, task: dismissedTask }],
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}tasks`);
      expect(response?.status()).toBe(200);
      const retryRow = page.locator(`[data-task-id="${retryBlockedTask.id}"]`);
      const dismissRow = page.locator(`[data-task-id="${dismissBlockedTask.id}"]`);
      await retryRow.waitFor({ state: "visible" });
      await dismissRow.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(actionArtifactDir, "01-blocked.png") });

      await page.setViewportSize({ width: 320, height: 844 });
      // Resize schedules a shell render; visible buttons can still belong to its desktop grid.
      await page.locator(".shell.shell--mobile-nav").waitFor();
      const recoveryActions = ["Copy result", "Retry delivery", "Dismiss delivery"];
      for (const name of recoveryActions) {
        const action = retryRow.getByRole("button", { name });
        await action.waitFor({ state: "visible" });
        const bounds = await action.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((bounds?.x ?? 321) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
      }
      await page.screenshot({ path: path.join(actionArtifactDir, "01-blocked-mobile.png") });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator(".shell:not(.shell--mobile-nav)").waitFor();

      await gateway.deferNext("tasks.retry", { taskIds: [retryBlockedTask.taskId] });
      const retryButton = retryRow.getByRole("button", { name: "Retry delivery" });
      await retryButton.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await expect.poll(async () => gateway.getRequests("tasks.retry")).toHaveLength(1);
      await expect.poll(() => retryButton.isDisabled()).toBe(true);
      await gateway.rejectDeferred("tasks.retry", { message: "Synthetic delivery retry failed" });
      await expect
        .poll(() => page.locator(".callout.danger").textContent())
        .toContain("Synthetic delivery retry failed");
      await expect.poll(() => retryButton.isEnabled()).toBe(true);
      await page.screenshot({ path: path.join(actionArtifactDir, "02-retry-failed.png") });

      await gateway.deferNext("tasks.list", {
        agentId: "main",
        limit: 500,
        status: ["queued", "running"],
      });
      await gateway.deferNext("tasks.list", { agentId: "main", limit: 200 });
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect.poll(async () => gateway.getRequests("tasks.list")).toHaveLength(4);

      await gateway.deferNext("tasks.retry", { taskIds: [retryBlockedTask.taskId] });
      await gateway.deferNext("tasks.dismiss", { taskIds: [dismissBlockedTask.taskId] });
      await retryButton.click();
      await dismissRow.getByRole("button", { name: "Dismiss delivery" }).click();
      await expect.poll(async () => gateway.getRequests("tasks.retry")).toHaveLength(2);
      await expect.poll(async () => gateway.getRequests("tasks.dismiss")).toHaveLength(1);
      await gateway.resolveDeferred("tasks.dismiss", {
        results: [{ taskId: dismissBlockedTask.taskId, ok: true, task: dismissedTask }],
      });
      await gateway.resolveDeferred("tasks.retry", {
        results: [{ taskId: retryBlockedTask.taskId, ok: true, task: retriedTask }],
      });
      await expect
        .poll(() => retryRow.getByRole("button", { name: "Retry delivery" }).count())
        .toBe(0);
      await expect
        .poll(() => dismissRow.getByRole("button", { name: "Dismiss delivery" }).count())
        .toBe(0);
      await page.screenshot({ path: path.join(actionArtifactDir, "03-actions-succeeded.png") });

      await gateway.emitGatewayEvent("task", {
        action: "deleted",
        taskId: dismissBlockedTask.taskId,
      });
      await dismissRow.waitFor({ state: "detached" });
      await gateway.resolveDeferred("tasks.list", { tasks: [] });
      await gateway.resolveDeferred("tasks.list", {
        tasks: [retryBlockedTask, dismissBlockedTask],
      });

      await expect
        .poll(() => retryRow.getByRole("button", { name: "Retry delivery" }).count())
        .toBe(0);
      await expect.poll(() => retryRow.locator(".callout.warn").count()).toBe(0);
      await dismissRow.waitFor({ state: "detached" });
      expect(await gateway.getRequests("tasks.retry")).toHaveLength(2);
      expect((await gateway.getRequests("tasks.retry")).map((request) => request.params)).toEqual([
        { taskIds: [retryBlockedTask.taskId] },
        { taskIds: [retryBlockedTask.taskId] },
      ]);
      expect((await gateway.getRequests("tasks.dismiss"))[0]?.params).toEqual({
        taskIds: [dismissBlockedTask.taskId],
      });
      await page.screenshot({
        path: path.join(actionArtifactDir, "04-stale-refresh-suppressed.png"),
      });

      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1012, "Replace the task action client");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await retryRow.waitFor({ state: "visible" });
      await expect
        .poll(() => retryRow.getByRole("button", { name: "Retry delivery" }).count())
        .toBe(1);
      await retryRow.getByRole("button", { name: "Retry delivery" }).click();
      await expect.poll(async () => gateway.getRequests("tasks.retry")).toHaveLength(3);
      await expect
        .poll(() => retryRow.getByRole("button", { name: "Retry delivery" }).count())
        .toBe(0);
      await page.screenshot({ path: path.join(actionArtifactDir, "05-reconnect-retry.png") });
    } finally {
      await context.close();
      if (video) {
        await copyFile(
          await video.path(),
          path.join(actionArtifactDir, "task-action-outcomes.webm"),
        );
      }
      await rm(rawVideoDir, { force: true, recursive: true });
    }
  });

  it("renders every active page, applies pushed completion, and cancels a page-two task", async () => {
    const artifactDir = createControlUiE2eArtifactDir("tasks-flow");
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
                match: {
                  agentId: "main",
                  limit: 200,
                  status: ["completed", "failed", "timed_out", "cancelled"],
                  sortBy: "endedAt",
                },
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
      ).toHaveLength(3);
      expect(
        listRequests.filter(
          (request) => (request.params as { status?: unknown }).status === undefined,
        ),
      ).toHaveLength(0);
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
      expect(listRequests).toContainEqual({
        id: expect.any(String),
        method: "tasks.list",
        params: {
          agentId: "main",
          limit: 200,
          status: ["completed", "failed", "timed_out", "cancelled"],
          sortBy: "endedAt",
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

  it("copies retained results through fallback and announces total failure", async () => {
    const artifactDir = createControlUiE2eArtifactDir("tasks-copy");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(() => {
      const state: ClipboardFaultState = {
        asyncWrites: [],
        execSucceeds: true,
        legacyWrites: [],
        mode: "reject",
        pending: [],
      };
      Object.defineProperty(window, "tasksClipboardFault", { value: state });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        get: () =>
          state.mode === "missing"
            ? undefined
            : {
                writeText(text: string) {
                  state.asyncWrites.push(text);
                  if (state.mode === "defer") {
                    return new Promise<void>((resolve, reject) => {
                      state.pending.push({ reject, resolve });
                    });
                  }
                  return Promise.reject(
                    new DOMException("Clipboard access denied", "NotAllowedError"),
                  );
                },
              },
      });
      document.execCommand = (command: string) => {
        if (command !== "copy") {
          return false;
        }
        state.legacyWrites.push(
          document.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
        );
        return state.execSucceeds;
      };
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
            sequence: [
              { task: { ...readOnlyRetainedTask, result: readOnlyRetainedResult } },
              { task: { ...readOnlyRetainedTask, result: readOnlyRetainedResult } },
              { task: { ...readOnlyRetainedTask, result: readOnlyRetainedResult } },
              { task: { ...readOnlyRetainedTask, result: olderRetainedResult } },
              { task: { ...readOnlyRetainedTask, result: newestRetainedResult } },
            ],
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
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
                .tasksClipboardFault,
          ),
        )
        .toMatchObject({
          asyncWrites: [readOnlyRetainedResult],
          legacyWrites: [readOnlyRetainedResult],
        });

      await page.evaluate(() => {
        (
          window as typeof window & { tasksClipboardFault: ClipboardFaultState }
        ).tasksClipboardFault.mode = "missing";
      });
      await copyButton.click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
                .tasksClipboardFault,
          ),
        )
        .toMatchObject({
          asyncWrites: [readOnlyRetainedResult],
          legacyWrites: [readOnlyRetainedResult, readOnlyRetainedResult],
        });

      await page.evaluate(() => {
        const state = (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
          .tasksClipboardFault;
        state.mode = "reject";
        state.execSucceeds = false;
      });
      await copyButton.click();
      await expect.poll(() => page.getByRole("alert").textContent()).toBe("Copy failed");
      await page.screenshot({ path: path.join(artifactDir, "05-copy-failed.png") });
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
              .tasksClipboardFault,
        ),
      ).toMatchObject({
        asyncWrites: [readOnlyRetainedResult, readOnlyRetainedResult],
        legacyWrites: [readOnlyRetainedResult, readOnlyRetainedResult, readOnlyRetainedResult],
      });

      await page.evaluate(() => {
        const state = (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
          .tasksClipboardFault;
        state.mode = "defer";
        state.execSucceeds = false;
      });
      await copyButton.click();
      await copyButton.click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
                .tasksClipboardFault.pending.length,
          ),
        )
        .toBe(2);
      await page.evaluate(() => {
        (
          window as typeof window & { tasksClipboardFault: ClipboardFaultState }
        ).tasksClipboardFault.pending[1]?.reject(
          new DOMException("Clipboard access denied", "NotAllowedError"),
        );
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
                .tasksClipboardFault.legacyWrites.length,
          ),
        )
        .toBe(4);
      await page.evaluate(() => {
        (
          window as typeof window & { tasksClipboardFault: ClipboardFaultState }
        ).tasksClipboardFault.pending[0]?.reject(
          new DOMException("Clipboard access denied", "NotAllowedError"),
        );
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          }),
      );
      const currentAlert = page.getByRole("alert");
      expect(await currentAlert.count()).toBe(1);
      expect(await currentAlert.textContent()).toBe("Copy failed");
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
              .tasksClipboardFault.legacyWrites,
        ),
      ).toEqual([
        readOnlyRetainedResult,
        readOnlyRetainedResult,
        readOnlyRetainedResult,
        newestRetainedResult,
      ]);

      await gateway.deferNext("tasks.get", { taskId: readOnlyRetainedTask.taskId });
      await copyButton.click();
      await expect.poll(() => gateway.getRequests("tasks.get")).toHaveLength(6);
      expect(await page.getByRole("alert").textContent()).toBe("Copy failed");
      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1012, "retire retained-result copy");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await gateway.resolveDeferred("tasks.get", {
        task: { ...readOnlyRetainedTask, result: readOnlyRetainedResult },
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          }),
      );
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { tasksClipboardFault: ClipboardFaultState })
              .tasksClipboardFault,
        ),
      ).toMatchObject({
        asyncWrites: [
          readOnlyRetainedResult,
          readOnlyRetainedResult,
          olderRetainedResult,
          newestRetainedResult,
        ],
        legacyWrites: [
          readOnlyRetainedResult,
          readOnlyRetainedResult,
          readOnlyRetainedResult,
          newestRetainedResult,
        ],
      });

      expect((await gateway.getRequests("tasks.get")).map((request) => request.params)).toEqual([
        { taskId: readOnlyRetainedTask.taskId },
        { taskId: readOnlyRetainedTask.taskId },
        { taskId: readOnlyRetainedTask.taskId },
        { taskId: readOnlyRetainedTask.taskId },
        { taskId: readOnlyRetainedTask.taskId },
        { taskId: readOnlyRetainedTask.taskId },
      ]);
      expect(await gateway.getRequests("tasks.retry")).toHaveLength(0);
      expect(await gateway.getRequests("tasks.dismiss")).toHaveLength(0);
      expect(await gateway.getRequests("tasks.cancel")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
