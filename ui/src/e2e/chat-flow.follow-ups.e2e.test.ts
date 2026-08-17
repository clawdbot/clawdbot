import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens a git-backed agent draft from the sidebar new-session action", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { workspaceGit: true });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const newSessionButton = page.locator("openclaw-app-sidebar .sidebar-brand__new-thread");
      await newSessionButton.waitFor({ state: "visible", timeout: 10_000 });
      await newSessionButton.click();

      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("main");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("starts a model-suggested follow-up in a fresh worktree session", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const suggestion = {
      id: "task_123",
      title: "Remove stale adapter",
      prompt: "Delete the stale adapter in src/example.ts and update tests.",
      tldr: "The adapter is unreachable and adds maintenance cost.",
      cwd: "/projects/example",
      sessionKey: "main",
      agentId: "main",
      createdAt: Date.now(),
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["taskSuggestions.list"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "taskSuggestions.list",
        "taskSuggestions.accept",
      ],
      methodResponses: {
        "taskSuggestions.list": { suggestions: [suggestion] },
        "taskSuggestions.accept": {
          taskId: "task_123",
          key: "agent:main:dashboard:suggested",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("taskSuggestions.list");
      await gateway.emitGatewayEvent("task.suggestion", {
        action: "created",
        suggestion,
      });
      await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });

      const startButton = page.getByRole("button", { name: "Start with worktree" });
      await startButton.waitFor({ state: "visible", timeout: 10_000 });
      const moreActions = page.getByRole("button", { name: "More ways to start this task" });
      expect(await moreActions.count()).toBe(1);
      const [startBox, moreActionsBox] = await Promise.all([
        startButton.boundingBox(),
        moreActions.boundingBox(),
      ]);
      expect(startBox).not.toBeNull();
      expect(moreActionsBox).not.toBeNull();
      expect(
        (moreActionsBox?.x ?? 0) - ((startBox?.x ?? 0) + (startBox?.width ?? 0)),
      ).toBeGreaterThanOrEqual(4);
      await moreActions.click();
      await page
        .getByText("Copy prompt", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      expect(await page.getByText("Start locally", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Fix in this session", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Send to cloud", { exact: true }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.getByText("Show instructions", { exact: true }).click();
      await page
        .getByText("/projects/example", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByText("Delete the stale adapter in src/example.ts and update tests.", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 10_000 });
      await startButton.click();

      const acceptRequest = await gateway.waitForRequest("taskSuggestions.accept");
      expect(acceptRequest.params).toEqual({ taskId: "task_123" });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("fixes a model-suggested follow-up in the source session", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const suggestion = {
      id: "task_session",
      title: "Repair the active flow",
      prompt: "Fix the active flow and keep this transcript selected.",
      tldr: "The follow-up belongs in this session.",
      cwd: "/projects/example",
      sessionKey: "main",
      agentId: "main",
      createdAt: Date.now(),
    };
    const gateway = await installMockGateway(page, {
      featureCapabilities: [GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "environments.list",
        "taskSuggestions.list",
        "taskSuggestions.accept",
      ],
      methodResponses: {
        "environments.list": { environments: [], profiles: [] },
        "taskSuggestions.list": { suggestions: [suggestion] },
        "taskSuggestions.accept": { taskId: suggestion.id, key: suggestion.sessionKey },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page.locator(`.task-suggestion[data-task-id="${suggestion.id}"]`);
      await card.waitFor({ state: "visible", timeout: 10_000 });
      await gateway.waitForRequest("environments.list");
      const routeBeforeAccept = page.url();
      await card.getByRole("button", { name: "More ways to start this task" }).click();
      const sessionItem = card.locator('wa-dropdown-item[value="session"]');
      await sessionItem.waitFor({ state: "visible", timeout: 10_000 });
      await sessionItem.click();

      const acceptRequest = await gateway.waitForRequest("taskSuggestions.accept");
      expect(acceptRequest.params).toEqual({ taskId: suggestion.id, mode: "session" });
      await expect.poll(() => card.count()).toBe(0);
      expect(page.url()).toBe(routeBeforeAccept);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("clears model-suggested follow-ups while switching sessions", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "taskSuggestions.list",
        "taskSuggestions.accept",
        "taskSuggestions.dismiss",
      ],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
        "taskSuggestions.list": {
          suggestions: [
            {
              id: "task_session_a",
              title: "Follow up from session A",
              prompt: "Complete the follow-up discovered in session A.",
              tldr: "This suggestion belongs only to session A.",
              cwd: "/projects/example",
              sessionKey: "agent:main:session-a",
              agentId: "main",
              createdAt: Date.now(),
            },
          ],
        },
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const startButton = page.getByRole("button", { name: "Start with worktree" });
      await startButton.waitFor({ state: "visible", timeout: 10_000 });
      await gateway.deferNext("taskSuggestions.list");
      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      await waitForRequests(gateway, "taskSuggestions.list", 2);

      await expect.poll(() => startButton.count()).toBe(0);
      await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps copy available when only listing is advertised", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "taskSuggestions.list"],
      methodResponses: {
        "taskSuggestions.list": {
          suggestions: [
            {
              id: "task_list_only",
              title: "Read-only follow-up",
              prompt: "Copy this suggestion without mutating it.",
              tldr: "Listing alone still exposes the client-local copy action.",
              cwd: "/projects/example",
              sessionKey: "main",
              agentId: "main",
              createdAt: Date.now(),
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("taskSuggestions.list");
      await expect
        .poll(() =>
          page
            .locator("openclaw-chat-pane")
            .evaluate(
              (pane) =>
                (pane as HTMLElement & { taskSuggestions?: unknown[] }).taskSuggestions?.length ??
                0,
            ),
        )
        .toBe(1);

      await page
        .locator(".agent-chat__composer-shell")
        .waitFor({ state: "visible", timeout: 10_000 });
      const card = page.locator('.task-suggestion[data-task-id="task_list_only"]');
      await card.waitFor({ state: "visible", timeout: 10_000 });
      expect(await card.getByRole("button", { name: "Start with worktree" }).isDisabled()).toBe(
        true,
      );
      await card.getByRole("button", { name: "More ways to start this task" }).click();
      await card
        .getByText("Copy prompt", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the composer visible when follow-up suggestions overflow", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "taskSuggestions.list",
        "taskSuggestions.accept",
        "taskSuggestions.dismiss",
      ],
      methodResponses: {
        "taskSuggestions.list": {
          suggestions: Array.from({ length: 12 }, (_, index) => ({
            id: `task_overflow_${index}`,
            title: `Follow-up ${index}`,
            prompt: "Inspect the related implementation and tests. ".repeat(12),
            tldr: "This follow-up remains useful but must not hide the composer.",
            cwd: "/projects/example",
            sessionKey: "main",
            agentId: "main",
            createdAt: Date.now() + index,
          })),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const tray = page.locator(".task-suggestions");
      await tray.waitFor({ state: "visible", timeout: 10_000 });
      expect(await tray.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );

      const composer = page.locator(".agent-chat__composer-shell");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? 720) + (box?.height ?? 0)).toBeLessThanOrEqual(720);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("waits for configured inference before sending the first chat turn", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "ops",
      deferredMethods: ["chat.startup"],
      historyMessages: [],
      models: [
        {
          available: true,
          id: "startup-model",
          name: "Startup Model",
          provider: "openai",
        },
      ],
      sessionKey: "global",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("agents.list")).toHaveLength(0);
      // chat.startup owns the initial metadata load; the old parallel
      // chat.metadata request was only a synchronization point for this test.
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const sendButton = page.getByRole("button", { name: "Send message" });
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sendButton.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.resolveDeferred("chat.startup", {
        agentsList: {
          agents: [
            {
              id: "ops",
              model: { primary: "openai/startup-model" },
              name: "OpenClaw",
            },
          ],
          defaultId: "ops",
          mainKey: "main",
          scope: "agent",
        },
        messages: [],
        metadata: {
          commands: [
            {
              acceptsArgs: false,
              description: "Loaded after startup completes",
              name: "startup-ready",
              scope: "text",
              source: "native",
            },
          ],
          models: [
            {
              available: true,
              id: "startup-model",
              name: "Startup Model",
              provider: "openai",
            },
          ],
        },
        sessionId: "control-ui-e2e-session",
        thinkingLevel: null,
      });

      const prompt = "send after configured inference loads";
      await composer.fill(prompt);
      await sendButton.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sendButton.isEnabled()).toBe(true);
      await sendButton.click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => composer.inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      expect(params.message).toBe(prompt);
      expect(params.sessionKey).toBe("global");
      expect(params.agentId).toBe("ops");

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await gateway.emitGatewayEvent("chat", {
        deltaText: "First token visible.",
        message: {
          content: [{ text: "First token visible.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        agentId: "ops",
        sessionKey: "global",
        state: "delta",
      });
      await page.getByText("First token visible.").waitFor({ timeout: 10_000 });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await page.getByText("First token visible.").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => page.locator('[data-chat-model-option="openai/startup-model"]').count())
        .toBe(1);
      await gateway.emitChatFinal({ runId, text: "History race stayed visible." });
      await page
        .locator(".chat-thread-inner")
        .getByText("History race stayed visible.")
        .waitFor({ timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill("/");
      await page.getByRole("option", { name: /\/startup-ready/ }).waitFor({ timeout: 10_000 });
      // Check after both controls render so no late fallback RPC supplied either catalog.
      expect({
        commands: (await gateway.getRequests("commands.list")).length,
        metadata: (await gateway.getRequests("chat.metadata")).length,
        models: (await gateway.getRequests("models.list")).length,
      }).toEqual({ commands: 0, metadata: 0, models: 0 });
      expect(await gateway.getRequests("agents.list")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
