import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
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
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
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
      if (artifactDir) {
        await page.locator('.task-suggestion[data-task-id="task_123"]').screenshot({
          path: `${artifactDir}/task-card-button-spacing.png`,
        });
      }
      const startBox = await startButton.boundingBox();
      const moreActionsBox = await moreActions.boundingBox();
      expect(startBox).not.toBeNull();
      expect(moreActionsBox).not.toBeNull();
      expect(moreActionsBox!.x - (startBox!.x + startBox!.width)).toBeGreaterThanOrEqual(4);
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

  it("steers ordinary follow-ups when the server default is steer", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "steer" }, mode: "followup" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-steer-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const originalPrompt = "keep this run active";
      await page.locator(".agent-chat__composer-combobox textarea").fill(originalPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const initialSend = await gateway.waitForRequest("chat.send");
      const activeRunId = requireString(
        requireRecord(initialSend.params).idempotencyKey,
        "active chat run id",
      );
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [activeRunId],
        clientRunId: activeRunId,
        hasActiveRun: true,
        message: {
          __openclaw: {
            id: "persisted-original-user",
            idempotencyKey: `${activeRunId}:user`,
            seq: 1,
          },
          content: [{ text: originalPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "persisted-original-user",
        messageSeq: 1,
        session: {
          activeRunIds: [activeRunId],
          hasActiveRun: true,
          key: "main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const followUp = "tighten the active plan";
      await page.locator(".agent-chat__composer-combobox textarea").fill(followUp);
      await page.getByRole("button", { name: "Steer into the active run" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const steerParams = requireRecord(sends[1]?.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        message: followUp,
        sessionKey: "main",
      });
      const steerRunId = requireString(steerParams.idempotencyKey, "steer run id");
      const queue = page.locator(".chat-queue");
      await queue.locator(".chat-queue__badge--steered", { hasText: "Steering" }).waitFor({
        timeout: 10_000,
      });
      await queue.getByText(followUp).waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/steer-before-persistence.png`,
          fullPage: true,
        });
      }
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [activeRunId],
        clientRunId: activeRunId,
        hasActiveRun: true,
        message: {
          __openclaw: {
            id: "persisted-steer-user",
            idempotencyKey: `${steerRunId}:user`,
            seq: 2,
          },
          content: [{ text: followUp, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "persisted-steer-user",
        messageSeq: 2,
        session: {
          activeRunIds: [activeRunId],
          hasActiveRun: true,
          key: "main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });

      await queue.getByText(followUp).waitFor({ state: "detached", timeout: 10_000 });
      await expect
        .poll(() => page.locator(".chat-thread .chat-group.user", { hasText: followUp }).count())
        .toBe(1);
      await expect
        .poll(() =>
          page.locator(".chat-thread-inner").evaluate(
            (thread, texts) => {
              const bubbles = Array.from(thread.querySelectorAll(".chat-bubble"));
              return texts.map((text) =>
                bubbles.findIndex((bubble) => bubble.textContent?.includes(text)),
              );
            },
            [originalPrompt, followUp],
          ),
        )
        .toEqual([0, 1]);
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/steer-after-persistence.png`,
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("preserves a non-steer server default for active-run follow-ups", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "followup" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-followup-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const followUpSelect = page.locator("[data-settings-follow-up-mode]");
      await followUpSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await followUpSelect.inputValue()).toBe("server");
      await page.getByText("Using server default (followup)").waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/server-followup-setting.png`,
          fullPage: true,
        });
      }
      const configPatchCount = (await gateway.getRequests("config.patch")).length;
      const configGetCount = (await gateway.getRequests("config.get")).length;
      const overrideConfig = {
        ...runtimeConfig,
        ui: { prefs: { chatFollowUpMode: "steer" } },
      };
      await gateway.setMethodResponse("config.get", {
        config: overrideConfig,
        hash: "queue-followup-override-config",
        issues: [],
        raw: JSON.stringify(overrideConfig),
        runtimeConfig: overrideConfig,
        valid: true,
      });
      await followUpSelect.selectOption("steer");
      await waitForRequests(gateway, "config.patch", configPatchCount + 1);
      await waitForRequests(gateway, "config.get", configGetCount + 1);
      await page.getByText("Overriding server default (followup)").waitFor({ timeout: 10_000 });
      await gateway.setMethodResponse("config.get", {
        config: runtimeConfig,
        hash: "queue-followup-reset-config",
        issues: [],
        raw: JSON.stringify(runtimeConfig),
        runtimeConfig,
        valid: true,
      });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/server-followup-override.png`,
          fullPage: true,
        });
      }
      await page.getByRole("button", { name: "Reset to server default" }).click();
      await waitForRequests(gateway, "config.patch", configPatchCount + 2);
      await waitForRequests(gateway, "config.get", configGetCount + 2);
      await page.getByText("Using server default (followup)").waitFor({ timeout: 10_000 });
      expect(await followUpSelect.inputValue()).toBe("server");

      await page.goto(`${suite.server.baseUrl}chat`);

      const activePrompt = "keep this run active";
      await page.locator(".agent-chat__composer-combobox textarea").fill(activePrompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedPrompt = "queue this on the server";
      await page.locator(".agent-chat__composer-combobox textarea").fill(queuedPrompt);
      await page.getByRole("button", { name: "Queue message" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({
        message: queuedPrompt,
        queueMode: "followup",
        sessionKey: "main",
      });
      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("steers a queued follow-up with modified Enter in Enter shortcut mode", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.locator("[data-settings-send-shortcut]").selectOption("enter");
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("keep the first shortcut run active");
      await page.getByRole("button", { name: "Send message" }).click();
      const firstSend = requireRecord((await gateway.waitForRequest("chat.send")).params);
      const firstRunId = requireString(firstSend.idempotencyKey, "first active run id");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const steerText = "steer this keyboard follow-up now";
      await composer.fill(steerText);
      const enterQueueButton = page.getByRole("button", { name: "Queue message" });
      const enterTooltip = await enterQueueButton
        .locator("..")
        .evaluate((element) => (element as HTMLElement & { content?: string }).content);
      expect(enterTooltip).toBe("Queue ⏎ · Steer ⌘/Ctrl+Enter");
      if (artifactDir) {
        await enterQueueButton.hover();
        await expect
          .poll(() =>
            enterQueueButton.evaluate((button) => {
              const tooltip = button
                .closest("openclaw-tooltip")
                ?.shadowRoot?.querySelector("wa-tooltip");
              return (tooltip as (HTMLElement & { open?: boolean }) | null)?.open === true;
            }),
          )
          .toBe(true);
        await page.screenshot({
          path: `${artifactDir}/queue-steer-shortcut.png`,
          fullPage: true,
        });
      }
      await composer.press("Control+Enter");

      const firstRunSends = await waitForRequests(gateway, "chat.send", 2);
      const steerParams = requireRecord(firstRunSends[1]?.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        expectedRunId: firstRunId,
        message: steerText,
        queueMode: "steer",
        sessionKey: "main",
      });
      const steeredRow = page.locator(".chat-queue__item--steered", { hasText: steerText });
      await steeredRow.waitFor({ timeout: 10_000 });
      await gateway.emitGatewayEvent("chat", {
        runId: requireString(steerParams.idempotencyKey, "steer send id"),
        sessionKey: "main",
        state: "final",
      });
      await steeredRow.waitFor({ state: "detached", timeout: 10_000 });

      await gateway.emitChatFinal({ runId: firstRunId, text: "First shortcut run finished." });
      await page
        .getByRole("button", { name: "Stop generating" })
        .waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps modified Enter queued in modifier-enter shortcut mode", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.locator("[data-settings-send-shortcut]").selectOption("modifier-enter");
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("keep the modifier shortcut run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedText = "leave this modifier follow-up queued";
      await composer.fill(queuedText);
      const queueButton = page.getByRole("button", { name: "Queue message" });
      const tooltip = await queueButton
        .locator("..")
        .evaluate((element) => (element as HTMLElement & { content?: string }).content);
      expect(tooltip).toBe("Queue");
      await composer.press("Control+Enter");

      const queuedRow = page.locator(".chat-queue__item", { hasText: queuedText });
      await queuedRow.waitFor({ timeout: 10_000 });
      await queuedRow.getByText("Waiting for current run").waitFor({ timeout: 10_000 });
      await expectRequestCountStable(gateway, "chat.send", 1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("honors a session interrupt override ahead of the webchat config default", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "main";
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "steer" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-session-override-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
        "sessions.list": chatSessionListResponse([
          {
            effectiveQueueMode: "interrupt",
            key: "agent:main:main",
            kind: "direct",
            label: "Main",
            queueMode: "interrupt",
            updatedAt: Date.now(),
          },
        ]),
      },
      sessionInfo: {
        effectiveQueueMode: "interrupt",
        hasActiveRun: false,
        key: "agent:main:main",
        queueMode: "interrupt",
        status: "done",
      },
      sessionKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const followUp = "interrupt for this session override";
      await page.locator(".agent-chat__composer-combobox textarea").fill(followUp);
      await page.getByRole("button", { name: "Send message" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({
        message: followUp,
        queueMode: "interrupt",
        sessionKey,
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("dismisses an informational steer notice when the steer request lands", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(`${suite.server.baseUrl}chat?session=main`);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      const activeRequest = await gateway.waitForRequest("chat.send");
      const activeRunId = requireString(
        requireRecord(activeRequest.params).idempotencyKey,
        "active run idempotency key",
      );
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const steerText = "route this into the active run";
      await page.locator(".agent-chat__composer-combobox textarea").fill(steerText);
      await page.getByRole("button", { name: "Queue message" }).click();
      const queue = page.locator(".chat-queue");
      await queue.getByText(steerText).waitFor({ timeout: 10_000 });
      await queue.getByRole("button", { name: "Steer" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const steerParams = requireRecord(sends[1]?.params);
      expect(steerParams).toMatchObject({
        expectedRunId: activeRunId,
        message: steerText,
        queueMode: "steer",
      });
      const steerRunId = requireString(steerParams.idempotencyKey, "steer idempotency key");
      const row = queue.locator(".chat-queue__item--steered", { hasText: steerText });
      await row.waitFor({ timeout: 10_000 });
      const pendingPresentation = await row.evaluate((element) => {
        const badge = element.querySelector<HTMLElement>(".chat-queue__badge--steered");
        const icon = element.querySelector(".chat-queue__icon");
        const probe = document.createElement("span");
        probe.style.color = "var(--info)";
        probe.style.background = "var(--info-subtle)";
        document.body.append(probe);
        const probeStyle = getComputedStyle(probe);
        const infoColor = probeStyle.color;
        const infoSubtle = probeStyle.backgroundColor;
        probe.remove();
        return {
          badgeColor: badge ? getComputedStyle(badge).color : "",
          backgroundColor: getComputedStyle(element).backgroundColor,
          iconPoints: icon?.querySelector("polyline")?.getAttribute("points") ?? "",
          infoColor,
          infoSubtle,
        };
      });
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/steer-pending.png`, fullPage: true });
      }

      await gateway.emitGatewayEvent("chat", {
        runId: steerRunId,
        sessionKey: "main",
        state: "final",
      });
      await page.waitForTimeout(250);
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/steer-landed.png`, fullPage: true });
      }

      expect(pendingPresentation).toMatchObject({
        badgeColor: pendingPresentation.infoColor,
        backgroundColor: pendingPresentation.infoSubtle,
        iconPoints: "15 10 20 15 15 20",
      });
      expect(await row.count()).toBe(0);
      await page.getByText(steerText, { exact: true }).waitFor({ timeout: 10_000 });
      await expect
        .poll(() =>
          page.locator(".chat-thread-inner").evaluate(
            (thread, texts) => {
              const bubbles = Array.from(thread.querySelectorAll(".chat-bubble"));
              return texts.map((text) =>
                bubbles.findIndex((bubble) => bubble.textContent?.includes(text)),
              );
            },
            ["keep this run active", steerText],
          ),
        )
        .toEqual([0, 1]);
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("steers a restored queued message when only the session row reports the active run", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(`${suite.server.baseUrl}chat?session=main`);
      await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/chat\/main$/);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedPrompt = "steer this after restoring the queue";
      await page.locator(".agent-chat__composer-combobox textarea").fill(queuedPrompt);
      await page.getByRole("button", { name: "Queue message" }).click();
      await page.locator(".chat-queue").getByText(queuedPrompt).waitFor({ timeout: 10_000 });

      await gateway.setMethodResponse(
        "sessions.list",
        chatSessionListResponse([
          {
            activeLeafEntryId: "leaf-active",
            activeRunIds: ["active-run"],
            hasActiveRun: true,
            key: "global",
            kind: "global",
            label: "Global",
            updatedAt: Date.now(),
          },
          {
            activeLeafEntryId: "leaf-active",
            activeRunIds: ["active-run"],
            hasActiveRun: true,
            key: "main",
            kind: "direct",
            label: "Main",
            updatedAt: Date.now(),
          },
        ]),
      );
      await page.reload();
      await gateway.waitForRequest("sessions.list");

      const queue = page.locator(".chat-queue");
      await queue.getByText(queuedPrompt).waitFor({ timeout: 10_000 });
      await queue.getByRole("button", { name: "Steer" }).click();

      const steerRequest = await gateway.waitForRequest("chat.send");
      const steerParams = requireRecord(steerRequest.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        expectedLeafEntryId: "leaf-active",
        expectedRunId: "active-run",
        message: queuedPrompt,
        queueMode: "steer",
        sessionKey: "main",
      });
      await queue.locator(".chat-queue__badge--steered", { hasText: "Steering" }).waitFor({
        timeout: 10_000,
      });
      await gateway.emitChatFinal({
        runId: requireString(steerParams.idempotencyKey, "restored steer idempotency key"),
        text: "Restored steer completed.",
      });
      await queue.getByText(queuedPrompt).waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
