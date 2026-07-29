import { mkdir, rm } from "node:fs/promises";
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
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-background-tasks");
const baseTime = Date.now();
const chatSessionKey = "agent:main:main";

const runningSubagent = {
  id: "task-subagent",
  taskId: "task-subagent",
  kind: "subagent",
  runtime: "subagent",
  status: "running",
  title: "Map model routing code",
  agentId: "main",
  ownerKey: chatSessionKey,
  childSessionKey: "agent:main:subagent:routing",
  createdAt: baseTime - 5_000,
  updatedAt: baseTime,
  startedAt: baseTime - 4_000,
  toolUseCount: 12,
  lastToolName: "read",
  progressSummary: "Reading provider catalogs",
};

const queuedCron = {
  id: "task-cron",
  taskId: "task-cron",
  kind: "cron",
  runtime: "cron",
  status: "queued",
  title: "Nightly cleanup",
  agentId: "main",
  ownerKey: chatSessionKey,
  sessionKey: "agent:main:cron:cleanup",
  createdAt: baseTime - 10_000,
  updatedAt: baseTime - 1_000,
};

const finishedCli = {
  id: "task-cli",
  taskId: "task-cli",
  kind: "cli",
  runtime: "cli",
  status: "failed",
  title: "Generate media index",
  agentId: "main",
  ownerKey: chatSessionKey,
  sessionKey: "agent:main:cli:media",
  createdAt: baseTime - 30_000,
  updatedAt: baseTime - 20_000,
  error: "Index generation failed",
};

const runningExec = {
  id: "task-exec",
  taskId: "task-exec",
  kind: "exec",
  runtime: "cli",
  status: "running",
  title: "CLI command",
  agentId: "main",
  ownerKey: chatSessionKey,
  createdAt: baseTime - 2_000,
  updatedAt: baseTime,
  startedAt: baseTime - 2_000,
  progressSummary: "Command running",
};

let server: ControlUiE2eServer;
let browser: Browser;

describeControlUiE2e("Control UI chat background-tasks rail mocked Gateway E2E", () => {
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

  it("opens the rail, applies pushed completion, and sends cancel", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            content: [{ type: "text", text: "Background tasks rail proof." }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
        methodResponses: {
          "chat.history": {
            cases: [
              {
                match: { sessionKey: runningSubagent.childSessionKey },
                response: {
                  messages: [
                    {
                      content: [{ type: "text", text: "Subagent transcript proof." }],
                      role: "assistant",
                      timestamp: Date.now(),
                    },
                  ],
                  sessionId: "subagent-transcript",
                  thinkingLevel: null,
                },
              },
            ],
          },
          "tasks.list": { tasks: [runningSubagent, queuedCron, finishedCli] },
          "tasks.get": {
            task: {
              ...runningSubagent,
              prompt: "Trace model routing across provider and session boundaries.",
            },
          },
          "tasks.cancel": {
            found: true,
            cancelled: true,
            task: { ...queuedCron, status: "cancelled", updatedAt: baseTime + 2_000 },
          },
        },
      });

      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      await page.getByText("Background tasks rail proof.").waitFor({ timeout: 10_000 });

      // The snapshot loads eagerly, so the collapsed toggle badge already
      // detects the two active tasks before the rail is ever opened.
      const badge = page.locator(".chat-tasks-toggle__badge");
      await badge.waitFor({ state: "visible" });
      expect(await badge.textContent()).toBe("2");

      await page.getByRole("button", { name: "Show background tasks" }).click();
      const rail = page.locator(".chat-tasks-rail");
      await rail.locator('[data-task-id="task-subagent"]').waitFor({ state: "visible" });
      await rail.locator('[data-task-id="task-cron"]').waitFor({ state: "visible" });
      // Finished history starts collapsed: only the section header with the
      // count renders until it is expanded.
      const finishedToggle = rail.getByRole("button", { name: "Finished (1)" });
      await finishedToggle.waitFor({ state: "visible" });
      expect(await rail.locator('[data-task-id="task-cli"]').count()).toBe(0);
      await finishedToggle.click();
      await rail.locator('[data-task-id="task-cli"]').waitFor({ state: "visible" });
      const railText = await rail.textContent();
      expect(railText).toContain("Reading provider catalogs");
      expect(railText).toContain("12 tool uses");
      expect(railText).toContain("read");

      const listRequests = await gateway.getRequests("tasks.list");
      expect(listRequests.length).toBeGreaterThanOrEqual(2);
      for (const request of listRequests) {
        expect(request.params).toMatchObject({ sessionKey: "main" });
        expect(request.params).not.toHaveProperty("agentId");
      }
      await page.screenshot({ path: path.join(artifactDir, "01-rail-open.png"), fullPage: true });

      const chatUrl = page.url();
      await rail
        .locator('[data-task-id="task-subagent"]')
        .getByRole("button", { name: "Show details for Map model routing code" })
        .click();
      await rail.getByText("Trace model routing across provider and session boundaries.").waitFor();
      expect(await rail.textContent()).toContain("Reading provider catalogs");
      expect(await rail.getByRole("button", { name: "Back to background tasks" }).count()).toBe(1);
      expect(await rail.getByRole("button", { name: "View transcript" }).count()).toBe(0);
      expect(page.url()).toBe(chatUrl);
      await page.getByText("Background tasks rail proof.").waitFor({ state: "visible" });
      const detailRequest = await gateway.waitForRequest("tasks.get");
      expect(detailRequest.params).toEqual({ taskId: "task-subagent" });
      await page.screenshot({
        path: path.join(artifactDir, "02-task-detail.png"),
        fullPage: true,
      });

      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: {
          ...runningSubagent,
          status: "completed",
          updatedAt: baseTime + 1_000,
          terminalSummary: "Routing map complete",
        },
      });
      await rail.getByText("Routing map complete").waitFor({ state: "visible" });
      await page.screenshot({
        path: path.join(artifactDir, "03-pushed-completion.png"),
        fullPage: true,
      });

      await rail.getByRole("button", { name: "Back to background tasks" }).click();
      await rail
        .locator('[data-tasks-section="finished"] [data-task-id="task-subagent"]')
        .waitFor({ state: "visible" });
      await rail
        .locator('[data-tasks-section="running"] [data-task-id="task-subagent"]')
        .waitFor({ state: "detached" });

      await rail
        .locator('[data-task-id="task-cron"]')
        .getByRole("button", { name: "Stop Nightly cleanup" })
        .click();
      const cancelRequest = await gateway.waitForRequest("tasks.cancel");
      expect(cancelRequest.params).toEqual({ taskId: "task-cron" });
      expect(page.url()).toBe(chatUrl);
      expect(
        (await gateway.getRequests("chat.history")).some(
          (request) =>
            (request.params as { sessionKey?: string }).sessionKey ===
            runningSubagent.childSessionKey,
        ),
      ).toBe(false);
      await page.screenshot({
        path: path.join(artifactDir, "04-back-to-list.png"),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });

  it("shows one detached exec after the agent turn ends", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        historyMessages: [
          {
            content: [{ type: "text", text: "I started the CLI command in the background." }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
        methodResponses: {
          "tasks.list": { tasks: [runningExec] },
        },
      });

      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      await page
        .getByText("I started the CLI command in the background.")
        .waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-tasks-toggle__badge").textContent()).toBe("1");
      expect(await page.locator(".chat-tasks-status__link").textContent()).toContain(
        "1 running task",
      );
      const statusLink = page.locator(".chat-tasks-status__link");
      await statusLink.hover();
      const previewBody = page.locator(
        "openclaw-tooltip.chat-tasks-status__preview wa-tooltip[open] .body",
      );
      await previewBody.waitFor({ state: "visible" });
      const linkBox = await statusLink.boundingBox();
      const previewBox = await previewBody.boundingBox();
      expect(linkBox).not.toBeNull();
      expect(previewBox).not.toBeNull();
      if (!linkBox || !previewBox) {
        throw new Error("expected running-task link and preview geometry");
      }
      const linkCenter = linkBox.x + linkBox.width / 2;
      const previewCenter = previewBox.x + previewBox.width / 2;
      expect(Math.abs(previewCenter - linkCenter)).toBeLessThanOrEqual(2);
      expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(linkBox.y);
      await page.screenshot({
        path: path.join(artifactDir, "05-running-task-popover-centered.png"),
        fullPage: true,
      });

      await page.getByRole("button", { name: "Show background tasks" }).click();
      const row = page.locator('[data-task-id="task-exec"]');
      await row.waitFor({ state: "visible" });
      expect(await row.textContent()).toContain("CLI command");
      expect(await row.textContent()).toContain("Command running");
      await page.screenshot({
        path: path.join(artifactDir, "06-one-background-exec.png"),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
});
