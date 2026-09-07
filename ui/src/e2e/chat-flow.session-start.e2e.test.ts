import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens a git-backed agent draft from the sidebar new-session action", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
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

  it("waits for configured inference before sending the first chat turn", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/startup-model",
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
      sessionScope: "global",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);
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
        sessionId: "session:global",
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
      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText("First token visible.", { exact: true }).waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await transcript.getByText("First token visible.", { exact: true }).waitFor({
        timeout: 10_000,
      });
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
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("paints startup history while canonical roster and metadata requests remain pending", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/hydrated-model",
      deferredMethods: ["agents.list", "chat.metadata"],
      methodResponses: {
        "chat.startup": {
          messages: [
            {
              content: [
                { text: "Transcript paints while optional startup data loads", type: "text" },
              ],
              role: "assistant",
            },
          ],
          sessionId: "session:agent:main:main",
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("chat.metadata");
      await page
        .locator(".chat-thread-inner")
        .getByText("Transcript paints while optional startup data loads", { exact: true })
        .waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);

      await gateway.resolveDeferred("agents.list", {
        agents: [{ id: "main", model: { primary: "openai/hydrated-model" }, name: "OpenClaw" }],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      });
      await gateway.resolveDeferred("chat.metadata", {
        commands: [],
        models: [
          {
            available: true,
            id: "hydrated-model",
            name: "Hydrated Model",
            provider: "openai",
          },
        ],
      });
      await expect
        .poll(() =>
          page.locator("openclaw-chat-pane").evaluate((pane) => {
            const state = (
              pane as HTMLElement & { state?: { chatModelCatalog?: Array<{ id?: string }> } }
            ).state;
            return state?.chatModelCatalog?.map((model) => model.id);
          }),
        )
        .toEqual(["hydrated-model"]);
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
