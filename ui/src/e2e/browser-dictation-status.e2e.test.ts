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
  it("keeps the hold-to-dictate switch interactive without closing the microphone picker", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": {
            transcription: { ready: true, providers: [] },
            realtime: { ready: true, providers: [] },
            speech: { providers: [] },
            modes: [],
            transports: [],
            brains: [],
          },
        },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const voice = page.getByRole("button", { name: "Start voice input" });
      await voice.hover();
      await page.getByRole("button", { name: "Microphone input" }).click();
      const picker = page.locator("wa-dropdown.chat-talk-input-picker");
      const toggle = page.locator('.chat-talk-input-picker__preference [role="switch"]');
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");

      await toggle.click();

      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
      await captureComposerProof(page, "microphone-picker-hold-toggle.png");
      await page.screenshot({
        animations: "disabled",
        path: ".artifacts/control-ui-e2e/voice-controls/microphone-picker-hold-toggle-full.png",
      });
    });
  });

  it("gates unavailable voice capabilities in the microphone picker", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": {
            transcription: { ready: false, providers: [] },
            realtime: { ready: false, providers: [] },
            speech: { providers: [] },
            modes: [],
            transports: [],
            brains: [],
          },
        },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      await page.getByRole("button", { name: "Start voice input" }).click();
      await expect.poll(() => page.locator('[data-status="unavailable"]').count()).toBe(2);
      await expect.poll(() => page.getByRole("button", { name: "Talk settings" }).count()).toBe(1);
      await expect
        .poll(() => page.getByRole("button", { name: "Transcription setup" }).count())
        .toBe(1);
      await captureComposerProof(page, "microphone-picker-capability-gating.png");
      await page.screenshot({
        animations: "disabled",
        path: ".artifacts/control-ui-e2e/voice-controls/microphone-picker-capability-gating-full.png",
      });
    });
  });

  it("keeps dictation activity and the insert/discard actions visible", async () => {
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
        await page.waitForTimeout(350);
        await expect
          .poll(() => microphone.getAttribute("class"))
          .toContain("chat-send-btn--dictation-arming");
        await page.screenshot({
          animations: "allow",
          path: ".artifacts/control-ui-e2e/voice-controls/dictation-hold-ring.png",
        });
        await gateway.waitForRequest("talk.session.create");
        await page.mouse.up();

        const composer = page.locator(".agent-chat__input--dictating");
        const phase = composer.locator(".agent-chat__dictation-phase");
        const discard = composer.getByRole("button", { name: "Cancel and discard dictation" });
        const insert = composer.getByRole("button", { name: "Stop and insert dictation" });
        await expect.poll(() => phase.isVisible()).toBe(true);
        await expect.poll(() => phase.textContent()).toBe("Listening…");
        expect(await composer.locator(".agent-chat__dictation-wave").count()).toBe(0);
        expect(await composer.locator(".agent-chat__dictation-elapsed").count()).toBe(0);
        await expect.poll(() => discard.isVisible()).toBe(true);
        await expect.poll(() => insert.isVisible()).toBe(true);
        await captureComposerProof(page, "dictation-status-actions.png");
        await page.screenshot({
          animations: "disabled",
          path: ".artifacts/control-ui-e2e/voice-controls/dictation-latched-after-release.png",
        });
        const composerBox = await composer.boundingBox();
        expect(composerBox).not.toBeNull();
        if (!composerBox) {
          throw new Error("expected active dictation composer layout box");
        }
        for (const control of [phase, discard, insert]) {
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
