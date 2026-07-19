// Control UI E2E tests cover the redesigned chat composer.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
// Browser contexts preserve test isolation; keep one process warm for this file.
let browser: Browser;

describeControlUiE2e("Control UI chat composer redesign", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps model and settings in the bottom bar and switches the primary action with input state", async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "Rosita",
      deferredMethods: ["chat.send"],
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        {
          id: "gpt-5.4-pro",
          name: "GPT-5.4 Pro",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          provider: "anthropic",
        },
      ],
      methodResponses: {
        "models.authStatus": {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              status: "ok",
              profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: 200_000,
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
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              displayName: "Main",
              hasActiveRun: false,
              key: "main",
              kind: "direct",
              label: "Main",
              model: "gpt-5.5",
              modelProvider: "openai",
              status: "done",
              totalTokens: 46_000,
              totalTokensFresh: true,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      const composerShell = page.locator(".agent-chat__composer-shell");
      const chatContent = page.locator("main.content--chat");
      const chatMain = page.locator(".chat-workbench__main");
      const model = composer.locator('[data-chat-model-select="true"]');
      const usage = composer.locator('[data-chat-provider-usage="true"]');
      const contextUsage = composer.locator(".context-ring");
      const textarea = composer.locator("textarea");
      const attach = composer.locator(
        'button.agent-chat__input-btn--attach[aria-label="Add attachment"]',
      );
      const camera = composerShell.locator(".agent-chat__camera-btn");
      const takePhoto = composerShell.getByRole("menuitem", { name: "Take photo" });
      const settings = composer.getByRole("button", { name: "View", exact: true });
      const splitView = page.getByRole("button", { name: "Open split view" });
      const voice = page.getByRole("button", { name: "Start voice input" });

      await expect.poll(() => model.isVisible()).toBe(true);
      await expect.poll(() => contextUsage.isVisible()).toBe(true);
      await expect.poll(() => usage.isVisible()).toBe(false);
      await expect.poll(() => settings.isVisible()).toBe(true);
      await expect.poll(() => splitView.isVisible()).toBe(true);
      await expect
        .poll(() => splitView.evaluate((node) => node.closest(".chat-pane__header") != null))
        .toBe(true);
      await expect.poll(() => attach.isVisible()).toBe(true);
      await expect.poll(() => camera.isVisible()).toBe(false);
      await expect.poll(() => voice.isVisible()).toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Start video talk" }).count())
        .toBe(0);
      await expect
        .poll(() =>
          attach.evaluate((node) => node.closest(".agent-chat__composer-input-row") != null),
        )
        .toBe(true);
      await expect
        .poll(() =>
          voice.evaluate((node) => node.closest(".agent-chat__composer-input-row") != null),
        )
        .toBe(true);
      await expect
        .poll(() => model.evaluate((node) => node.closest(".agent-chat__composer-footer") != null))
        .toBe(true);
      // The settings chip must sit centered between the footer divider and
      // the card edge (the old asymmetric footer padding pinned it to the top).
      await expect
        .poll(() =>
          settings.evaluate((element) => {
            const footer = element.closest(".agent-chat__composer-footer")?.getBoundingClientRect();
            const chip = element.getBoundingClientRect();
            if (!footer || !chip) {
              return null;
            }
            return Math.abs(chip.top - footer.top - (footer.bottom - chip.bottom));
          }),
        )
        .toBeLessThanOrEqual(1.5);
      await expect.poll(() => composer.locator(".agent-chat__composer-header").count()).toBe(0);
      await expect
        .poll(() => model.locator(".chat-controls__inline-select-label").textContent())
        .toBe("GPT-5.5 · High");
      await expect.poll(() => contextUsage.locator(".context-ring__detail").count()).toBe(0);
      await expect
        .poll(() => contextUsage.getAttribute("aria-label"))
        .toBe("Thread context usage: 46k of 200k (23%)");
      await expect
        .poll(() =>
          contextUsage.evaluate((node) => node.closest(".agent-chat__composer-meta") != null),
        )
        .toBe(true);
      await contextUsage.click();
      await expect.poll(() => usage.isVisible()).toBe(true);
      await expect
        .poll(async () =>
          (await composer.locator(".context-usage__limit").first().textContent())
            ?.replace(/\s+/g, " ")
            .trim(),
        )
        .toBe("Weekly · all models 72%");
      await contextUsage.click();

      await model.click();
      const thinkingSlider = composer.locator('[data-chat-thinking-slider="true"]');
      const speedToggle = composer.locator("[data-chat-speed-toggle]");
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe("off,low,medium,high");
      await expect.poll(() => thinkingSlider.inputValue()).toBe("3");
      // OpenAI sessions toggle between the standard and priority tiers.
      await expect.poll(async () => (await speedToggle.textContent())?.trim()).toBe("Standard");
      await expect.poll(() => speedToggle.getAttribute("aria-checked")).toBe("false");
      await expect
        .poll(() => composer.locator(".chat-controls__model-option-icon").count())
        .toBe(0);
      await expect
        .poll(() => composer.locator(".chat-controls__provider-icon").count())
        .toBeGreaterThan(0);
      // Reasoning and speed commit immediately; the picker stays open so all
      // three controls can be adjusted together.
      await thinkingSlider.press("Home");
      await thinkingSlider.press("ArrowRight");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.patch")).some(
            (request) =>
              typeof request.params === "object" &&
              request.params !== null &&
              "thinkingLevel" in request.params &&
              request.params.thinkingLevel === "low",
          ),
        )
        .toBe(true);
      await expect.poll(() => model.getAttribute("data-chat-thinking-value")).toBe("low");
      await expect.poll(() => thinkingSlider.inputValue()).toBe("1");
      await speedToggle.click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.patch")).some(
            (request) =>
              typeof request.params === "object" &&
              request.params !== null &&
              "fastMode" in request.params &&
              request.params.fastMode === true,
          ),
        )
        .toBe(true);
      await expect.poll(() => speedToggle.getAttribute("aria-checked")).toBe("true");
      await expect.poll(async () => (await speedToggle.textContent())?.trim()).toBe("Fast");
      await page.keyboard.press("Escape");
      await expect
        .poll(() => composer.locator(".chat-controls__inline-select-menu").isVisible())
        .toBe(false);
      await model.click();
      await expect.poll(() => speedToggle.getAttribute("aria-checked")).toBe("true");
      await expect
        .poll(() => composer.locator('[data-chat-thinking-slider="true"]').count())
        .toBe(1);
      const providerButtons = composer.locator("[data-chat-model-provider]");
      await expect
        .poll(async () => (await providerButtons.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI", "Anthropic"]);
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.4 Pro");
      await providerButtons.filter({ hasText: "Anthropic" }).click();
      const anthropicModels = composer.locator('[data-chat-model-provider-group="anthropic"]');
      await expect.poll(() => anthropicModels.isVisible()).toBe(true);
      await expect.poll(() => anthropicModels.textContent()).toContain("Claude Sonnet 4.6");
      await model.click();

      const [
        chatContentBox,
        chatMainBox,
        composerShellBox,
        composerBox,
        modelBox,
        textareaBox,
        attachBox,
        voiceBox,
      ] = await Promise.all([
        chatContent.boundingBox(),
        chatMain.boundingBox(),
        composerShell.boundingBox(),
        composer.boundingBox(),
        model.boundingBox(),
        textarea.boundingBox(),
        attach.boundingBox(),
        voice.boundingBox(),
      ]);
      expect(chatContentBox).not.toBeNull();
      expect(chatMainBox).not.toBeNull();
      expect(composerShellBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect(textareaBox).not.toBeNull();
      expect(attachBox).not.toBeNull();
      expect(voiceBox).not.toBeNull();
      if (
        !chatContentBox ||
        !chatMainBox ||
        !composerShellBox ||
        !composerBox ||
        !modelBox ||
        !textareaBox ||
        !attachBox ||
        !voiceBox
      ) {
        throw new Error("expected composer controls to have layout boxes");
      }
      expect(Math.abs(chatMainBox.x - chatContentBox.x)).toBeLessThanOrEqual(1);
      expect(composerShellBox.width).toBeGreaterThanOrEqual(767);
      expect(composerShellBox.width).toBeLessThanOrEqual(769);
      expect(
        Math.abs(
          composerShellBox.x + composerShellBox.width / 2 - (chatMainBox.x + chatMainBox.width / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(composerBox.height).toBeLessThanOrEqual(120);
      expect(modelBox.y).toBeGreaterThanOrEqual(textareaBox.y);
      expect(attachBox.x + attachBox.width).toBeLessThanOrEqual(
        composerBox.x + composerBox.width + 1,
      );
      expect(voiceBox.x).toBeGreaterThanOrEqual(attachBox.x + attachBox.width - 1);
      expect(voiceBox.x + voiceBox.width).toBeLessThanOrEqual(
        composerBox.x + composerBox.width + 1,
      );
      await expect
        .poll(() =>
          voice.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return (
              bounds.width === bounds.height &&
              Number.parseFloat(getComputedStyle(node).borderRadius) >= bounds.width / 2
            );
          }),
        )
        .toBe(true);

      await page.setViewportSize({ width: 1280, height: 900 });
      const [compactChatMainBox, compactComposerShellBox] = await Promise.all([
        chatMain.boundingBox(),
        composerShell.boundingBox(),
      ]);
      expect(compactChatMainBox).not.toBeNull();
      expect(compactComposerShellBox).not.toBeNull();
      if (!compactChatMainBox || !compactComposerShellBox) {
        throw new Error("expected compact composer layout boxes");
      }
      expect(compactComposerShellBox.width).toBeGreaterThanOrEqual(767);
      expect(compactComposerShellBox.width).toBeLessThanOrEqual(769);
      expect(
        Math.abs(
          compactComposerShellBox.x +
            compactComposerShellBox.width / 2 -
            (compactChatMainBox.x + compactChatMainBox.width / 2),
        ),
      ).toBeLessThanOrEqual(1);

      await settings.click();
      const viewMenu = page.getByRole("menu", { name: "View" });
      const viewDropdown = composer.locator("wa-dropdown.chat-view-menu");
      await expect.poll(() => viewMenu.isVisible()).toBe(true);
      await expect
        .poll(() => viewDropdown.locator(".chat-view-menu__text").allTextContents())
        .toEqual(["Reasoning", "Tool calls", "Keep commentary"]);
      const reasoning = viewDropdown.getByRole("menuitemcheckbox", { name: "Reasoning" });
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("true");
      await reasoning.click();
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("false");
      await reasoning.click();
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("true");
      await settings.click();
      await expect.poll(() => viewMenu.isVisible()).toBe(false);

      await textarea.fill("Send this message");
      await expect
        .poll(() => page.getByRole("button", { name: "Send message" }).isVisible())
        .toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).count())
        .toBe(0);

      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId =
        typeof sendRequest.params === "object" &&
        sendRequest.params !== null &&
        "idempotencyKey" in sendRequest.params
          ? String(sendRequest.params.idempotencyKey)
          : "";
      // Pre-first-token: the thread shows the working spark; the composer
      // renders no visible run status (sr-only announcement only).
      const spark = page.locator(".chat-reading-indicator");
      await expect.poll(() => spark.isVisible()).toBe(true);
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await expect.poll(() => spark.isVisible()).toBe(true);
      const announcement = composer.locator(".agent-chat__run-status-announcement");
      await expect.poll(() => announcement.textContent()).toContain("Rosita is");
      await expect.poll(() => composer.locator(".agent-chat__composer-run-status").count()).toBe(0);
      await gateway.emitGatewayEvent("chat", {
        deltaText: "Working on it.",
        message: {
          content: [{ text: "Working on it.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      // Streaming content replaces the spark as the working signal.
      await expect.poll(() => page.getByText("Working on it.").first().isVisible()).toBe(true);
      await expect.poll(() => spark.count()).toBe(0);
      await expect.poll(() => announcement.textContent()).toContain("Rosita is responding");
      const [activeSettingsBox, activeSplitViewBox, activeModelBox, activeChatContentBox] =
        await Promise.all([
          settings.boundingBox(),
          splitView.boundingBox(),
          model.boundingBox(),
          chatContent.boundingBox(),
        ]);
      expect(activeSettingsBox).not.toBeNull();
      expect(activeSplitViewBox).not.toBeNull();
      expect(activeModelBox).not.toBeNull();
      expect(activeChatContentBox).not.toBeNull();
      if (!activeSettingsBox || !activeSplitViewBox || !activeModelBox || !activeChatContentBox) {
        throw new Error("expected chat content and composer controls to have layout boxes");
      }
      expect(activeModelBox.x).toBeGreaterThanOrEqual(
        activeSettingsBox.x + activeSettingsBox.width - 1,
      );
      // The opener lives in the always-on pane header at the chat area's top edge.
      const headerBox = await page.locator(".chat-pane__header").boundingBox();
      expect(headerBox).not.toBeNull();
      if (!headerBox) {
        throw new Error("expected the pane header to have a layout box");
      }
      expect(
        Math.abs(
          activeChatContentBox.x + activeChatContentBox.width - (headerBox.x + headerBox.width),
        ),
      ).toBeLessThanOrEqual(24);
      expect(Math.abs(activeSplitViewBox.y - activeChatContentBox.y)).toBeLessThanOrEqual(24);
      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stop.isVisible()).toBe(true);
      await stop.click();
      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({
        runId,
        sessionKey: "main",
      });
      await expect.poll(() => stop.count()).toBe(0);

      await textarea.fill("");
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).isVisible())
        .toBe(true);
      await expect.poll(() => page.getByRole("button", { name: "Send message" }).count()).toBe(0);

      await page.setViewportSize({ width: 393, height: 852 });
      await expect.poll(() => camera.count()).toBe(0);
      const [mobileAttachBox, mobileModelBox, mobileSettingsBox, mobileContextBox, mobileVoiceBox] =
        await Promise.all([
          attach.boundingBox(),
          model.boundingBox(),
          settings.boundingBox(),
          contextUsage.boundingBox(),
          voice.boundingBox(),
        ]);
      expect(mobileAttachBox).not.toBeNull();
      expect(mobileModelBox).not.toBeNull();
      expect(mobileSettingsBox).not.toBeNull();
      expect(mobileContextBox).not.toBeNull();
      expect(mobileVoiceBox).not.toBeNull();
      if (
        !mobileAttachBox ||
        !mobileModelBox ||
        !mobileSettingsBox ||
        !mobileContextBox ||
        !mobileVoiceBox
      ) {
        throw new Error("expected mobile composer controls to have layout boxes");
      }
      for (const control of [mobileModelBox, mobileSettingsBox, mobileContextBox]) {
        expect(
          Math.abs(
            control.y + control.height / 2 - (mobileSettingsBox.y + mobileSettingsBox.height / 2),
          ),
        ).toBeLessThanOrEqual(2);
      }
      expect(mobileModelBox.x).toBeGreaterThanOrEqual(
        mobileSettingsBox.x + mobileSettingsBox.width - 1,
      );
      expect(mobileAttachBox.x + mobileAttachBox.width).toBeLessThanOrEqual(mobileVoiceBox.x + 1);
      await expect
        .poll(async () => {
          const [polledAttachBox, polledVoiceBox] = await Promise.all([
            attach.boundingBox(),
            voice.boundingBox(),
          ]);
          if (!polledAttachBox || !polledVoiceBox) {
            return Number.POSITIVE_INFINITY;
          }
          return Math.abs(
            polledAttachBox.y +
              polledAttachBox.height / 2 -
              (polledVoiceBox.y + polledVoiceBox.height / 2),
          );
        })
        .toBeLessThanOrEqual(2);
      await attach.click();
      await expect.poll(() => takePhoto.isVisible()).toBe(true);
      await expect
        .poll(() => composerShell.getByRole("menuitem", { name: "Photo", exact: true }).isVisible())
        .toBe(true);
      await expect
        .poll(() => composerShell.getByRole("menuitem", { name: "File", exact: true }).isVisible())
        .toBe(true);
      await page.keyboard.press("Escape");
      await textarea.fill("Keep camera access in the attachment menu");
      await expect.poll(() => camera.count()).toBe(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Send message" }).isVisible())
        .toBe(true);
      await textarea.fill("");
      await expect.poll(() => camera.count()).toBe(0);
      await model.click();
      const mobilePickerBox = await composer
        .locator(".chat-controls__inline-select-menu--combined")
        .boundingBox();
      expect(mobilePickerBox).not.toBeNull();
      if (!mobilePickerBox) {
        throw new Error("expected mobile model picker to have a layout box");
      }
      expect(mobilePickerBox.x).toBeGreaterThanOrEqual(0);
      expect(mobilePickerBox.x + mobilePickerBox.width).toBeLessThanOrEqual(393);
      await model.click();
      await settings.click();
      await expect.poll(() => viewMenu.isVisible()).toBe(true);
      await settings.click();
      await expect.poll(() => viewMenu.isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("refreshes the configured usable catalog after advertised chat metadata", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ],
      methodResponses: {
        "chat.startup": {
          agentsList: {
            agents: [{ id: "main", name: "OpenClaw" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          messages: [],
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
        "chat.metadata": {
          commands: [],
          models: [
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
            {
              id: "gpt-5.3-codex-spark",
              name: "GPT-5.3 Codex Spark",
              provider: "codex",
              available: false,
            },
          ],
        },
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: 200_000,
            model: "gpt-5.3-codex-spark",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              displayName: "Main",
              hasActiveRun: false,
              key: "main",
              kind: "direct",
              label: "Main",
              model: "gpt-5.5",
              modelProvider: "openai",
              status: "done",
              totalTokens: 0,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      const providers = composer.locator("[data-chat-model-provider]");
      await expect
        .poll(async () => (await providers.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI"]);
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.5");
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="codex"]').count())
        .toBe(0);
      // The advertised default is unavailable, so no usable catalog row is
      // marked as the default and no synthetic empty row is introduced.
      await expect.poll(() => composer.locator('[data-chat-model-default="true"]').count()).toBe(0);
      await expect.poll(() => composer.locator('[data-chat-model-option=""]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("refreshes agent-scoped models when the pane switches sessions", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "work",
      sessionKey: "agent:work:main",
      methodResponses: {
        "chat.metadata": {
          cases: [
            {
              match: { agentId: "work" },
              response: {
                commands: [],
                models: [
                  {
                    id: "work-model",
                    name: "Work Model",
                    provider: "openai",
                    available: true,
                  },
                ],
              },
            },
            {
              match: { agentId: "other" },
              response: {
                commands: [],
                models: [
                  {
                    id: "other-model",
                    name: "Other Model",
                    provider: "anthropic",
                    available: true,
                  },
                ],
              },
            },
          ],
        },
        "sessions.list": {
          count: 2,
          defaults: {
            contextTokens: 200_000,
            model: "other-model",
            modelProvider: "anthropic",
          },
          path: "",
          sessions: [
            {
              key: "agent:work:main",
              kind: "direct",
              model: "work-model",
              modelProvider: "openai",
              status: "done",
              updatedAt: Date.now(),
            },
            {
              key: "agent:other:main",
              kind: "direct",
              model: "other-model",
              modelProvider: "anthropic",
              status: "done",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
      models: [{ id: "work-model", name: "Work Model", provider: "openai", available: true }],
    });

    try {
      await page.goto(`${server.baseUrl}chat?session=agent%3Awork%3Amain`);
      await expect
        .poll(
          async () => {
            const requests = await gateway.getRequests("chat.metadata");
            return requests.some(
              (request) => (request.params as { agentId?: string } | undefined)?.agentId === "work",
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/work-model"]').count())
        .toBe(1);

      await page.locator("openclaw-chat-pane").evaluate((pane) => {
        (pane as HTMLElement & { sessionKey: string }).sessionKey = "agent:other:main";
      });

      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("chat.metadata");
          return requests.some(
            (request) => (request.params as { agentId?: string } | undefined)?.agentId === "other",
          );
        })
        .toBe(true);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="anthropic/other-model"]').count())
        .toBe(1);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/work-model"]').count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps startup models when the metadata refresh fails", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.metadata"],
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      await gateway.rejectDeferred("chat.metadata", {
        code: "UNAVAILABLE",
        message: "metadata unavailable",
      });
      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.5");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("does not substitute default-agent models when scoped metadata fails", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup", "chat.metadata"],
      models: [{ id: "gpt-default", name: "GPT Default", provider: "openai", available: true }],
    });

    try {
      await page.goto(`${server.baseUrl}chat?session=agent%3Amain%3Amain`);
      await gateway.waitForRequest("chat.startup");
      await page.locator("openclaw-chat-pane").evaluate((pane) => {
        (pane as HTMLElement & { sessionKey: string }).sessionKey = "agent:work:main";
      });
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("chat.metadata");
          return requests.some(
            (request) => (request.params as { agentId?: string } | undefined)?.agentId === "work",
          );
        })
        .toBe(true);
      await gateway.rejectDeferred("chat.metadata", {
        code: "UNAVAILABLE",
        message: "metadata unavailable",
      });
      const agentsRequestsBeforeStartup = (await gateway.getRequests("agents.list")).length;
      await gateway.resolveDeferred("chat.startup", {
        agentsList: {
          agents: [
            { id: "main", name: "Main" },
            { id: "work", name: "Work" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        messages: [],
        metadata: {
          commands: [],
          models: [{ id: "gpt-default", name: "GPT Default", provider: "openai", available: true }],
        },
        sessionId: "control-ui-e2e-session",
        thinkingLevel: null,
      });
      await expect
        .poll(async () => (await gateway.getRequests("agents.list")).length)
        .toBeGreaterThan(agentsRequestsBeforeStartup);
      await page.waitForFunction(() => {
        const pane = document.querySelector("openclaw-chat-pane") as
          | (HTMLElement & {
              state?: { agentsList?: { defaultId?: string; agents?: Array<{ id?: string }> } };
            })
          | null;
        return (
          pane?.state?.agentsList?.defaultId === "main" &&
          pane.state.agentsList.agents?.some((agent) => agent.id === "main") === true
        );
      });
      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(async () =>
          (await composer.locator("[data-chat-model-option]").allTextContents()).join(" "),
        )
        .not.toContain("GPT Default");
      const metadataRequests = await gateway.getRequests("chat.metadata");
      expect(metadataRequests).toHaveLength(1);
      expect((metadataRequests[0]?.params as { agentId?: string } | undefined)?.agentId).toBe(
        "work",
      );
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("does not request unscoped models when chat metadata is unavailable", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [{ id: "gpt-default", name: "GPT Default", provider: "openai", available: true }],
      methodResponses: {
        connect: {
          auth: {
            deviceToken: "e2e-device-token",
            role: "operator",
            scopes: [
              "operator.admin",
              "operator.read",
              "operator.write",
              "operator.approvals",
              "operator.pairing",
            ],
          },
          features: { events: [], methods: ["chat.startup"] },
          protocol: 4,
          server: { connId: "control-ui-e2e", version: "e2e" },
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: "agent:work:main",
              scope: "agent",
            },
          },
          type: "hello-ok",
        },
        "chat.startup": {
          agentsList: {
            agents: [{ id: "work", name: "Work" }],
            defaultId: "main",
            mainKey: "agent:work:main",
            scope: "agent",
          },
          messages: [],
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat?session=agent%3Awork%3Amain`);
      await expect.poll(async () => (await gateway.getRequests("chat.startup")).length).toBe(1);

      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(async () =>
          (await composer.locator("[data-chat-model-option]").allTextContents()).join(" "),
        )
        .not.toContain("GPT Default");
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
