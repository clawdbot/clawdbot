import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI realtime voice multimodal composer",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "voice-multimodal");
const captureVideo = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function captureMobileProof(page: import("playwright").Page, fileName: string) {
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(proofDir, fileName) });
  if (captureVideo) {
    // Proof-only pacing makes each verified state readable in the attached clip.
    await page.waitForTimeout(650);
  }
}

suite.define(() => {
  it("keeps voice live while sending text and an attachment", async () => {
    await suite.withPage(
      {
        permissions: ["microphone"],
        recordVideo: captureVideo
          ? { dir: path.join(proofDir, "video"), size: { width: 390, height: 844 } }
          : undefined,
        viewport: { width: 390, height: 844 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["chat.send"],
          methodResponses: {
            "talk.client.create": {
              provider: "google",
              voiceSessionId: "voice-multimodal-e2e",
              transport: "provider-websocket",
              protocol: "google-live-bidi",
              clientSecret: ["auth_tokens", "voice-multimodal-e2e"].join("/"),
              websocketUrl:
                "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
              audio: {
                inputEncoding: "pcm16",
                inputSampleRateHz: 16_000,
                outputEncoding: "pcm16",
                outputSampleRateHz: 24_000,
              },
            },
          },
        });
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}chat`);

        await captureMobileProof(page, "00-mobile-idle.png");
        await page.getByRole("button", { name: "Tap to talk" }).click();
        await gateway.waitForRequest("talk.client.create");
        await gateway.deliverLatest({ setupComplete: {} });

        const stopVoice = page.getByRole("button", { name: "Stop voice input" });
        await expect.poll(() => stopVoice.isVisible()).toBe(true);
        const voiceCanvas = page.getByRole("region", { name: "Voice conversation" });
        await expect.poll(() => voiceCanvas.isVisible()).toBe(true);
        await expect.poll(() => voiceCanvas.getByText("Listening...").isVisible()).toBe(true);
        await expect
          .poll(() => voiceCanvas.locator("img").evaluate((img: HTMLImageElement) => img.complete))
          .toBe(true);
        const mobileLayout = await page.evaluate(() => {
          const canvas = document.querySelector<HTMLElement>(".agent-chat__voice-canvas");
          const composer = document.querySelector<HTMLElement>(".agent-chat__input--voice-active");
          if (!canvas || !composer) {
            throw new Error("expected active mobile voice layout");
          }
          const canvasRect = canvas.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          return {
            canvas: { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width },
            composer: {
              bottom: composerRect.bottom,
              left: composerRect.left,
              right: composerRect.right,
            },
            viewport: { height: window.innerHeight, width: window.innerWidth },
          };
        });
        expect(mobileLayout.canvas).toEqual({ left: 0, top: 0, width: 390 });
        expect(mobileLayout.composer.left).toBeGreaterThanOrEqual(0);
        expect(mobileLayout.composer.right).toBeLessThanOrEqual(mobileLayout.viewport.width);
        expect(mobileLayout.composer.bottom).toBeLessThanOrEqual(mobileLayout.viewport.height);
        await captureMobileProof(page, "01-mobile-voice-canvas.png");

        await page.getByRole("button", { name: "Add attachment" }).click();
        await expect.poll(() => page.getByText("Add to message").isVisible()).toBe(true);
        await expect.poll(() => page.getByText("Choose from library").isVisible()).toBe(true);
        await captureMobileProof(page, "02-mobile-attachment-sheet.png");
        await page.keyboard.press("Escape");

        const textarea = page.locator(".agent-chat__input textarea");
        await textarea.fill("What's in this photo?");
        const send = page.getByRole("button", { name: "Send message" });
        await expect.poll(() => send.isVisible()).toBe(true);
        await page
          .locator(".agent-chat__file-input")
          .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
        await expect.poll(() => page.locator(".chat-attachments-preview").isVisible()).toBe(true);
        await captureMobileProof(page, "03-mobile-draft-and-attachment.png");

        await expect.poll(() => send.isVisible()).toBe(true);
        await send.click();
        const sendRequest = await gateway.waitForRequest("chat.send");
        expect(sendRequest.params).toMatchObject({
          message: "What's in this photo?",
          attachments: [
            expect.objectContaining({ fileName: "favicon-32.png", mimeType: "image/png" }),
          ],
        });
        await expect.poll(() => stopVoice.isVisible()).toBe(true);
        const runId = String(
          typeof sendRequest.params === "object" &&
            sendRequest.params !== null &&
            "idempotencyKey" in sendRequest.params
            ? sendRequest.params.idempotencyKey
            : "",
        );
        await gateway.resolveDeferred("chat.send", { runId, status: "started" });
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
        await expect
          .poll(() => page.getByRole("button", { name: "Stop generating" }).isVisible())
          .toBe(true);
        await captureMobileProof(page, "04-mobile-voice-and-active-run.png");
        await stopVoice.click();
        await expect.poll(() => voiceCanvas.isVisible()).toBe(false);
      },
    );
  });
});
