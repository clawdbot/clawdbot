// Control UI tests cover event-reactive custodian presence against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI custodian event nudge mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "custodian-event-nudge",
);

async function settleUi(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

suite.define(() => {
  it("shows one consequential nudge and sends its canonical message", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
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
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
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
        await page.getByLabel("Twitch").waitFor();
        expect(await page.locator("openclaw-option-card").count()).toBe(0);
        expect(await page.locator(".agent-chat__composer-shell").count()).toBe(0);

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
          reply: "Setup complete.",
          action: "none",
        });
        await secretInput.fill("fake-client-secret");
        await page.getByRole("button", { name: "Submit" }).click();
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
        await page.getByRole("heading", { name: "OpenClaw", exact: true }).waitFor();
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
