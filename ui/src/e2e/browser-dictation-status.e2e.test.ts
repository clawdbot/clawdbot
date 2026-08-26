// Control UI E2E tests cover visible browser dictation state through a real composer.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureComposerProof,
  installTalkBrowserFixtures,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser dictation status",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it("keeps dictation activity, elapsed time, Stop, and Send visible", async () => {
    await suite.withPage(
      { permissions: ["microphone"], viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "talk.catalog": {
              transcription: { ready: true, providers: [] },
              realtime: { providers: [] },
              speech: { providers: [] },
              modes: [],
              transports: [],
              brains: [],
            },
            "talk.session.create": {
              sessionId: "dictation-browser-proof",
              transcriptionSessionId: "dictation-browser-proof",
              audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
            },
          },
        });
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}chat`);

        const microphone = page.getByRole("button", { name: "Start voice input" });
        const microphoneBox = await microphone.boundingBox();
        expect(microphoneBox).not.toBeNull();
        if (!microphoneBox) {
          throw new Error("expected microphone layout box");
        }
        await page.mouse.move(
          microphoneBox.x + microphoneBox.width / 2,
          microphoneBox.y + microphoneBox.height / 2,
        );
        await page.mouse.down();
        await gateway.waitForRequest("talk.session.create");

        const composer = page.locator(".agent-chat__input--dictating");
        const activity = composer.locator(
          ".agent-chat__dictation-wave .agent-chat__voice-activity",
        );
        const elapsed = composer.locator(".agent-chat__dictation-elapsed");
        const stop = composer.getByRole("button", { name: "Stop dictation" });
        const send = composer.getByRole("button", { name: "Send message" });
        await expect.poll(() => activity.isVisible()).toBe(true);
        expect(await activity.locator(".agent-chat__voice-activity-bar").count()).toBe(48);
        await expect.poll(() => elapsed.textContent()).toBe("0:01");
        await expect.poll(() => stop.isVisible()).toBe(true);
        await expect.poll(() => send.isVisible()).toBe(true);
        await captureComposerProof(page, "dictation-waveform-timer-actions.png");
        const composerBox = await composer.boundingBox();
        expect(composerBox).not.toBeNull();
        if (!composerBox) {
          throw new Error("expected active dictation composer layout box");
        }
        for (const control of [activity, elapsed, stop, send]) {
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          if (!box) {
            throw new Error("expected visible dictation control layout box");
          }
          expect(box.x).toBeGreaterThanOrEqual(composerBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
        }

        await page.keyboard.press("Escape");
        await expect.poll(() => microphone.isVisible()).toBe(true);
      },
    );
  });
});
