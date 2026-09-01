// Control UI tests cover event-reactive custodian presence against a mocked Gateway.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI custodian event nudge mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("custodian-event-nudge");
  }
});

async function settleUi(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

suite.define(() => {
  it("does not reopen agent chat when a deferred setup reply arrives after exit", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
          deferredMethods: ["openclaw.chat"],
          methodResponses: {},
        });

        const response = await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("openclaw.chat");
        await page.getByRole("button", { name: "Exit setup" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
        const destination = page.url();
        const agentListRequests = (await gateway.getRequests("agents.list")).length;

        await gateway.resolveDeferred("openclaw.chat", {
          sessionId: "late-e2e-custodian",
          reply: "Your agent is hatching — handing you over now.",
          action: "open-agent",
          agentId: "main",
          agentDraft: "hatch",
        });
        await expect.poll(() => page.url()).toBe(destination);
        expect(new URL(page.url()).searchParams.has("draft")).toBe(false);
        expect((await gateway.getRequests("agents.list")).length).toBe(agentListRequests);
      },
    );
  });

  it("shows one consequential nudge and sends its canonical message", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
          methodResponses: {
            "openclaw.chat": {
              sessionId: "e2e-custodian",
              reply: "I'm watching the system.",
              action: "none",
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}custodian`);
        expect(response?.status()).toBe(200);
        await page.getByRole("heading", { name: "OpenClaw", exact: true }).waitFor();
        await expect.poll(async () => (await gateway.getRequests("openclaw.chat")).length).toBe(1);

        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "01-before-event.png"),
          });
        }

        await gateway.emitGatewayEvent("config.changed", {
          hash: "config-hash",
          path: "/tmp/openclaw.json",
          ts: Date.now(),
        });
        await settleUi(page);
        expect(await page.locator(".custodian__nudge").count()).toBe(0);

        await gateway.emitGatewayEvent("health", {
          channelLabels: { telegram: "Telegram" },
          channels: {
            telegram: { configured: true, connected: false, running: true },
          },
        });

        const nudge = page.getByRole("button", {
          name: "Telegram just disconnected — ask me what happened",
        });
        await nudge.waitFor();
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "02-disconnected-nudge.png"),
          });
        }

        await gateway.deferNext("openclaw.chat");
        await nudge.click();
        await expect.poll(async () => (await gateway.getRequests("openclaw.chat")).length).toBe(2);
        const requests = await gateway.getRequests("openclaw.chat");
        expect(requests[1]?.params).toMatchObject({
          message: "what happened with telegram?",
          sessionId: "e2e-custodian",
        });
        await page
          .locator(".chat-group.user", { hasText: "what happened with telegram?" })
          .waitFor();
        await gateway.resolveDeferred("openclaw.chat", {
          sessionId: "e2e-custodian",
          reply: "I'm watching the system.",
          action: "none",
        });
        await expect.poll(() => page.locator(".chat-group.assistant").count()).toBe(2);
        expect(await nudge.count()).toBe(0);

        await gateway.emitGatewayEvent("health", {
          configReload: { hotReloadStatus: "disabled" },
        });
        await settleUi(page);
        expect(await page.locator(".custodian__nudge").count()).toBe(0);

        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "03-message-sent.png"),
          });
        }
      },
    );
  });

  it("keeps a blocking startup error next to the composer", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1200, width: 1600 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["openclaw.chat"],
          featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
        });

        const response = await page.goto(`${suite.server.baseUrl}custodian`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("openclaw.chat");
        await gateway.rejectDeferred("openclaw.chat", {
          code: "UNAVAILABLE",
          message:
            "OpenClaw requires working inference: No agent model is configured. Run `openclaw onboard` first.",
          retryable: true,
        });

        const alert = page.getByRole("alert");
        await alert.waitFor();
        const composer = page.locator(".agent-chat__composer-shell");
        const [alertBox, composerBox] = await Promise.all([
          alert.boundingBox(),
          composer.boundingBox(),
        ]);
        expect(alertBox).not.toBeNull();
        expect(composerBox).not.toBeNull();

        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "04-inference-error.png"),
          });
        }

        const verticalGap = composerBox!.y - (alertBox!.y + alertBox!.height);
        expect(verticalGap).toBeLessThanOrEqual(32);
      },
    );
  });

  it("keeps event nudges out of sensitive wizard input", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
          methodResponses: {
            "openclaw.chat": {
              sessionId: "e2e-sensitive-custodian",
              reply: "Paste your API key.",
              action: "none",
              sensitive: true,
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}custodian`);
        await page.getByPlaceholder("Enter sensitive value").waitFor();
        await gateway.emitGatewayEvent("health", {
          channelLabels: { discord: "Discord" },
          channels: { discord: { configured: true, connected: false, running: true } },
        });

        const nudge = page.getByRole("button", {
          name: "Discord just disconnected — ask me what happened",
        });
        await nudge.waitFor();
        await expect.poll(() => nudge.isDisabled()).toBe(true);
        await nudge.evaluate((element) => (element as HTMLButtonElement).click());
        await settleUi(page);

        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(1);
        expect(await page.getByText("what happened with discord?").count()).toBe(0);
      },
    );
  });

  it("keeps nudges out of a closed question and sends a parseable skip answer", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
          methodResponses: {
            "openclaw.chat": {
              sessionId: "e2e-wizard-custodian",
              reply: "Choose one.",
              action: "none",
              question: {
                id: "access",
                header: "Access",
                question: "How should OpenClaw work?",
                options: [{ label: "Full access" }, { label: "Ask first" }],
                isOther: false,
              },
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}custodian`);
        const skip = page.getByRole("button", { name: "Skip for now" });
        await skip.waitFor();
        await gateway.emitGatewayEvent("health", {
          channelLabels: { discord: "Discord" },
          channels: { discord: { configured: true, connected: false, running: true } },
        });
        const nudge = page.getByRole("button", {
          name: "Discord just disconnected — ask me what happened",
        });
        await nudge.waitFor();
        await expect.poll(() => nudge.isDisabled()).toBe(true);
        await nudge.evaluate((element) => (element as HTMLButtonElement).click());
        await settleUi(page);
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(1);

        await gateway.setMethodResponse("openclaw.chat", {
          sessionId: "e2e-wizard-custodian",
          reply: "Moving on.",
          action: "none",
        });
        await skip.click();

        await expect.poll(async () => (await gateway.getRequests("openclaw.chat")).length).toBe(2);
        const requests = await gateway.getRequests("openclaw.chat");
        expect(requests[1]?.params).toMatchObject({
          message: "cancel",
          sessionId: "e2e-wizard-custodian",
        });
        await page.locator(".chat-group.user", { hasText: "Skip for now" }).waitFor();
        await page.getByText("Moving on.").waitFor();
        expect(await page.locator("openclaw-option-card").count()).toBe(0);
      },
    );
  });

  it("renders rich wizard controls and sends typed answers", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureCapabilities: [GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL],
          featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
          methodResponses: {
            "openclaw.chat": {
              sessionId: "e2e-rich-wizard",
              reply: "Choose a channel.",
              action: "none",
              wizardInputPending: true,
              step: {
                id: "channel",
                type: "select",
                message: "Which channel?",
                options: ["Discord", "Slack", "Telegram", "WhatsApp", "Twitch"].map((label) => ({
                  label,
                  value: label.toLowerCase(),
                })),
              },
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}custodian`);
        await page.addStyleTag({
          content: ".custodian__wizard-step * { transition: none !important; }",
        });
        await page.getByLabel("Twitch").waitFor();
        expect(await page.locator("openclaw-option-card").count()).toBe(0);
        expect(await page.locator(".agent-chat__composer-shell").count()).toBe(0);

        const twitchOption = page.locator(".wizard-step__option", { hasText: "Twitch" });
        const continueButton = page.getByRole("button", { name: "Continue" });
        const cancelButton = page.getByRole("button", { name: "Cancel" });
        const readInteractionStyle = (element: Element) => {
          const style = getComputedStyle(element);
          return {
            backgroundColor: style.backgroundColor,
            borderColor: style.borderColor,
            cursor: style.cursor,
          };
        };

        const optionRestingStyle = await twitchOption.evaluate(readInteractionStyle);
        await twitchOption.hover();
        const optionHoverStyle = await twitchOption.evaluate(readInteractionStyle);
        expect(optionRestingStyle.cursor).toBe("default");
        expect(optionHoverStyle.borderColor).not.toBe(optionRestingStyle.borderColor);

        const disabledContinueStyle = await continueButton.evaluate(readInteractionStyle);
        await continueButton.hover();
        expect(await continueButton.evaluate(readInteractionStyle)).toEqual(disabledContinueStyle);
        expect(disabledContinueStyle.cursor).toBe("not-allowed");
        expect(await cancelButton.evaluate((element) => getComputedStyle(element).cursor)).toBe(
          "default",
        );
        expect(
          await Promise.all(
            [continueButton, cancelButton].map((button) =>
              button.evaluate((element) => element.getBoundingClientRect().height),
            ),
          ),
        ).toEqual([44, 44]);
        for (const viewport of [
          { width: 390, height: 844, name: "phone" },
          { width: 768, height: 1024, name: "tablet" },
          { width: 1440, height: 900, name: "desktop" },
        ]) {
          await page.setViewportSize(viewport);
          await settleUi(page);
          // Read both boxes in one browser frame so scroll anchoring during a
          // viewport change cannot make two individually sampled boxes disagree.
          const [cancelBox, continueBox] = await page
            .locator(".wizard-step__actions--split")
            .evaluate((actions) =>
              [".custodian__wizard-cancel", ".btn.primary"].map((selector) => {
                const element = actions.querySelector(selector);
                if (!(element instanceof HTMLElement)) {
                  return null;
                }
                const { height, width, x, y } = element.getBoundingClientRect();
                return { height, width, x, y };
              }),
            );
          expect(cancelBox).not.toBeNull();
          expect(continueBox).not.toBeNull();
          expect(cancelBox!.x).toBeLessThan(continueBox!.x);
          expect(
            Math.abs(cancelBox!.y - continueBox!.y),
            JSON.stringify({ viewport, cancelBox, continueBox }),
          ).toBeLessThan(1);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          ).toBe(true);
          if (captureUiProofEnabled) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(uiProofArtifactDir, `05-rich-wizard-actions-${viewport.name}.png`),
            });
          }
        }

        await gateway.setMethodResponse("openclaw.chat", {
          sessionId: "e2e-rich-wizard",
          reply: "Choose features.",
          action: "none",
          wizardInputPending: true,
          step: {
            id: "features",
            type: "multiselect",
            message: "Which features?",
            options: [
              { label: "Chat", value: "chat" },
              { label: "Moderation", value: "moderation" },
              { label: "Announcements", value: "announcements" },
            ],
          },
        });
        await page.getByLabel("Twitch").check();
        expect(await continueButton.evaluate((element) => getComputedStyle(element).cursor)).toBe(
          "default",
        );
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByLabel("Announcements").waitFor();

        await gateway.setMethodResponse("openclaw.chat", {
          sessionId: "e2e-rich-wizard",
          reply: "Enter the secret.",
          action: "none",
          sensitive: true,
          wizardInputPending: true,
          step: {
            id: "secret",
            type: "text",
            message: "Twitch client secret",
            sensitive: true,
          },
        });
        await page.getByLabel("Chat").check();
        await page.getByLabel("Announcements").check();
        await page.getByRole("button", { name: "Continue" }).click();
        const secretInput = page.getByRole("textbox", {
          name: "Twitch client secret",
        });
        await secretInput.waitFor();
        expect(await secretInput.getAttribute("type")).toBe("password");
        await page.getByRole("button", { name: "Reveal value" }).click();
        expect(await secretInput.getAttribute("type")).toBe("text");
        await page.getByRole("button", { name: "Hide value" }).click();
        expect(await secretInput.getAttribute("type")).toBe("password");

        await gateway.setMethodResponse("openclaw.chat", {
          sessionId: "e2e-rich-wizard",
          reply: "Name this connection.",
          action: "none",
          wizardInputPending: true,
          step: {
            id: "label",
            type: "text",
            message: "Connection name",
          },
        });
        await secretInput.fill("fake-client-secret");
        await page.getByRole("button", { name: "Submit" }).click();
        const labelInput = page.getByRole("textbox", { name: "Connection name" });
        await labelInput.waitFor();

        await gateway.deferNext("openclaw.chat");
        await labelInput.fill("Twitch ops");
        await page.getByRole("button", { name: "Submit" }).click();
        await expect
          .poll(async () => (await labelInput.count()) === 0 || (await labelInput.isDisabled()))
          .toBe(true);
        if ((await labelInput.count()) > 0) {
          expect(await labelInput.evaluate((element) => getComputedStyle(element).cursor)).toBe(
            "not-allowed",
          );
        } else {
          expect(
            await page
              .locator(".custodian__structured-response", { hasText: "Twitch ops" })
              .count(),
          ).toBe(1);
        }

        await gateway.resolveDeferred("openclaw.chat", {
          sessionId: "e2e-rich-wizard",
          reply: "Confirm setup.",
          action: "none",
          wizardInputPending: true,
          step: {
            id: "confirm",
            type: "confirm",
            message: "Connect Twitch now?",
          },
        });
        const noButton = page.getByRole("button", { name: "No" });
        const yesButton = page.getByRole("button", { name: "Yes" });
        await noButton.waitFor();

        await gateway.deferNext("openclaw.chat");
        await yesButton.click();
        await expect.poll(() => noButton.isDisabled()).toBe(true);
        await expect.poll(() => yesButton.isDisabled()).toBe(true);
        await expect.poll(() => cancelButton.isDisabled()).toBe(true);
        for (const button of [noButton, yesButton, cancelButton]) {
          const restingStyle = await button.evaluate(readInteractionStyle);
          await button.hover();
          expect(await button.evaluate(readInteractionStyle)).toEqual(restingStyle);
          expect(restingStyle.cursor).toBe("not-allowed");
        }

        await gateway.resolveDeferred("openclaw.chat", {
          sessionId: "e2e-rich-wizard",
          reply: "Setup complete.",
          action: "none",
        });
        await page.getByText("Setup complete.").waitFor();

        const requests = await gateway.getRequests("openclaw.chat");
        expect(requests.map((request) => request.params)).toEqual([
          expect.objectContaining({ sessionId: expect.any(String) }),
          expect.objectContaining({
            wizardAnswer: { stepId: "channel", value: "twitch" },
          }),
          expect.objectContaining({
            wizardAnswer: { stepId: "features", value: ["chat", "announcements"] },
          }),
          expect.objectContaining({
            wizardAnswer: { stepId: "secret", value: "fake-client-secret" },
          }),
          expect.objectContaining({
            wizardAnswer: { stepId: "label", value: "Twitch ops" },
          }),
          expect.objectContaining({
            wizardAnswer: { stepId: "confirm", value: true },
          }),
        ]);
        expect(
          requests
            .slice(1)
            .every(
              (request) =>
                typeof request.params === "object" &&
                request.params !== null &&
                !Object.hasOwn(request.params, "message"),
            ),
        ).toBe(true);
        expect(await page.getByText("Sensitive reply sent").count()).toBe(1);
        expect(await page.getByText("fake-client-secret").count()).toBe(0);
        expect(await page.locator(".agent-chat__composer-shell").count()).toBe(1);
      },
    );
  });

  it("stays silent during onboarding", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
          methodResponses: {
            "openclaw.chat": {
              sessionId: "e2e-onboarding-custodian",
              reply: "Let's finish setup.",
              action: "none",
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
        expect(response?.status()).toBe(200);
        // Onboarding chrome keeps only the header actions; no identity heading.
        await page.locator(".custodian__header--minimal").waitFor();
        await gateway.emitGatewayEvent("health", {
          channelLabels: { telegram: "Telegram" },
          channels: {
            telegram: { configured: true, connected: false, running: true },
          },
        });
        await settleUi(page);
        expect(await page.locator(".custodian__nudge").count()).toBe(0);
      },
    );
  });
});
