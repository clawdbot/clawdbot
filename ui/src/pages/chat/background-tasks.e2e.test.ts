import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
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
    await mkdir(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ page }) => {
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
                {
                  match: { sessionKey: finishedCli.sessionKey },
                  response: {
                    messages: [
                      {
                        content: [
                          { type: "text", text: "CLI transcript stayed in the task rail." },
                        ],
                        role: "assistant",
                        timestamp: Date.now(),
                      },
                    ],
                    sessionId: "cli-task-transcript",
                    thinkingLevel: null,
                  },
                },
              ],
            },
            "tasks.list": { tasks: [runningSubagent, queuedCron, finishedCli] },
            "tasks.get": {
              cases: [
                {
                  match: { taskId: runningSubagent.id },
                  response: {
                    task: {
                      ...runningSubagent,
                      prompt: "Trace model routing across provider and session boundaries.",
                    },
                  },
                },
                {
                  match: { taskId: finishedCli.id },
                  response: {
                    task: {
                      ...finishedCli,
                      prompt: "Generate a searchable media index.",
                    },
                  },
                },
              ],
            },
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
        await rail
          .getByText("Trace model routing across provider and session boundaries.")
          .waitFor();
        expect(await rail.textContent()).toContain("Reading provider catalogs");
        expect(await rail.getByRole("button", { name: "Back to background tasks" }).count()).toBe(
          1,
        );
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
            (request) => requestSessionKey(request) === runningSubagent.childSessionKey,
          ),
        ).toBe(false);
        await page.screenshot({
          path: path.join(artifactDir, "04-back-to-list.png"),
          fullPage: true,
        });

        const mainTranscript = page.locator(".chat-main .chat-thread");
        const mainTranscriptBefore = await mainTranscript.textContent();
        await rail
          .locator('[data-task-id="task-cli"]')
          .getByRole("button", { name: "Show details for Generate media index" })
          .click();
        await rail.getByText("Generate a searchable media index.").waitFor();
        await page.screenshot({
          path: path.join(artifactDir, "05-cli-task-detail.png"),
          fullPage: true,
        });

        await rail.getByRole("button", { name: "View transcript" }).click();
        await expect
          .poll(async () =>
            (await gateway.getRequests("chat.history")).some(
              (request) => requestSessionKey(request) === finishedCli.sessionKey,
            ),
          )
          .toBe(true);
        const transcriptRequest = (await gateway.getRequests("chat.history")).find(
          (request) => requestSessionKey(request) === finishedCli.sessionKey,
        );
        expect(transcriptRequest?.params).toEqual({
          sessionKey: finishedCli.sessionKey,
          limit: 100,
        });
        await rail.getByText("CLI transcript stayed in the task rail.").waitFor();
        expect(await rail.locator(".chat-thread").textContent()).toContain(
          "CLI transcript stayed in the task rail.",
        );
        expect(page.url()).toBe(chatUrl);
        expect(await mainTranscript.textContent()).toBe(mainTranscriptBefore);
        expect(await rail.getByRole("button", { name: "Back to task details" }).count()).toBe(1);
        await page.screenshot({
          path: path.join(artifactDir, "06-cli-task-transcript.png"),
          fullPage: true,
        });

        await rail.getByRole("button", { name: "Back to task details" }).click();
        await rail.locator('[data-task-detail="task-cli"]').waitFor({ state: "visible" });
        await rail.getByText("Generate a searchable media index.").waitFor();
        expect(page.url()).toBe(chatUrl);
        expect(await mainTranscript.textContent()).toBe(mainTranscriptBefore);
        await page.screenshot({
          path: path.join(artifactDir, "07-cli-task-detail-restored.png"),
          fullPage: true,
        });
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
          path: path.join(artifactDir, "08-running-task-popover-centered.png"),
          fullPage: true,
        });

        await page.getByRole("button", { name: "Show background tasks" }).click();
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
