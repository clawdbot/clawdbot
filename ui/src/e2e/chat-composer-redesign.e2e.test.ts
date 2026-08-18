// Control UI E2E tests cover the redesigned chat composer.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer redesign",
});

// Browser contexts preserve test isolation; keep one process warm for this file.
suite.define(() => {
  it("uses only authoritative catalog snapshots to gate the composer", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const coldModels = [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: false,
        },
      ];
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.5",
        models: coldModels,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const textarea = composer.locator("textarea");
      const model = composer.locator('[data-chat-model-select="true"]');
      const disabledReason = composer.locator(".agent-chat__disabled-reason");
      const authFailure =
        "Authentication failed. Review the provider credential or sign-in, then retry.";

      await expect.poll(() => textarea.isDisabled()).toBe(true);
      await expect.poll(async () => (await disabledReason.textContent())?.trim()).toBe(authFailure);
      await expect.poll(() => textarea.getAttribute("placeholder")).toBe("Message OpenClaw");

      await gateway.setOnline(false);
      await expect
        .poll(async () =>
          (await model.locator(".chat-controls__inline-select-label").textContent())?.trim(),
        )
        .toBe("Offline");
      await expect.poll(() => textarea.isEnabled()).toBe(true);
      await expect.poll(() => disabledReason.count()).toBe(0);

      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: 1 });
      await expect.poll(() => textarea.isDisabled()).toBe(true);
      await expect.poll(async () => (await disabledReason.textContent())?.trim()).toBe(authFailure);

      await gateway.setMethodResponse("models.list", {
        __mockError: { code: "UNAVAILABLE", message: "mock catalog refresh failed" },
      });
      const beforeFailure = (await gateway.getRequests("models.list")).length;
      await model.click();
      await gateway.waitForRequest("models.list", { after: beforeFailure });
      await expect
        .poll(() => composer.locator('[data-chat-model-catalog-state="error"]').textContent())
        .toContain("Couldn’t refresh models");
      await expect.poll(() => textarea.isEnabled()).toBe(true);
      await expect.poll(() => disabledReason.count()).toBe(0);

      await gateway.setMethodResponse("models.list", {
        models: [{ ...coldModels[0], available: true }],
      });
      const beforeRetry = (await gateway.getRequests("models.list")).length;
      await composer.locator('[data-chat-model-catalog-retry="true"]').click();
      const retry = await gateway.waitForRequest("models.list", { after: beforeRetry });
      expect(retry.params).toEqual({ agentId: "main", refresh: true, view: "configured" });
      await expect.poll(() => textarea.isEnabled()).toBe(true);
      await expect.poll(() => composer.locator("[data-chat-model-catalog-state]").count()).toBe(0);
    });
  });

  it("keeps mobile picker panels above an attachment-expanded composer", async () => {
    await suite.withPage({ viewport: { width: 667, height: 375 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      await composer.waitFor({ state: "visible" });
      await composer.locator(".agent-chat__file-input").setInputFiles({
        name: "mobile-composer-proof.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("mobile composer attachment"),
      });
      await composer.locator(".chat-attachments-preview").waitFor({ state: "visible" });

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
        await composer.locator(picker.trigger).click();
        await page.waitForTimeout(100);
        const [composerBox, footerBox, menuBox, triggerBox] = await Promise.all([
          composer.boundingBox(),
          composer.locator(".agent-chat__composer-footer").boundingBox(),
          page.locator(picker.menu).boundingBox(),
          composer.locator(picker.trigger).boundingBox(),
        ]);
        expect(composerBox).not.toBeNull();
        expect(footerBox).not.toBeNull();
        expect(menuBox).not.toBeNull();
        expect(triggerBox).not.toBeNull();
        if (!composerBox || !footerBox || !menuBox || !triggerBox) {
          throw new Error(`expected mobile layout boxes for ${picker.menu}`);
        }
        expect(menuBox.x).toBeGreaterThanOrEqual(12);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(655);
        expect(menuBox.width).toBeGreaterThanOrEqual(642);
        expect(menuBox.y).toBeGreaterThanOrEqual(0);
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(composerBox.y + 1);
        expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(376);
        expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(376);
        await composer.locator(picker.trigger).click();
      }
    });
  });

  it("keeps the model in the bottom bar, session settings in the header, and switches the primary action with input state", async () => {
    await suite.withPage({ viewport: { width: 1920, height: 1080 } }, async ({ page }) => {
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
          "config.get": {
            config: { ui: { prefs: { chatFollowUpMode: "steer" } } },
            hash: "composer-redesign-config",
            issues: [],
            raw: JSON.stringify({ ui: { prefs: { chatFollowUpMode: "steer" } } }),
            valid: true,
          },
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
                permissionMode: "workspace",
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

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const composerShell = page.locator(".agent-chat__composer-shell");
      const chatContent = page.locator("main.content--chat");
      const chatMain = page.locator(".chat-workbench__main");
      const model = composer.locator('[data-chat-model-select="true"]');
      const effort = composer.locator('[data-chat-thinking-select="true"]');
      const permission = composer.locator('[data-chat-permission-select="true"]');
      const usage = composer.locator('[data-chat-provider-usage="true"]');
      const contextUsage = composer.locator(".context-ring");
      const textarea = composer.locator("textarea");
      const attach = composer.locator(
        'button.agent-chat__input-btn--attach[aria-label="Add attachment"]',
      );
      const camera = composerShell.locator(".agent-chat__camera-btn");
      const takePhoto = composerShell.getByRole("menuitem", { name: "Take photo" });
      const settings = page.locator(".chat-header-session-menu__trigger");
      const splitView = page.getByRole("button", { name: "Open split view" });
      const voice = page.getByRole("button", { name: "Start voice input" });
      const microphonePicker = page.getByRole("button", { name: "Microphone input" });
      const microphonePickerShell = page.locator(".chat-talk-input-picker");

      await expect.poll(() => model.isVisible()).toBe(true);
      await expect.poll(() => permission.isVisible()).toBe(true);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
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
      const emptySend = page.getByRole("button", { name: "Write a message to send." });
      await expect.poll(() => emptySend.isVisible()).toBe(true);
      await expect.poll(() => emptySend.isDisabled()).toBe(true);
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
      await expect
        .poll(() =>
          permission.evaluate((node) => node.closest(".agent-chat__composer-meta") != null),
        )
        .toBe(true);
      await expect
        .poll(() =>
          permission.evaluate((node) => node.closest(".chat-composer-model-control") == null),
        )
        .toBe(true);
      await expect
        .poll(async () => {
          const [permissionBox, modelBox] = await Promise.all([
            permission.boundingBox(),
            model.boundingBox(),
          ]);
          return Boolean(permissionBox && modelBox && permissionBox.x < modelBox.x);
        })
        .toBe(true);
      await expect
        .poll(() => settings.evaluate((node) => node.closest(".chat-pane__header") != null))
        .toBe(true);
      await expect.poll(() => composer.locator(".agent-chat__composer-header").count()).toBe(0);
      await expect
        .poll(async () =>
          (await model.locator(".chat-controls__inline-select-label").textContent())?.trim(),
        )
        .toBe("GPT-5.5");
      await expect
        .poll(async () =>
          (await effort.locator(".chat-controls__inline-select-label").textContent())?.trim(),
        )
        .toBe("High");
      await expect.poll(() => contextUsage.locator(".context-ring__detail").count()).toBe(0);
      await expect
        .poll(() => contextUsage.getAttribute("aria-label"))
        .toBe("Session context usage: 46k of 200k (23%)");
      await expect
        .poll(() =>
          contextUsage.evaluate((node) => node.closest(".agent-chat__composer-context") != null),
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
        .toBe("Weekly 72%");
      await contextUsage.click();

      await effort.click();
      const thinkingSlider = composer.locator('[data-chat-thinking-slider="true"]');
      const speedToggle = composer.locator("[data-chat-speed-toggle]");
      await expect.poll(() => thinkingSlider.isVisible()).toBe(true);
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe("off,low,medium,high");
      await expect.poll(() => thinkingSlider.inputValue()).toBe("3");
      // OpenAI sessions toggle between the standard and priority tiers.
      await expect.poll(() => speedToggle.getAttribute("aria-checked")).toBe("false");
      // Reasoning and speed commit immediately while the Effort picker stays open.
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
      await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
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
      await page.keyboard.press("Escape");
      await expect
        .poll(() => composer.locator(".chat-controls__effort-menu").isVisible())
        .toBe(false);
      await effort.click();
      await expect.poll(() => speedToggle.getAttribute("aria-checked")).toBe("true");
      await expect
        .poll(() => composer.locator('[data-chat-thinking-slider="true"]').count())
        .toBe(1);
      await page.keyboard.press("Escape");
      await model.click();
      const providerHeadings = composer.locator("[data-chat-model-provider]");
      await expect
        .poll(async () => (await providerHeadings.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI", "Anthropic"]);
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.4 Pro");
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
      const viewDropdown = page.locator("wa-dropdown.chat-header-session-menu");
      const viewMenu = viewDropdown.getByRole("menuitem", { name: "View", exact: true });
      await expect.poll(() => viewMenu.isVisible()).toBe(true);
      await viewMenu.hover();
      await expect
        .poll(() =>
          viewMenu
            .locator('wa-dropdown-item[slot="submenu"] .session-menu__text')
            .allTextContents(),
        )
        .toEqual(["Reasoning", "Tool calls", "Keep commentary"]);
      const reasoning = viewDropdown.getByRole("menuitemcheckbox", { name: "Reasoning" });
      await expect.poll(() => reasoning.isVisible()).toBe(true);
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("true");
      await reasoning.click();
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("false");
      await reasoning.click();
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("true");
      await settings.click();
      await expect.poll(() => viewDropdown.getAttribute("open")).toBeNull();

      await textarea.fill("Send this message");
      await expect
        .poll(() => page.getByRole("button", { name: "Send message" }).isVisible())
        .toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).isVisible())
        .toBe(true);

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
      // The working row stays attached with elapsed/token telemetry throughout streaming.
      await expect.poll(() => page.getByText("Working on it.").first().isVisible()).toBe(true);
      await expect.poll(() => spark.isVisible()).toBe(true);
      await expect.poll(() => announcement.textContent()).toContain("Rosita is responding");
      const [activeSplitViewBox, activeModelBox, activeChatContentBox] = await Promise.all([
        splitView.boundingBox(),
        model.boundingBox(),
        chatContent.boundingBox(),
      ]);
      expect(activeSplitViewBox).not.toBeNull();
      expect(activeModelBox).not.toBeNull();
      expect(activeChatContentBox).not.toBeNull();
      if (!activeSplitViewBox || !activeModelBox || !activeChatContentBox) {
        throw new Error("expected chat content and composer controls to have layout boxes");
      }
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
      await textarea.fill("Steer this queued follow-up");
      const followUp = page.getByRole("button", {
        name: /^(Queue message|Steer into the active run)$/,
      });
      await expect.poll(() => followUp.isVisible()).toBe(true);
      await expect.poll(() => page.locator(".chat-send-btn--stop").count()).toBe(0);

      await textarea.fill("");
      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stop.isVisible()).toBe(true);
      await textarea.press("Escape");
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
      await expect.poll(() => emptySend.isVisible()).toBe(true);
      await expect.poll(() => emptySend.isDisabled()).toBe(true);

      await page.setViewportSize({ width: 393, height: 852 });
      await expect.poll(() => camera.count()).toBe(0);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => getComputedStyle(node).opacity))
        .toBe("0");
      // Resize re-layout is async; wait for the header controls to adopt the
      // mobile width before sampling one-shot bounding boxes below.
      await expect
        .poll(async () => {
          const settled = await settings.boundingBox();
          return settled ? settled.x + settled.width : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(393);
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
      for (const control of [mobileModelBox, mobileContextBox]) {
        expect(
          Math.abs(control.y + control.height / 2 - (mobileModelBox.y + mobileModelBox.height / 2)),
        ).toBeLessThanOrEqual(2);
      }
      expect(mobileSettingsBox.x).toBeGreaterThanOrEqual(0);
      expect(mobileSettingsBox.x + mobileSettingsBox.width).toBeLessThanOrEqual(393);
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
      await expect
        .poll(() => composer.locator(".chat-controls__model-menu").isVisible())
        .toBe(true);
      const mobilePickerBox = await composer.locator(".chat-controls__model-menu").boundingBox();
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

      await page.setViewportSize({ width: 1280, height: 900 });
      await gateway.setOnline(false);
      await expect.poll(() => voice.isDisabled()).toBe(true);
      await page.mouse.move(0, 0);
      await expect.poll(() => page.locator("wa-tooltip[open]").count()).toBe(0);
      // The picker reserves its width while hidden; only opacity reveals it, so
      // hovering never shifts the right-aligned mic/send cluster sideways.
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width))
        .toBe(22);
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => getComputedStyle(node).opacity))
        .toBe("0");
      await expect.poll(() => voice.evaluate((node) => getComputedStyle(node).opacity)).toBe("0.4");
      const idleVoiceBox = await voice.boundingBox();
      expect(idleVoiceBox).not.toBeNull();

      await voice.hover();
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => getComputedStyle(node).opacity))
        .toBe("1");
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width))
        .toBe(22);
      const hoveredVoiceBox = await voice.boundingBox();
      expect(hoveredVoiceBox).not.toBeNull();
      if (!idleVoiceBox || !hoveredVoiceBox) {
        throw new Error("expected voice button layout boxes around hover");
      }
      expect(hoveredVoiceBox.x).toBe(idleVoiceBox.x);
      await microphonePicker.click();
      await expect.poll(() => microphonePicker.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => page.locator(".chat-talk-input-picker[open]").count()).toBe(1);
    });
  });
});
