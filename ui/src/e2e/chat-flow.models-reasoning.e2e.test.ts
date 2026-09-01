import { expect, it } from "vitest";
import { t } from "../i18n/lib/translate.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("patches a selectable Claude CLI context window", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:session-a";
    const contextWindows = [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ];
    const session = {
      key: sessionKey,
      kind: "direct",
      label: "Session A",
      model: "claude-fable-5",
      modelProvider: "claude-cli",
      contextWindow: "1m",
      contextWindowDefault: "1m",
      contextWindows,
      updatedAt: 2,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      models: [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "claude-cli",
          contextWindow: 1_000_000,
          contextWindowDefault: "1m",
          contextWindows,
        },
      ],
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const picker = pane.locator(".chat-controls__model-picker");
      await picker.locator('[data-chat-model-select="true"]').click();
      const toggle = picker.locator("[data-chat-context-window-toggle]");
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");
      await gateway.deferNext("sessions.patch");
      const patchCount = (await gateway.getRequests("sessions.patch")).length;
      await toggle.click();
      const patch = await gateway.waitForRequest("sessions.patch", { after: patchCount });
      expect(requireRecord(patch.params)).toMatchObject({
        key: sessionKey,
        contextWindow: "200k",
      });
      await gateway.setMethodResponse(
        "sessions.list",
        chatSessionListResponse([{ ...session, contextWindow: "200k" }]),
      );
      await gateway.resolveDeferred("sessions.patch");
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await expect
        .poll(async () =>
          (await picker.locator("[data-chat-model-context-badge]").textContent())?.trim(),
        )
        .toBe("200K");
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("settles permission patches before reflecting changes and observes remote updates", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:session-a",
      kind: "direct",
      label: "Session A",
      permissionMode: "guarded",
      sessionRoot: "/workspace/projects/openclaw",
      updatedAt: 2,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      sessionKey: session.key,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const trigger = pane.locator('[data-chat-permission-select="true"]');
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      expect(await trigger.getAttribute("data-chat-select-value")).toBe("guarded");
      expect(
        await trigger.evaluate((element) => element.closest(".agent-chat__composer-meta") != null),
      ).toBe(true);
      expect(
        await trigger.evaluate(
          (element) => element.closest(".chat-composer-model-control") != null,
        ),
      ).toBe(false);

      const firstListCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.deferNext("sessions.list");
      await trigger.click();
      const firstOption = pane.locator('[data-chat-permission-option="default"]');
      await firstOption.waitFor({ state: "visible" });
      const [triggerBox, firstOptionBox] = await Promise.all([
        trigger.boundingBox(),
        firstOption.boundingBox(),
      ]);
      expect(triggerBox).not.toBeNull();
      expect(firstOptionBox).not.toBeNull();
      if (!triggerBox || !firstOptionBox) {
        throw new Error("expected permission picker geometry");
      }
      expect(firstOptionBox.y + firstOptionBox.height).toBeLessThanOrEqual(triggerBox.y - 1);
      expect(firstOptionBox.x).toBeGreaterThanOrEqual(triggerBox.x);
      expect(firstOptionBox.x - triggerBox.x).toBeLessThanOrEqual(32);
      await pane.locator('[data-chat-permission-option="workspace"]').click();
      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        key: session.key,
        permissionMode: "workspace",
      });
      await waitForRequests(gateway, "sessions.list", firstListCount + 1);
      expect(await trigger.getAttribute("data-chat-select-value")).toBe("guarded");

      await gateway.emitGatewayEvent("sessions.changed", {
        ...session,
        permissionMode: "workspace",
        reason: "patch",
        sessionKey: session.key,
        updatedAt: 3,
      });
      // The initiating picker owns the previous display until its canonical
      // patch refresh settles, even when a session event arrives first.
      expect(await trigger.getAttribute("data-chat-select-value")).toBe("guarded");
      expect(await trigger.textContent()).toContain("Applying permissions");
      expect(await trigger.isEnabled()).toBe(false);
      await gateway.resolveDeferred(
        "sessions.list",
        chatSessionListResponse([{ ...session, permissionMode: "workspace", updatedAt: 3 }]),
      );
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("workspace");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await trigger.textContent()).toContain("Workspace");

      const secondListCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.deferNext("sessions.list");
      await trigger.click();
      await pane.locator('[data-chat-permission-option="default"]').click();
      const patchRequests = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patchRequests[1]?.params)).toMatchObject({
        key: session.key,
        permissionMode: null,
      });
      await waitForRequests(gateway, "sessions.list", secondListCount + 1);
      expect(await trigger.getAttribute("data-chat-select-value")).toBe("workspace");

      await gateway.emitGatewayEvent("sessions.changed", {
        ...session,
        permissionMode: null,
        reason: "patch",
        sessionKey: session.key,
        updatedAt: 4,
      });
      expect(await trigger.getAttribute("data-chat-select-value")).toBe("workspace");
      expect(await trigger.isEnabled()).toBe(false);
      await gateway.resolveDeferred(
        "sessions.list",
        chatSessionListResponse([{ ...session, permissionMode: undefined, updatedAt: 4 }]),
      );
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await trigger.textContent()).toContain("Default");

      const remoteChange = {
        ...session,
        permissionMode: "read-only",
        reason: "patch",
        sessionKey: session.key,
      };
      await gateway.emitGatewayEvent("sessions.changed", {
        ...remoteChange,
        permissionModePending: true,
        updatedAt: 5,
      });
      await expect.poll(() => trigger.textContent()).toContain("Applying permissions");
      expect(await trigger.isEnabled()).toBe(false);
      await gateway.emitGatewayEvent("sessions.changed", {
        ...remoteChange,
        permissionModePending: false,
        updatedAt: 6,
      });
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("read-only");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await trigger.textContent()).toContain(
        t("chat.permissionControls.modes.read-only.label"),
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps picker menus in the viewport while preferring the space above", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: Array.from({ length: 12 }, (_, index) => ({
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
        provider: "openai",
      })),
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const control = page.locator(".chat-composer-model-control");
      for (const picker of [
        {
          menu: ".chat-controls__model-menu",
          trigger: '[data-chat-model-select="true"]',
        },
        {
          menu: ".chat-controls__effort-menu",
          trigger: '[data-chat-thinking-select="true"]',
        },
      ]) {
        await page.setViewportSize({ height: 900, width: 1280 });
        await control.evaluate((element) => {
          Object.assign((element as HTMLElement).style, {
            position: "fixed",
            right: "80px",
            top: "640px",
          });
        });
        const trigger = control.locator(picker.trigger);
        const menu = control.locator(picker.menu);
        await trigger.click();
        await expect
          .poll(async () => {
            const [menuBox, triggerBox] = await Promise.all([
              menu.boundingBox(),
              trigger.boundingBox(),
            ]);
            return {
              aboveTrigger:
                menuBox !== null &&
                triggerBox !== null &&
                menuBox.y + menuBox.height <= triggerBox.y - 5,
              withinViewport:
                menuBox !== null && menuBox.y >= 8 && menuBox.y + menuBox.height <= 892,
            };
          })
          .toEqual({ aboveTrigger: true, withinViewport: true });

        await page.setViewportSize({ height: 320, width: 1280 });
        await control.evaluate((element) => {
          (element as HTMLElement).style.top = "24px";
        });
        await expect
          .poll(async () => {
            const [menuBox, triggerBox] = await Promise.all([
              menu.boundingBox(),
              trigger.boundingBox(),
            ]);
            return {
              belowTrigger:
                menuBox !== null &&
                triggerBox !== null &&
                menuBox.y >= triggerBox.y + triggerBox.height + 5,
              withinViewport:
                menuBox !== null && menuBox.y >= 8 && menuBox.y + menuBox.height <= 312,
            };
          })
          .toEqual({ belowTrigger: true, withinViewport: true });
        await trigger.click();
        await expect.poll(() => menu.isVisible()).toBe(false);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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

  it("keeps high-velocity model scrolling inside the picker", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ...Array.from({ length: 32 }, (_value, index) => ({
        id: `scroll-model-${index + 1}`,
        name: `Scroll Model ${index + 1}`,
        provider: "openai",
      })),
    ];
    await installMockGateway(page, {
      models,
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const main = page.getByRole("main");
      await main.locator(".chat-composer-model-control").evaluate((element) => {
        Object.assign((element as HTMLElement).style, {
          position: "fixed",
          right: "80px",
          top: "640px",
        });
      });
      await page.evaluate(() => {
        document.documentElement.style.overflowY = "auto";
        document.body.style.height = "1800px";
        window.scrollTo(0, 300);
      });
      expect(await page.evaluate(() => window.scrollY)).toBe(300);

      await main.locator('[data-chat-model-select="true"]').click();
      const modelScroller = main.locator(".chat-controls__model-options");
      await expect.poll(() => modelScroller.isVisible()).toBe(true);
      await modelScroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await modelScroller.hover();
      expect(await page.evaluate(() => window.scrollY)).toBe(300);
      await page.mouse.wheel(0, -5_000);
      await page.waitForTimeout(100);

      expect(await page.evaluate(() => window.scrollY)).toBe(300);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps long model names and metadata inside the picker grid", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      models: [
        {
          contextWindow: 1_000_000,
          id: "long-model",
          name: "Long model",
          provider: "openai",
        },
      ],
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      const menu = main.locator(".chat-controls__model-menu");
      await expect.poll(() => menu.isVisible()).toBe(true);
      await menu
        .locator(".chat-controls__model-option-name")
        .first()
        .evaluate((node) => {
          node.textContent =
            "A deliberately very long model name that must ellipsize inside the provider grid";
        });
      await menu
        .locator(".chat-controls__model-option-meta")
        .first()
        .evaluate((node) => {
          node.textContent =
            "deliberately-long-context-metadata-that-must-never-create-horizontal-scroll";
        });

      const overflow = await menu.evaluate((root) => {
        const selectors = [
          ".chat-controls__model-option-copy",
          ".chat-controls__model-option",
          ".chat-controls__provider-model-group",
          ".chat-controls__model-options",
        ];
        const containers = selectors.map((selector) => {
          const element = root.querySelector<HTMLElement>(selector);
          return {
            clientWidth: element?.clientWidth ?? -1,
            overflow: Math.max(0, (element?.scrollWidth ?? 0) - (element?.clientWidth ?? 0)),
            scrollWidth: element?.scrollWidth ?? -1,
            selector,
          };
        });
        const rootElement = root as HTMLElement;
        containers.push({
          clientWidth: rootElement.clientWidth,
          overflow: Math.max(0, rootElement.scrollWidth - rootElement.clientWidth),
          scrollWidth: rootElement.scrollWidth,
          selector: ".chat-controls__model-menu",
        });
        const leafStyles = [
          ".chat-controls__model-option-name",
          ".chat-controls__model-option-meta",
        ].map((selector) => {
          const element = root.querySelector<HTMLElement>(selector)!;
          const style = getComputedStyle(element);
          return { overflowX: style.overflowX, selector, textOverflow: style.textOverflow };
        });
        return { containers, leafStyles };
      });
      expect(
        overflow.containers.filter((entry) => entry.overflow > 1),
        JSON.stringify(overflow),
      ).toEqual([]);
      expect(overflow.leafStyles).toEqual([
        {
          overflowX: "hidden",
          selector: ".chat-controls__model-option-name",
          textOverflow: "ellipsis",
        },
        {
          overflowX: "hidden",
          selector: ".chat-controls__model-option-meta",
          textOverflow: "ellipsis",
        },
      ]);

      const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactDirParent
        ? createControlUiE2eArtifactDir("chat-flow.models-reasoning", artifactDirParent)
        : undefined;
      if (artifactDir) {
        await menu.screenshot({
          animations: "disabled",
          path: `${artifactDir}/model-picker-long-content.png`,
        });
      }
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
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));

      const main = page.getByRole("main");
      const openModelSelect = async () => {
        const trigger = main.locator(
          'openclaw-chat-pane[aria-hidden="false"] [data-chat-model-select="true"]',
        );
        await trigger.waitFor({ state: "visible", timeout: 10_000 });
        return trigger;
      };
      const selectModel = async (value: string) => {
        const activePane = main.locator('openclaw-chat-pane[aria-hidden="false"]');
        await activePane.locator('[data-chat-model-select="true"]').click();
        const option = activePane.locator(`[data-chat-model-option="${value}"]`);
        await option.waitFor({ state: "visible", timeout: 10_000 });
        await option.click();
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
          sessionId: "session:agent:ops:session-a",
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
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:ops:session-a"));
      const main = page.getByRole("main");
      const modelSelect = main.locator('[data-chat-model-select="true"]').first();
      await modelSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await modelSelect.textContent()).toContain("Claude Opus 4.5");
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await modelSelect.click();
      await main.locator('[data-chat-model-option="openai/gpt-5.5"]').click();
      const firstPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(firstPatch.params)).toMatchObject({
        key: "agent:ops:session-a",
        model: "openai/gpt-5.5",
      });
      expect(await modelSelect.textContent()).toContain("GPT-5.5");

      // Model selection closes immediately. Reopen and select the real default
      // catalog row to clear the session override.
      await modelSelect.click();
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

  it("shows one canonical default model with matching inherited reasoning", async () => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.models-reasoning", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
      (id) => ({ id, label: id }),
    );
    const agentsList = {
      agents: [
        {
          id: "main",
          model: { primary: "openai/gpt-5.6-sol" },
          name: "Main",
          thinkingDefault: "medium",
          thinkingLevels,
          thinkingOptions: thinkingLevels.map((level) => level.label),
        },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };
    const sessionsList = {
      count: 2,
      defaults: {
        contextTokens: null,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        thinkingDefault: "medium",
        thinkingLevels,
        thinkingOptions: thinkingLevels.map((level) => level.label),
      },
      path: "",
      sessions: [
        {
          key: "agent:main:session-default",
          sessionId: "control-ui-profile-default-proof",
          kind: "direct",
          label: "Default Sol",
          updatedAt: 2,
        },
        {
          key: "agent:main:session-explicit",
          kind: "direct",
          label: "Explicit Sol",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          updatedAt: 1,
        },
      ],
      ts: Date.now(),
    };
    const models = [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ];
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models },
          sessionId: "control-ui-profile-default-proof",
          thinkingLevel: null,
        },
        "sessions.list": sessionsList,
      },
      models,
      sessionKey: "agent:main:session-default",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-default"));
      const main = page.getByRole("main");
      const activePane = main.locator('openclaw-chat-pane[aria-hidden="false"]');
      const modelSelect = activePane.locator('[data-chat-model-select="true"]');
      const effortSelect = activePane.locator('[data-chat-thinking-select="true"]');
      const thinkingSlider = activePane.locator('[data-chat-thinking-slider="true"]');
      const expectedThinkingValues = thinkingLevels.map((level) => level.id).join(",");

      await modelSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await modelSelect.textContent()).toContain("GPT-5.6 Sol");
      expect(await modelSelect.textContent()).not.toContain("@openai:");
      await modelSelect.click();
      await expect
        .poll(() => activePane.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').count())
        .toBe(1);
      expect(
        (await main.locator("[data-chat-model-option]").allTextContents()).join(" "),
      ).not.toContain("@openai:");
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe(expectedThinkingValues);
      const defaultThinkingValue = await effortSelect.getAttribute("data-chat-thinking-value");
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/default-sol.png`, fullPage: true });
      }

      await page.keyboard.press("Escape");
      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-explicit"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Explicit Sol").waitFor({
        timeout: 10_000,
      });
      await modelSelect.click();
      await expect
        .poll(() => activePane.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').count())
        .toBe(1);
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe(expectedThinkingValues);
      expect(await effortSelect.getAttribute("data-chat-thinking-value")).toBe(
        defaultThinkingValue,
      );
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/explicit-sol.png`, fullPage: true });
      }

      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("does not reuse catalog reasoning for a different session runtime", async () => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.runtime-reasoning", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:codex-luna";
    await installMockGateway(page, {
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          reasoning: true,
          agentRuntime: { id: "openclaw", source: "model" },
          thinkingLevels: ["max", "ultra"].map((id) => ({ id, label: id })),
          thinkingDefault: "ultra",
        },
      ],
      sessionKey,
      sessions: [
        {
          key: sessionKey,
          kind: "direct",
          label: "Codex Luna",
          model: "gpt-5.6-luna",
          modelProvider: "openai",
          agentRuntime: { id: "codex", source: "session-key" },
          updatedAt: 1,
        },
      ],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const effortSelect = pane.locator('[data-chat-thinking-select="true"]');
      await effortSelect.click();
      const thinkingSlider = pane.locator('[data-chat-thinking-slider="true"]');
      await thinkingSlider.waitFor({ state: "visible" });
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/codex-luna-reasoning.png`, fullPage: true });
      }

      expect(await thinkingSlider.getAttribute("data-chat-thinking-values")).not.toContain("ultra");
      expect(await effortSelect.getAttribute("data-chat-thinking-value")).not.toBe("ultra");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    {
      label: "model override",
      trigger: '[data-chat-model-select="true"]',
      option: '[data-chat-model-option="bedrock/claude-opus-4.5"]',
      patch: { model: "bedrock/claude-opus-4.5" },
    },
    {
      label: "Full Access permission",
      trigger: '[data-chat-permission-select="true"]',
      option: '[data-chat-permission-option="full"]',
      patch: { permissionMode: "full" },
    },
  ])("shows a pending send while a $label update is still pending", async (setting) => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: "agent:main:session-a",
            kind: "direct",
            label: "Session A",
            permissionMode: "workspace",
            updatedAt: 2,
          },
        ]),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));

      const main = page.getByRole("main");
      await main.locator(setting.trigger).click();
      await main.locator(setting.option).click();
      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        key: "agent:main:session-a",
        ...setting.patch,
      });

      const prompt = `send while the ${setting.label} save is pending`;
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

  it("previews reasoning and provider choices before committing them", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:session-a";
    const session = {
      key: sessionKey,
      kind: "direct",
      label: "Session A",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      thinkingDefault: "high",
      thinkingLevel: "high",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "ultra", label: "ultra" },
      ],
      updatedAt: 2,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
      ],
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

      const main = page.getByRole("main");
      const modelPicker = main.locator('[data-chat-model-select="true"]').first();
      const effortPicker = main.locator('[data-chat-thinking-select="true"]').first();
      await effortPicker.click();
      const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
      const visibleReasoning = main.locator(
        "[data-chat-thinking-preview-committed]:not([hidden]), " +
          "[data-chat-thinking-preview-index]:not([hidden])",
      );

      for (const value of ["low", "medium", "ultra"]) {
        await thinkingSlider.evaluate((input, nextValue) => {
          const slider = input as HTMLInputElement;
          const values = (slider.dataset.chatThinkingValues ?? "").split(",");
          slider.value = String(values.indexOf(nextValue));
          slider.dispatchEvent(new Event("input", { bubbles: true }));
        }, value);
        await expect
          .poll(() => visibleReasoning.evaluate((element) => element.textContent?.trim()))
          .toBe(value.charAt(0).toUpperCase() + value.slice(1));
      }
      await expectRequestCountStable(gateway, "sessions.patch", 0);

      await gateway.setMethodResponse(
        "sessions.list",
        chatSessionListResponse([{ ...session, thinkingLevel: "ultra" }]),
      );
      await thinkingSlider.evaluate((input) => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const thinkingPatch = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(thinkingPatch.params)).toMatchObject({
        key: sessionKey,
        thinkingLevel: "ultra",
      });
      await expect.poll(() => effortPicker.getAttribute("data-chat-thinking-value")).toBe("ultra");
      await expect.poll(() => effortPicker.textContent()).toContain("Ultra");
      await page.keyboard.press("Escape");

      await modelPicker.click();
      const search = main.locator('[data-chat-model-search="true"]');
      await expect
        .poll(() => search.evaluate((element) => element === document.activeElement))
        .toBe(false);
      await search.focus();
      await search.fill("anthropic");
      const anthropicModel = main.locator('[data-chat-model-option="anthropic/claude-fable-5"]');
      await expect.poll(() => anthropicModel.isVisible()).toBe(true);
      await expect
        .poll(() =>
          main.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').getAttribute("hidden"),
        )
        .toBe("");
      await expectRequestCountStable(gateway, "sessions.patch", 1);
      await search.press("Enter");
      const patches = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patches[1]?.params)).toMatchObject({
        key: sessionKey,
        model: "anthropic/claude-fable-5",
      });
      await expect
        .poll(() => main.locator(".chat-controls__model-picker").getAttribute("open"))
        .toBe(null);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
