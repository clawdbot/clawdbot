import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { openChatSidePanelType } from "../../e2e/chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway, type MockGatewayRequest } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat background-tasks rail mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-background-tasks");
const baseTime = Date.now();
const chatSessionKey = "agent:main:main";

// Running tasks render a live elapsed label, so comparing raw transcript text makes the
// assertion fail whenever a second ticks over mid-check. Only the durations may move here.
function withoutElapsedLabels(text: string | null): string {
  return (text ?? "").replaceAll(/\d+(?:\.\d+)?\s*(?:ms|[smhd])\b/g, "<elapsed>");
}

function requestSessionKey(request: MockGatewayRequest): string | undefined {
  const { params } = request;
  if (
    typeof params !== "object" ||
    params === null ||
    !("sessionKey" in params) ||
    typeof params.sessionKey !== "string"
  ) {
    return undefined;
  }
  return params.sessionKey;
}

const runningSubagent = {
  id: "task-subagent",
  taskId: "task-subagent",
  kind: "subagent",
  runtime: "subagent",
  status: "running",
  title: "Map model routing code",
  agentId: "main",
  sessionKey: chatSessionKey,
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

suite.define(() => {
  it("opens the rail, applies pushed completion, and sends cancel", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    const railFlowDir = path.join(artifactDir, "rail-flow");
    await mkdir(railFlowDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: railFlowDir, size: { width: 1440, height: 900 } },
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ page }) => {
        // The transcript is compared byte-for-byte across the detail-panel
        // round-trip below; live relative ages ("11s") tick across second
        // boundaries on slow runners. Fix Date while keeping timers running.
        await page.clock.setFixedTime(baseTime);
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
            "tasks.cancel": {
              found: true,
              cancelled: true,
              task: { ...queuedCron, status: "cancelled", updatedAt: baseTime + 2_000 },
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);
        await page.getByText("Background tasks rail proof.").waitFor({ timeout: 10_000 });

        // The snapshot loads eagerly, so the panel action already carries the
        // two-active-task badge before the tab is opened.
        await expect
          .poll(() =>
            page.locator("openclaw-chat-header-session-menu").evaluate(
              (element) =>
                (
                  element as HTMLElement & {
                    panelActions: Array<{ id: string; badge?: number }>;
                  }
                ).panelActions.find((action) => action.id === "background-tasks")?.badge,
            ),
          )
          .toBe(2);

        await openChatSidePanelType(page, "Tasks");
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
          expect(request.params).toMatchObject({ sessionKey: "agent:main:main" });
          expect(request.params).not.toHaveProperty("agentId");
        }
        await page.screenshot({ path: path.join(railFlowDir, "01-rail-open.png"), fullPage: true });

        const chatUrl = page.url();
        const mainTranscript = page.locator(".chat-main .chat-thread");
        const mainTranscriptBefore = withoutElapsedLabels(await mainTranscript.textContent());
        const openRow = rail.locator('[data-task-id="task-subagent"]');
        await openRow.click();
        const detailPanel = page.locator("[data-task-detail-panel]");
        await detailPanel.waitFor({ state: "visible" });
        await detailPanel.getByText("Subagent transcript proof.").waitFor();
        expect(await detailPanel.textContent()).toContain("Map model routing code");
        expect(await detailPanel.textContent()).toContain("Subagent");
        expect(await openRow.getAttribute("aria-current")).toBe("true");
        expect(
          await openRow.evaluate((element) =>
            element.classList.contains("chat-tasks-rail__task--open"),
          ),
        ).toBe(true);
        await expect
          .poll(async () =>
            (await gateway.getRequests("chat.history")).some(
              (request) => requestSessionKey(request) === runningSubagent.childSessionKey,
            ),
          )
          .toBe(true);
        const transcriptRequest = (await gateway.getRequests("chat.history")).find(
          (request) => requestSessionKey(request) === runningSubagent.childSessionKey,
        );
        expect(transcriptRequest?.params).toEqual({
          sessionKey: runningSubagent.childSessionKey,
          limit: 800,
        });
        expect(page.url()).toBe(chatUrl);
        expect(withoutElapsedLabels(await mainTranscript.textContent())).toBe(mainTranscriptBefore);
        await page.screenshot({
          path: path.join(railFlowDir, "02-task-detail-sidebar.png"),
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
        await detailPanel.getByText("Completed").waitFor({ state: "visible" });
        await page
          .locator(".side-panel__header .tabstrip wa-tab")
          .filter({ hasText: "Tasks" })
          .click();
        const completedRow = rail.locator(
          '[data-tasks-section="finished"] [data-task-id="task-subagent"]',
        );
        await completedRow.waitFor({ state: "visible" });
        expect(await completedRow.getAttribute("aria-current")).toBe("true");
        expect(
          await rail
            .locator('[data-tasks-section="running"] [data-task-id="task-subagent"]')
            .count(),
        ).toBe(0);
        await page.screenshot({
          path: path.join(railFlowDir, "03-pushed-completion.png"),
          fullPage: true,
        });

        await rail
          .locator('[data-task-id="task-cron"]')
          .getByRole("button", { name: "Stop Nightly cleanup" })
          .click();
        const cancelRequest = await gateway.waitForRequest("tasks.cancel");
        expect(cancelRequest.params).toEqual({ taskId: "task-cron" });
        expect(page.url()).toBe(chatUrl);
        await page
          .locator(".side-panel__header .tabstrip wa-tab")
          .filter({ hasText: "Review" })
          .click();
        await detailPanel.waitFor({ state: "visible" });
        await page.getByText("Background tasks rail proof.").waitFor({ state: "visible" });
        expect(await mainTranscript.textContent()).not.toContain("Subagent transcript proof.");
        await page.screenshot({
          path: path.join(railFlowDir, "04-list-remains-with-detail-open.png"),
          fullPage: true,
        });

        // Region close leaves sidebarContent set; the rail highlight must
        // follow panel visibility, not retained content.
        await page.getByRole("button", { name: "Close Review" }).click();
        await detailPanel.waitFor({ state: "detached" });
        expect(await completedRow.getAttribute("aria-current")).toBe(null);
        expect(
          await completedRow.evaluate((element) =>
            element.classList.contains("chat-tasks-rail__task--open"),
          ),
        ).toBe(false);
      },
    );
  });

  it("streams two subagent activity rows and retains final diff chips", async () => {
    const activityDir = path.join(artifactDir, "subagent-activity");
    await mkdir(activityDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: activityDir, size: { width: 1280, height: 800 } },
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              content: [{ type: "text", text: "Parallel subagent activity proof." }],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
          methodResponses: {
            "chat.history": {
              cases: [
                {
                  match: { sessionKey: "agent:main:subagent:parallel-one" },
                  response: {
                    messages: [
                      {
                        content: [
                          { type: "text", text: "Inspecting session ownership boundaries." },
                        ],
                        role: "assistant",
                        timestamp: Date.now(),
                      },
                    ],
                    sessionId: "parallel-one-child",
                    thinkingLevel: null,
                  },
                },
              ],
            },
            "tasks.list": { tasks: [] },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);
        await page.getByText("Parallel subagent activity proof.").waitFor({ timeout: 10_000 });

        const first = {
          ...runningSubagent,
          id: "task-parallel-one",
          taskId: "task-parallel-one",
          childSessionKey: "agent:main:subagent:parallel-one",
          title: "Review session ownership",
          lastActivity: "Reviewing session ownership",
          diffStat: { files: 2, added: 14, removed: 3 },
        };
        const second = {
          ...runningSubagent,
          id: "task-parallel-two",
          taskId: "task-parallel-two",
          childSessionKey: "agent:main:subagent:parallel-two",
          title: "Review tool card rendering",
          lastActivity: "Checking tool card rendering",
          diffStat: { files: 1, added: 5, removed: 0 },
        };
        await gateway.emitGatewayEvent("task", { action: "upserted", task: first });
        await gateway.emitGatewayEvent("task", { action: "upserted", task: second });

        const activity = page.locator(".chat-subagent-activity");
        await expect.poll(() => activity.locator(".chat-subagent-activity__row").count()).toBe(2);
        const firstRow = activity.locator('[data-subagent-task-id="task-parallel-one"]');
        const secondRow = activity.locator('[data-subagent-task-id="task-parallel-two"]');
        expect(await firstRow.textContent()).toContain("Reviewing session ownership");
        expect(await secondRow.textContent()).toContain("Checking tool card rendering");
        expect(await firstRow.locator(".chat-diffstat__add").textContent()).toBe("+14");
        expect(await firstRow.locator(".chat-diffstat__del").textContent()).toBe("-3");
        await page.screenshot({
          path: path.join(activityDir, "01-two-subagents-streaming.png"),
          fullPage: true,
        });

        await firstRow.click();
        const detailPanel = page.locator("[data-task-detail-panel]");
        await detailPanel.waitFor({ state: "visible" });
        await detailPanel.getByText("Inspecting session ownership boundaries.").waitFor();
        expect(await detailPanel.textContent()).toContain("Review session ownership");
        expect(await detailPanel.textContent()).toContain("Running");
        await expect
          .poll(async () =>
            (await gateway.getRequests("chat.history")).some(
              (request) => requestSessionKey(request) === first.childSessionKey,
            ),
          )
          .toBe(true);
        const childHistoryRequest = (await gateway.getRequests("chat.history")).find(
          (request) => requestSessionKey(request) === first.childSessionKey,
        );
        expect(childHistoryRequest?.params).toEqual({
          sessionKey: first.childSessionKey,
          limit: 800,
        });

        await gateway.emitGatewayEvent("task", {
          action: "upserted",
          task: {
            ...first,
            updatedAt: baseTime + 1_000,
            lastActivity: "Cross-checking requester ownership",
          },
        });
        await firstRow.getByText("Cross-checking requester ownership").waitFor();

        await gateway.emitGatewayEvent("task", {
          action: "upserted",
          task: {
            id: first.id,
            taskId: first.taskId,
            kind: first.kind,
            runtime: first.runtime,
            status: "completed",
            title: first.title,
            agentId: first.agentId,
            sessionKey: first.sessionKey,
            ownerKey: first.ownerKey,
            childSessionKey: first.childSessionKey,
            createdAt: first.createdAt,
            startedAt: first.startedAt,
            updatedAt: baseTime + 2_000,
            endedAt: baseTime + 2_000,
            terminalSummary: "Ownership review complete",
          },
        });

        await firstRow.getByText("Subagent finished").waitFor();
        await detailPanel.getByText("Completed").waitFor();
        expect(await firstRow.textContent()).toContain("Ownership review complete");
        expect(await firstRow.locator(".chat-diffstat__add").textContent()).toBe("+14");
        expect(await firstRow.locator(".chat-diffstat__del").textContent()).toBe("-3");
        expect(await secondRow.textContent()).toContain("Subagent working");
        expect(await secondRow.textContent()).toContain("Checking tool card rendering");
        await page.screenshot({
          path: path.join(activityDir, "02-one-subagent-finished.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Close Review" }).click();
        await detailPanel.waitFor({ state: "detached" });
      },
    );
  });

  it("shows one detached exec after the agent turn ends", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ page }) => {
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

        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);
        await page
          .getByText("I started the CLI command in the background.")
          .waitFor({ timeout: 10_000 });
        await expect
          .poll(() =>
            page.locator("openclaw-chat-header-session-menu").evaluate(
              (element) =>
                (
                  element as HTMLElement & {
                    panelActions: Array<{ id: string; badge?: number }>;
                  }
                ).panelActions.find((action) => action.id === "background-tasks")?.badge,
            ),
          )
          .toBe(1);
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
          path: path.join(artifactDir, "08-running-task-popover-centered.png"),
          fullPage: true,
        });

        await openChatSidePanelType(page, "Tasks");
        const row = page.locator('[data-task-id="task-exec"]');
        await row.waitFor({ state: "visible" });
        expect(await row.textContent()).toContain("CLI command");
        expect(await row.textContent()).toContain("Command running");
        await page.screenshot({
          path: path.join(artifactDir, "09-one-background-exec.png"),
          fullPage: true,
        });
      },
    );
  });
});
