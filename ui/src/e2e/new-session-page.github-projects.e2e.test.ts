import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureProjectUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  prepareProjectUiProof,
  projectProofArtifactDir,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { name: "shows workspace preparation in the admitted session", failure: null },
    {
      name: "keeps a project preparation failure actionable in the admitted session",
      failure: "Repository clone failed; verify repository access and try again.",
    },
  ])("keeps GitHub selection inert and $name", async ({ failure }) => {
    await prepareProjectUiProof();
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: projectProofArtifactDir,
              size: { height: 900, width: 1280 },
            },
            viewport: { height: 900, width: 1280 },
          }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:cloned-project-e2e";
    const runId = "run-cloned-project-e2e";
    const message = "inspect the cloned project";
    let releaseChatModule!: () => void;
    let chatModuleRequested = false;
    const chatModuleBlocked = new Promise<void>((resolve) => {
      releaseChatModule = resolve;
    });
    await page.route("**/assets/chat-page-*.js*", async (route) => {
      chatModuleRequested = true;
      await chatModuleBlocked;
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      historyMessages: [
        {
          role: "user",
          content: [{ type: "text", text: message }],
          timestamp: Date.now(),
          __openclaw: {
            id: "persisted-remote-project-prompt",
            idempotencyKey: `${runId}:user`,
            seq: 1,
          },
        },
      ],
      inFlightRun: {
        runId,
        startedAt: Date.now(),
        events: [
          {
            runId,
            sessionKey,
            seq: 1,
            stream: "run_status",
            ts: Date.now(),
            data: { phase: "preparing_workspace" },
          },
        ],
      },
      sessionInfo: {
        hasActiveRun: true,
        activeRunIds: [runId],
        key: sessionKey,
        status: "running",
      },
      featureMethods: [
        "chat.abort",
        "chat.metadata",
        "chat.send",
        "chat.startup",
        "projects.add",
        "projects.list",
        "projects.searchRemote",
        "sessions.create",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": { projects: [] },
        "projects.searchRemote": {
          credential: "missing",
          projects: [
            {
              name: "openclaw",
              fullName: "openclaw/openclaw",
              description: "Personal AI assistant",
              cloneUrl: "https://github.com/openclaw/openclaw.git",
              webUrl: "https://github.com/openclaw/openclaw",
              private: false,
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey, runStarted: true, runId, messageSeq: 1 },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      const search = place.getByRole("searchbox", {
        name: "Search projects or paste a Git URL",
      });
      await search.fill("openclaw");

      const searchRequest = await gateway.waitForRequest("projects.searchRemote");
      expect(searchRequest.params).toEqual({ query: "openclaw" });
      await place
        .getByText(
          "No Control UI GitHub credential or shared Gateway environment token is configured; public GitHub results only.",
        )
        .waitFor();
      await place.getByRole("button", { name: /openclaw\/openclaw/u }).click();

      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw/openclaw",
      );
      expect(await trigger.getAttribute("data-project-id")).toBeNull();

      const permission = page.locator('[data-chat-permission-select="true"]');
      await permission.click();
      await page.locator('[data-chat-permission-option="read-only"]').click();
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message,
        permissionMode: "read-only",
        projectGitUrl: "https://github.com/openclaw/openclaw.git",
      });
      expect(create.params).not.toHaveProperty("cwd");
      expect(create.params).not.toHaveProperty("projectId");
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);

      await expect.poll(() => chatModuleRequested).toBe(true);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 1,
        state: "status",
        phase: "preparing_workspace",
      });
      releaseChatModule();
      await waitForCommittedChatRoute(page);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await gateway.waitForRequest("chat.startup");

      const working = page.locator('.chat-working-indicator[role="status"]');
      await pollLocatorText(working).toContain("Preparing workspace…");
      await expect.poll(() => page.locator(".chat-group.user").count()).toBe(1);
      expect(await working.locator(".chat-reading-indicator").count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await captureProjectUiProof(page, "project-cloning.png");

      if (!failure) {
        await gateway.emitChatFinal({ runId, sessionKey, text: "Project workspace is ready." });
        await page
          .getByRole("paragraph")
          .filter({ hasText: "Project workspace is ready." })
          .waitFor();
        await expect.poll(() => working.count()).toBe(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        return;
      }

      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 2,
        state: "error",
        errorMessage: failure,
      });
      const alert = page.locator('.chat-error[role="alert"]');
      await pollLocatorText(alert).toContain(failure);
      await expect.poll(() => working.count()).toBe(0);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await captureProjectUiProof(page, "project-cloning-failed.png");

      await composer.fill(message);
      await page.getByRole("button", { name: "Send message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({ sessionKey, message });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
    } finally {
      releaseChatModule();
      await context.close();
    }
  });
});
