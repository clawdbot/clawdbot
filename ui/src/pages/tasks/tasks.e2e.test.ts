import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
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

let server: ControlUiE2eServer;
let browser: Browser;

describeControlUiE2e("Control UI Tasks mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders task sections, applies pushed completion, and sends cancel", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    const rawVideoDir = path.join(artifactDir, "raw-video");
    await mkdir(rawVideoDir, { recursive: true });
    const context = await browser.newContext({
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
            tasks: [runningTask, queuedTask, completedTask, failedTask],
          },
          "tasks.cancel": {
            found: true,
            cancelled: true,
            task: { ...queuedTask, status: "cancelled", updatedAt: baseTime + 2_000 },
          },
        },
      });

      const response = await page.goto(`${server.baseUrl}tasks`);
      expect(response?.status()).toBe(200);
      const active = page.locator('[data-task-section="active"]');
      const recent = page.locator('[data-task-section="recent"]');
      await active.locator('[data-task-id="task-running"]').waitFor({ state: "visible" });
      await active.locator('[data-task-id="task-queued"]').waitFor({ state: "visible" });
      await recent.locator('[data-task-id="task-completed"]').waitFor({ state: "visible" });
      await recent.locator('[data-task-id="task-failed"]').waitFor({ state: "visible" });
      expect(await active.textContent()).toContain("Reading subscription paths");
      expect(await recent.textContent()).toContain("Worker exited");
      await page.screenshot({
        path: path.join(artifactDir, "01-task-sections.png"),
        fullPage: true,
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
        fullPage: true,
      });

      await active
        .locator('[data-task-id="task-queued"]')
        .getByRole("button", { name: "Cancel Nightly cleanup" })
        .click();
      const cancelRequest = await gateway.waitForRequest("tasks.cancel");
      expect(cancelRequest.params).toEqual({ taskId: "task-queued" });
    } finally {
      await context.close();
      if (video) {
        await copyFile(await video.path(), path.join(artifactDir, "tasks-flow.webm"));
      }
      await rm(rawVideoDir, { force: true, recursive: true });
    }
  });
});
