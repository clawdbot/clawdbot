// Control UI E2E tests cover the redesigned chat composer.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer redesign",
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "chat-composer-redesign",
);

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, fileName),
  });
}

// Browser contexts preserve test isolation; keep one process warm for this file.
suite.define(() => {
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
      await captureUiProof(page, "01-empty-idle-disabled-send.png");
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
      await captureUiProof(page, "02-draft-single-send.png");

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
      await captureUiProof(page, "03-active-run-draft-single-follow-up.png");

      await textarea.fill("");
      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stop.isVisible()).toBe(true);
      await captureUiProof(page, "04-active-run-empty-stop.png");
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
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width))
        .toBe(0);
      await expect.poll(() => voice.evaluate((node) => getComputedStyle(node).opacity)).toBe("0.4");

      await voice.hover();
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width))
        .toBe(20);
      await expect
        .poll(() => microphonePickerShell.evaluate((node) => getComputedStyle(node).opacity))
        .toBe("1");
      await captureUiProof(page, "05-mic-hover-reveals-picker.png");
      await microphonePicker.click();
      await expect.poll(() => microphonePicker.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => page.locator(".chat-talk-input-picker[open]").count()).toBe(1);
    });
  });

  it("refreshes the configured usable catalog after advertised chat metadata", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.3-codex-spark",
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

      await page.goto(`${suite.server.baseUrl}chat`);
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
      // The advertised default is configured but unavailable, so its row stays
      // visible and disabled while the usable model remains selectable.
      const unavailableDefault = composer.locator('[data-chat-model-default="true"]');
      await expect.poll(() => unavailableDefault.count()).toBe(1);
      await expect.poll(() => unavailableDefault.getAttribute("disabled")).not.toBeNull();
      await expect.poll(() => composer.locator('[data-chat-model-option=""]').count()).toBe(0);
    });
  });

  it("keeps an auth-cold configured catalog visible and blocks chat until setup", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          available: false,
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available: false,
        },
      ];
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.6-sol",
        models,
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: {
              contextTokens: 200_000,
              model: "gpt-5.6-sol",
              modelProvider: "openai",
            },
            path: "",
            sessions: [
              {
                key: "main",
                kind: "direct",
                model: "gpt-5.6-sol",
                modelProvider: "openai",
                status: "done",
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      const picker = composer.locator("details.chat-controls__model-picker");
      const options = picker.locator(
        "button[data-chat-model-option]:not([data-chat-model-target])",
      );
      await picker.locator("summary").click();
      await gateway.waitForRequest("models.list");
      await expect.poll(() => options.count()).toBe(2);
      await expect.poll(() => options.last().isVisible()).toBe(true);
      await expect.poll(() => options.first().textContent()).toContain("GPT-5.6 Sol");
      await expect.poll(() => options.first().textContent()).toContain("Default");
      await expect.poll(() => options.first().textContent()).toContain("Sign-in needed");
      await expect
        .poll(() =>
          options.evaluateAll((rows) => rows.every((row) => row.hasAttribute("disabled"))),
        )
        .toBe(true);
      await expect
        .poll(() => composer.locator(".chat-controls__model-catalog-state").textContent())
        .toContain("Review the provider credential or sign-in, then retry");
      await expect.poll(() => composer.locator("textarea").isDisabled()).toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await composer.screenshot({
          animations: "disabled",
          path: `${artifactDir}/auth-cold-model-picker.png`,
        });
      }
      await composer.locator('[data-chat-model-setup="true"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
    });
  });

  it("loads agent-scoped startup models when the route switches sessions", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const workModel = {
        id: "work-model",
        name: "Work Model",
        provider: "openai",
        available: true,
      };
      const otherModel = {
        id: "other-model",
        name: "Other Model",
        provider: "anthropic",
        available: true,
      };
      const startupResponse = (sessionId: string, model: typeof workModel) => ({
        agentsList: {
          agents: [
            { id: "work", name: "Work" },
            { id: "other", name: "Other" },
          ],
          defaultId: "work",
          mainKey: "main",
          scope: "agent",
        },
        messages: [],
        metadata: { commands: [], models: [model] },
        sessionId,
        thinkingLevel: null,
      });
      const gateway = await installMockGateway(page, {
        defaultAgentId: "work",
        sessionKey: "agent:work:main",
        methodResponses: {
          "chat.startup": {
            cases: [
              {
                match: { sessionKey: "agent:work:main" },
                response: startupResponse("work-session", workModel),
              },
              {
                match: { sessionKey: "agent:other:main" },
                response: startupResponse("other-session", otherModel),
              },
            ],
          },
          "models.list": {
            cases: [
              {
                match: { agentId: "other", view: "configured" },
                response: { models: [otherModel] },
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
        models: [workModel],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);

      const activeComposer = () =>
        page.locator('openclaw-chat-pane[aria-hidden="false"] .agent-chat__input');
      await expect
        .poll(() =>
          activeComposer().locator('[data-chat-model-option="openai/work-model"]').count(),
        )
        .toBe(1);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      await navigateToControlUiSession(page, "agent:other:main");
      const startupRequests = await gateway.getRequests("chat.startup");
      expect(
        startupRequests.filter(
          (request) =>
            (request.params as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:other:main",
        ),
      ).toHaveLength(1);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      await expect
        .poll(() =>
          activeComposer().locator('[data-chat-model-option="anthropic/other-model"]').count(),
        )
        .toBe(1);
      await expect
        .poll(() =>
          activeComposer().locator('[data-chat-model-option="openai/work-model"]').count(),
        )
        .toBe(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    });
  });

  it("keeps startup models visible and retries failed picker discovery", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const startupModel = {
        id: "startup-model",
        name: "Startup Model",
        provider: "openai",
        available: true,
      };
      const discoveredModel = {
        id: "discovered-model",
        name: "Discovered Model",
        provider: "anthropic",
        available: true,
      };
      const gateway = await installMockGateway(page, {
        models: [startupModel],
        methodResponses: {
          "models.list": {
            sequence: [
              {
                __mockError: {
                  code: "UNAVAILABLE",
                  message: "catalog discovery failed",
                },
              },
              { models: [startupModel, discoveredModel] },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      await composer.locator('[data-chat-model-select="true"]').click();
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(1);
      await expect
        .poll(() => composer.locator('[data-chat-model-catalog-state="error"]').isVisible())
        .toBe(true);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/startup-model"]').isVisible())
        .toBe(true);

      await composer.locator('[data-chat-model-catalog-retry="true"]').click();

      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
      await expect
        .poll(() =>
          composer.locator('[data-chat-model-option="anthropic/discovered-model"]').isVisible(),
        )
        .toBe(true);
      expect(await composer.locator('[data-chat-model-catalog-state="error"]').count()).toBe(0);
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toEqual(expect.objectContaining({ view: "configured" }));
        expect(request.params).not.toEqual(expect.objectContaining({ preparedOnly: true }));
      }
    });
  });

  it("does not request unscoped models when chat metadata is unavailable", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
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
              mainKey: "main",
              scope: "agent",
            },
            messages: [],
            sessionId: "control-ui-e2e-session",
            thinkingLevel: null,
          },
          "models.list": {
            cases: [
              {
                match: { agentId: "work", view: "configured", preparedOnly: true },
                response: { models: [] },
              },
            ],
          },
        },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
      const startupRequest = await gateway.waitForRequest("chat.startup");
      expect(startupRequest.params).toEqual(
        expect.objectContaining({ sessionKey: "agent:work:main" }),
      );
      for (const request of await gateway.getRequests("chat.startup")) {
        expect(request.params).toEqual(expect.objectContaining({ sessionKey: "agent:work:main" }));
      }

      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(async () =>
          (await composer.locator("[data-chat-model-option]").allTextContents()).join(" "),
        )
        .not.toContain("GPT Default");
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toEqual([
        expect.objectContaining({
          params: { agentId: "work", view: "configured", preparedOnly: true },
        }),
      ]);
    });
  });
});
