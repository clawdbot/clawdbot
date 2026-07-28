import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("routes runtime-aware model commands through the server directive path", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const command = "/model openai/gpt-5.6-luna --runtime codex continue with the selected model";
      await page.locator(".agent-chat__composer-combobox textarea").fill(command);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params)).toMatchObject({
        message: command,
        sessionKey: "agent:main:main",
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps a session model override selected after switching away and back", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const main = page.getByRole("main");
      const openModelSelect = async () => {
        const trigger = main.locator('[data-chat-model-select="true"]').first();
        await trigger.waitFor({ state: "visible", timeout: 10_000 });
        return trigger;
      };
      const selectModel = async (value: string) => {
        await main.locator('[data-chat-model-select="true"]').click();
        const provider = value.split("/", 1)[0];
        await main.locator(`[data-chat-model-provider="${provider}"]`).click();
        const option = main.locator(`[data-chat-model-option="${value}"]`);
        await option.waitFor({ state: "visible", timeout: 10_000 });
        await option.click();
        await page.keyboard.press("Escape");
      };

      let modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await selectModel("bedrock/claude-opus-4.5");
      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        key: "agent:main:session-a",
        model: "bedrock/claude-opus-4.5",
      });
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
        "bedrock/claude-opus-4.5",
      );

      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session B").waitFor({
        timeout: 10_000,
      });
      modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-a"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session A").waitFor({
        timeout: 10_000,
      });

      modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
        "bedrock/claude-opus-4.5",
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("restores the selected agent model after clearing a session override", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const agentsList = {
      agents: [
        {
          id: "ops",
          model: { primary: "anthropic/claude-opus-4-5" },
          name: "Operations",
        },
      ],
      defaultId: "ops",
      mainKey: "main",
      scope: "agent",
    };
    const sessionsList = {
      count: 1,
      defaults: {
        contextTokens: null,
        model: "gpt-5.5",
        modelProvider: "openai",
      },
      path: "",
      sessions: [
        {
          key: "agent:ops:session-a",
          kind: "direct",
          label: "Operations",
          updatedAt: Date.now(),
        },
      ],
      ts: Date.now(),
    };
    const gateway = await installMockGateway(page, {
      assistantAgentId: "ops",
      defaultAgentId: "ops",
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: {
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
              {
                id: "claude-opus-4-5",
                name: "Claude Opus 4.5",
                provider: "anthropic",
              },
            ],
          },
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
        "sessions.list": sessionsList,
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
      ],
      sessionKey: "agent:ops:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const main = page.getByRole("main");
      const modelSelect = main.locator('[data-chat-model-select="true"]').first();
      await modelSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await modelSelect.textContent()).toContain("Claude Opus 4.5");
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await modelSelect.click();
      await main.locator('[data-chat-model-provider="openai"]').click();
      await main.locator('[data-chat-model-option="openai/gpt-5.5"]').click();
      const firstPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(firstPatch.params)).toMatchObject({
        key: "agent:ops:session-a",
        model: "openai/gpt-5.5",
      });
      expect(await modelSelect.textContent()).toContain("GPT-5.5");

      // The picker stays open after an immediate apply. Return to the default
      // model's provider and select its real catalog row to clear the override.
      await main.locator('[data-chat-model-provider="anthropic"]').click();
      const defaultModel = main.locator(
        '[data-chat-model-option="anthropic/claude-opus-4-5"][data-chat-model-default="true"]',
      );
      await defaultModel.waitFor({ state: "visible", timeout: 10_000 });
      expect(await defaultModel.textContent()).toContain("Default");
      expect(await main.locator('[data-chat-model-option=""]').count()).toBe(0);
      await defaultModel.click();
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params)).toMatchObject({
        key: "agent:ops:session-a",
        model: null,
      });
      expect(await modelSelect.textContent()).toContain("Claude Opus 4.5");
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows a pending send while a model override update is still pending", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await main.locator('[data-chat-model-provider="bedrock"]').click();
      await main.locator('[data-chat-model-option="bedrock/claude-opus-4.5"]').click();
      await page.keyboard.press("Escape");
      await gateway.waitForRequest("sessions.patch");

      const prompt = "send while the model save is pending";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await page.locator(".chat-queue").getByText("Applying chat settings").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.patch", {});
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params.message).toBe(prompt);
      expect(params.sessionKey).toBe("agent:main:session-a");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("applies provider-specific reasoning after the selected model is saved", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:session-a";
    const fableSession = {
      key: sessionKey,
      kind: "direct",
      label: "Session A",
      model: "claude-fable-5",
      modelProvider: "anthropic",
      thinkingDefault: "high",
      thinkingLevel: "high",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "adaptive", label: "adaptive" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
      ],
      updatedAt: 2,
    };
    const solSession = {
      ...fableSession,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "ultra", label: "ultra" },
      ],
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([fableSession]),
      },
      models: [
        { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
      ],
      sessionKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await main.locator('[data-chat-model-provider="openai"]').click();
      await main.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').click();

      const modelPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(modelPatch.params)).toMatchObject({
        key: sessionKey,
        model: "openai/gpt-5.6-sol",
      });
      const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
      await expect.poll(() => thinkingSlider.isDisabled()).toBe(true);
      await thinkingSlider.evaluate((input) => {
        const slider = input as HTMLInputElement;
        slider.value = slider.max;
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expectRequestCountStable(gateway, "sessions.patch", 1);

      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([solSession]));
      await gateway.resolveDeferred("sessions.patch");
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toContain("ultra");
      await expect.poll(() => thinkingSlider.isEnabled()).toBe(true);

      await thinkingSlider.evaluate((input) => {
        const slider = input as HTMLInputElement;
        const values = (slider.dataset.chatThinkingValues ?? "").split(",");
        slider.value = String(values.indexOf("ultra"));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params)).toMatchObject({
        key: sessionKey,
        thinkingLevel: "ultra",
      });
      await expect.poll(() => page.getByText(/not supported for/u).count()).toBe(0);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/model-thinking-sync.png`,
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps send pending until reasoning and speed patches finish", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          ...chatSessionListResponse([
            {
              effectiveFastMode: false,
              fastMode: false,
              key: "agent:main:session-a",
              kind: "direct",
              label: "Session A",
              model: "gpt-5.5",
              modelProvider: "openai",
              thinkingLevel: "high",
              updatedAt: 2,
            },
          ]),
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
            thinkingDefault: "high",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
          },
        },
      },
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await gateway.deferNext("sessions.patch");
      await main.locator('[data-chat-thinking-slider="true"]').press("ArrowLeft");
      const firstPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(firstPatch.params).thinkingLevel).toBe("medium");

      await gateway.deferNext("sessions.patch");
      await main.locator('[data-chat-speed-toggle="on"]').click();
      await expectRequestCountStable(gateway, "sessions.patch", 1);
      await page.keyboard.press("Escape");

      const prompt = "send with the new reasoning and speed";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.locator(".chat-queue").getByText("Applying chat settings").waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const sessionListCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.resolveDeferred("sessions.patch", {});
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params).fastMode).toBe(true);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(sessionListCount);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.patch", {});
      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params)).toMatchObject({
        message: prompt,
        sessionKey: "agent:main:session-a",
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
