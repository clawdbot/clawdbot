// Control UI E2E tests cover the redesigned chat composer.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer redesign",
});

// Browser contexts preserve test isolation; keep one process warm for this file.
suite.define(() => {
  it.each([
    {
      reason: "missing-auth",
      blocked: true,
      message: "No provider credential is configured for this model. Set it up in Model Setup.",
    },
    {
      reason: "auth-failed",
      blocked: true,
      message: "Authentication failed. Review the provider credential or sign-in, then retry.",
    },
    { reason: "cooldown", blocked: false, message: null },
    { reason: undefined, blocked: false, message: null },
  ] as const)(
    "keeps $reason model availability honest in the composer and picker",
    async ({ reason, blocked, message }) => {
      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
          ...(artifactDir ? { recordVideo: { dir: artifactDir } } : {}),
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                provider: "openai",
                available: false,
                unavailableReason: reason,
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("chat.startup");
          const textarea = page.locator(".agent-chat__composer-combobox textarea");
          await expect.poll(() => textarea.isDisabled()).toBe(blocked);
          const statusBand = page.locator(".agent-chat__composer-status-band");
          if (message) {
            await expect.poll(() => statusBand.textContent()).toContain(message);
          } else {
            await expect.poll(() => statusBand.count()).toBe(0);
            await textarea.fill("Send while availability recovers");
            await page.getByRole("button", { name: "Send message" }).click();
            const send = await gateway.waitForRequest("chat.send");
            expect(send.params).toMatchObject({ message: "Send while availability recovers" });
            const runId =
              typeof send.params === "object" &&
              send.params !== null &&
              "idempotencyKey" in send.params
                ? String(send.params.idempotencyKey)
                : "";
            await gateway.emitChatFinal({ runId, text: "The run succeeded." });
            await expect
              .poll(() => page.getByText("The run succeeded.").count())
              .toBeGreaterThan(0);
          }
          if (artifactDir) {
            await page.screenshot({
              path: `${artifactDir}/model-${reason ?? "unknown"}-composer.png`,
            });
          }
          await page.locator('[data-chat-model-select="true"]').click();
          const option = page.locator('[data-chat-model-option="openai/gpt-5.5"]');
          await expect.poll(() => option.isVisible()).toBe(true);
          if (blocked) {
            await expect.poll(() => option.getAttribute("data-chat-model-setup")).toBe("true");
            await option.click();
            await expect.poll(() => page.url()).toContain("model-setup");
          } else {
            expect(await option.isDisabled()).toBe(true);
            expect(await page.locator(".chat-controls__model-menu").textContent()).not.toContain(
              "Authentication failed",
            );
            expect(await option.textContent()).not.toContain("Sign-in needed");
          }
        },
      );
    },
  );

  it("keeps offline status in one bounded composer row", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.setOnline(false);

      const statusBand = page.locator(".agent-chat__composer-status-band");
      await expect
        .poll(() => statusBand.locator("xpath=..").getAttribute("data-tone"))
        .toBe("warn");
      await expect.poll(() => statusBand.textContent()).toContain("Offline");
      await expect
        .poll(() =>
          statusBand.locator("svg").evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return [bounds.width, bounds.height];
          }),
        )
        .toEqual([16, 16]);
      await expect
        .poll(() => statusBand.evaluate((node) => node.getBoundingClientRect().height))
        .toBe(44);
    });
  });

  it("keeps mobile picker panels above an attachment-expanded composer", async () => {
    await suite.withPage({ viewport: { width: 393, height: 852 } }, async ({ page }) => {
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
        const visibleTrigger = composer.locator(picker.trigger);
        await expect.poll(() => visibleTrigger.isVisible()).toBe(true);
        await visibleTrigger.click();
        await page.waitForTimeout(100);
        const [composerBox, footerBox, menuBox, triggerBox] = await Promise.all([
          composer.boundingBox(),
          composer.locator(".agent-chat__composer-footer").boundingBox(),
          page.locator(picker.menu).boundingBox(),
          visibleTrigger.boundingBox(),
        ]);
        expect(composerBox).not.toBeNull();
        expect(footerBox).not.toBeNull();
        expect(menuBox).not.toBeNull();
        expect(triggerBox).not.toBeNull();
        if (!composerBox || !footerBox || !menuBox || !triggerBox) {
          throw new Error(`expected mobile layout boxes for ${picker.menu}`);
        }
        expect(menuBox.x).toBeGreaterThanOrEqual(12);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(381);
        expect(menuBox.width).toBeGreaterThanOrEqual(368);
        expect(menuBox.y).toBeGreaterThanOrEqual(0);
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(composerBox.y + 1);
        expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(853);
        expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(853);
        await page.keyboard.press("Escape");
      }
      const effort = composer.locator('[data-chat-thinking-select="true"]');
      await effort.press("Enter");
      await expect
        .poll(() => composer.locator(".chat-controls__effort-menu").isVisible())
        .toBe(true);
      await effort.press("Tab");
      const focusedEffortControl = composer.locator(
        "[data-chat-thinking-slider]:not([disabled]), [data-chat-speed-toggle]:not([disabled])",
      );
      await expect
        .poll(() =>
          focusedEffortControl.first().evaluate((node) => node === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect
        .poll(() => effort.evaluate((node) => node === document.activeElement))
        .toBe(true);
    });
  });

  it("keeps the model in the bottom bar, session settings in the header, and holds send beside the microphone in every input state", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const pageOptions = {
      viewport: { width: 1920, height: 1080 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { width: 393, height: 852 } } }
        : {}),
    };
    await suite.withPage(pageOptions, async ({ page }) => {
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
      const usage = composer.locator('[data-chat-provider-usage="true"]');
      const contextUsage = composer.locator(".context-ring");
      const permission = composer.locator('[data-chat-permission-select="true"]');
      const permissionIcon = permission.locator(".chat-controls__permission-icon svg");
      const textarea = composer.locator("textarea");
      const attach = composer.locator(
        'button.agent-chat__input-btn--attach[aria-label="Add attachment"]',
      );
      const camera = composerShell.locator(".agent-chat__camera-btn");
      const takePhoto = composerShell.getByRole("menuitem", { name: "Take photo" });
      const settings = page.locator(".chat-header-session-menu__trigger");
      const splitView = page.getByRole("button", { name: "Open split view" });
      const voice = page.getByRole("button", { name: "Start voice input" });
      const mobileDictation = page.getByRole("button", { name: "Dictation" });
      const microphonePicker = page.getByRole("button", { name: "Microphone input" });
      const microphonePickerShell = page.locator(".chat-talk-input-picker");
      const captureMobileState = async (fileName: string) => {
        if (!artifactDir) {
          return;
        }
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: `${artifactDir}/${fileName}`,
        });
      };
      const permissionIconCenterError = async () => {
        const [triggerBox, iconBox] = await Promise.all([
          permission.boundingBox(),
          permissionIcon.boundingBox(),
        ]);
        if (!triggerBox || !iconBox) {
          return Number.POSITIVE_INFINITY;
        }
        const x = iconBox.x + iconBox.width / 2 - (triggerBox.x + triggerBox.width / 2);
        const y = iconBox.y + iconBox.height / 2 - (triggerBox.y + triggerBox.height / 2);
        return Math.max(Math.abs(x), Math.abs(y));
      };

      await expect.poll(() => model.isVisible()).toBe(true);
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
      // The editor's row holds nothing but the text: attachments open from the
      // leading end of the action row and voice sits with the primary action at
      // its trailing end, so the whole bottom row is one band of controls.
      await expect
        .poll(() => attach.evaluate((node) => node.closest(".agent-chat__composer-lead") != null))
        .toBe(true);
      await expect
        .poll(() => voice.evaluate((node) => node.closest(".agent-chat__composer-trail") != null))
        .toBe(true);
      // The device chevron is hidden at rest and grows out of the microphone's
      // leading edge on approach, so the resting action row shows one circular
      // mic and nothing beside it. It must claim no width while collapsed, or it
      // would hold an empty gap in the row it is supposed to stay out of.
      const pickerWidth = () =>
        microphonePicker.evaluate((node) => node.getBoundingClientRect().width);
      await expect.poll(pickerWidth).toBe(0);
      await voice.hover();
      await expect.poll(pickerWidth).toBeGreaterThanOrEqual(12);
      const voiceBeforeHold = await voice.boundingBox();
      expect(voiceBeforeHold).not.toBeNull();
      await page.mouse.down();
      await expect
        .poll(() =>
          voice.evaluate((node) => node.classList.contains("chat-send-btn--dictation-arming")),
        )
        .toBe(true);
      await expect.poll(() => microphonePicker.isVisible()).toBe(true);
      await expect.poll(pickerWidth).toBeGreaterThanOrEqual(12);
      const voiceDuringHold = await voice.boundingBox();
      expect(voiceDuringHold).not.toBeNull();
      expect(Math.abs((voiceDuringHold?.x ?? 0) - (voiceBeforeHold?.x ?? 0))).toBeLessThanOrEqual(
        1,
      );
      await page.mouse.up();
      await page.mouse.move(0, 0);
      await expect.poll(pickerWidth).toBe(0);
      await expect
        .poll(() => model.evaluate((node) => node.closest(".agent-chat__composer-footer") != null))
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
      // Every other control here is a step of the surface itself, so colour is
      // what marks the one committed action once there is something to send.
      const brandFill = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(document.documentElement)
          .getPropertyValue("--primary")
          .trim();
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      });
      await expect
        .poll(() =>
          page
            .getByRole("button", { name: "Send message" })
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe(brandFill);

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
      await page.setViewportSize({ width: 393, height: 852 });
      await captureMobileState("mobile-composer-active-follow-up.png");

      await textarea.fill("");
      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stop.isVisible()).toBe(true);
      // Stop is deliberately left out of the brand fill: commit and interrupt
      // share one slot, so they must not share one colour.
      await expect
        .poll(() => stop.evaluate((node) => getComputedStyle(node).backgroundColor))
        .not.toBe(brandFill);
      const mobileModelSettings = composer.locator('[data-chat-model-select="true"]');
      await expect.poll(() => mobileModelSettings.isVisible()).toBe(true);
      const [activeMobileSettingsBox, activeMobileStopBox] = await Promise.all([
        mobileModelSettings.boundingBox(),
        stop.boundingBox(),
      ]);
      expect(activeMobileSettingsBox?.width).toBeGreaterThanOrEqual(44);
      expect(activeMobileSettingsBox?.height).toBeGreaterThanOrEqual(44);
      expect(activeMobileStopBox?.width).toBeCloseTo(32, 2);
      expect(activeMobileStopBox?.height).toBeCloseTo(32, 2);
      await captureMobileState("mobile-composer-active-stop.png");
      await textarea.press("Escape");
      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({
        runId,
        sessionKey: "main",
      });
      await expect.poll(() => stop.count()).toBe(0);

      await textarea.fill("");
      await expect.poll(() => mobileDictation.isVisible()).toBe(true);
      const mobileTalk = page.getByRole("button", { name: "Tap to talk" });
      await expect.poll(() => mobileTalk.isVisible()).toBe(true);
      await captureMobileState("mobile-composer-idle.png");
      // Send holds its place with nothing to send: it goes unavailable rather
      // than disappearing, so the composer never looks like it lost the control
      // that commits a turn.
      await expect
        .poll(async () => {
          const [voiceRect, sendRect] = await Promise.all([
            mobileDictation.boundingBox(),
            mobileTalk.boundingBox(),
          ]);
          return voiceRect && sendRect ? sendRect.x - (voiceRect.x + voiceRect.width) : null;
        })
        .toBeGreaterThanOrEqual(-1);

      await expect.poll(() => camera.count()).toBe(0);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width))
        .toBe(0);
      // Resize re-layout is async; wait for the header controls to adopt the
      // mobile width before sampling one-shot bounding boxes below.
      await expect
        .poll(async () => {
          const settled = await settings.boundingBox();
          return settled ? settled.x + settled.width : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(393);
      await expect.poll(() => mobileModelSettings.isVisible()).toBe(true);
      await expect.poll(() => effort.isVisible()).toBe(true);
      await permission.click();
      await expect
        .poll(() => composer.locator(".chat-controls__permission-option").first().isVisible())
        .toBe(true);
      await captureMobileState("mobile-composer-permissions-open.png");
      await page.keyboard.press("Escape");
      const [
        mobileAttachBox,
        mobileModelSettingsBox,
        mobileSettingsBox,
        mobileContextBox,
        mobileVoiceBox,
      ] = await Promise.all([
        attach.boundingBox(),
        mobileModelSettings.boundingBox(),
        settings.boundingBox(),
        contextUsage.boundingBox(),
        mobileDictation.boundingBox(),
      ]);
      expect(mobileAttachBox).not.toBeNull();
      expect(mobileModelSettingsBox).not.toBeNull();
      expect(mobileSettingsBox).not.toBeNull();
      expect(mobileContextBox).not.toBeNull();
      expect(mobileVoiceBox).not.toBeNull();
      if (
        !mobileAttachBox ||
        !mobileModelSettingsBox ||
        !mobileSettingsBox ||
        !mobileContextBox ||
        !mobileVoiceBox
      ) {
        throw new Error("expected mobile composer controls to have layout boxes");
      }
      expect(mobileModelSettingsBox.width).toBeGreaterThanOrEqual(44);
      expect(mobileModelSettingsBox.height).toBeGreaterThanOrEqual(44);
      await expect.poll(permissionIconCenterError).toBeLessThanOrEqual(1);
      expect(mobileModelSettingsBox.x).toBeGreaterThanOrEqual(
        mobileContextBox.x + mobileContextBox.width - 1,
      );
      for (const control of [mobileModelSettingsBox, mobileContextBox]) {
        expect(
          Math.abs(
            control.y +
              control.height / 2 -
              (mobileModelSettingsBox.y + mobileModelSettingsBox.height / 2),
          ),
        ).toBeLessThanOrEqual(2);
      }
      expect(mobileSettingsBox.x).toBeGreaterThanOrEqual(0);
      expect(mobileSettingsBox.x + mobileSettingsBox.width).toBeLessThanOrEqual(393);
      expect(mobileAttachBox.x + mobileAttachBox.width).toBeLessThanOrEqual(mobileVoiceBox.x + 1);
      await page.setViewportSize({ width: 560, height: 852 });
      await expect.poll(permissionIconCenterError).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 393, height: 852 });
      await expect
        .poll(async () => {
          const [polledAttachBox, polledVoiceBox] = await Promise.all([
            attach.boundingBox(),
            mobileDictation.boundingBox(),
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
      await captureMobileState("mobile-composer-send-ready.png");
      await textarea.fill("");
      await expect.poll(() => camera.count()).toBe(0);
      await mobileModelSettings.click();
      await expect
        .poll(() => composer.locator(".chat-controls__model-menu").isVisible())
        .toBe(true);
      await captureMobileState("mobile-composer-model-open.png");
      const mobilePickerBox = await composer.locator(".chat-controls__model-menu").boundingBox();
      expect(mobilePickerBox).not.toBeNull();
      if (!mobilePickerBox) {
        throw new Error("expected mobile model picker to have a layout box");
      }
      expect(mobilePickerBox.x).toBeGreaterThanOrEqual(0);
      expect(mobilePickerBox.x + mobilePickerBox.width).toBeLessThanOrEqual(393);
      expect(
        await composer
          .locator(".chat-controls__model-menu")
          .getByText(/Effort|Fast mode/)
          .count(),
      ).toBe(0);
      await page.keyboard.press("Escape");
      await effort.click();
      await expect
        .poll(() => composer.locator(".chat-controls__effort-menu").isVisible())
        .toBe(true);
      await captureMobileState("mobile-composer-effort-open.png");
      await page.keyboard.press("Escape");
      await settings.click();
      await expect.poll(() => viewMenu.isVisible()).toBe(true);
      await settings.click();
      await expect.poll(() => viewMenu.isVisible()).toBe(false);

      await page.setViewportSize({ width: 1280, height: 900 });
      await gateway.setOnline(false);
      await expect.poll(() => voice.isDisabled()).toBe(true);
      // The device chevron is a modifier on the microphone, not a second half of
      // a split pill: it carries no ground of its own in any state, so an
      // unavailable microphone cannot leave a tinted segment stranded beside it.
      await expect
        .poll(() => microphonePicker.evaluate((node) => getComputedStyle(node).backgroundColor))
        .toBe("rgba(0, 0, 0, 0)");
      await expect
        .poll(() => microphonePicker.evaluate((node) => getComputedStyle(node).borderLeftWidth))
        .toBe("0px");
      if (artifactDir) {
        await composerShell.screenshot({
          animations: "disabled",
          path: `${artifactDir}/voice-picker-disabled-background.png`,
        });
      }
      await page.mouse.move(0, 0);
      await expect.poll(() => page.locator("wa-tooltip[open]").count()).toBe(0);
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width))
        .toBe(0);
      await expect.poll(() => voice.evaluate((node) => getComputedStyle(node).opacity)).toBe("0.4");

      await voice.hover();
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width))
        .toBe(0);
      await expect.poll(() => microphonePicker.isVisible()).toBe(false);
    });
  });
});
