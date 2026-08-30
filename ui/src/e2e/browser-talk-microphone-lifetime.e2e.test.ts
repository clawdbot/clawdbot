// Native browser lifecycle proof with an injected microphone-ended event.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureMicrophoneLossProof,
  installMicrophoneLossWebRtcFixture,
  type MicrophoneLossE2eProof,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser microphone lifetime",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it("surfaces microphone loss and closes native browser call resources", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": {
            provider: "openai",
            voiceSessionId: "voice-microphone-loss-e2e",
            transport: "webrtc",
            clientSecret: "test-client-secret",
          },
        },
      });
      await installMicrophoneLossWebRtcFixture(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Start voice input" }).click();
      try {
        await expect
          .poll(() =>
            page.evaluate(() => {
              const proof = (
                window as Window & { openclawMicrophoneLossE2e?: MicrophoneLossE2eProof }
              ).openclawMicrophoneLossE2e;
              return {
                status: document
                  .querySelector(".agent-chat__voice-activity")
                  ?.getAttribute("data-status"),
                detail: document.querySelector(".agent-chat__talk-status")?.textContent,
                stage: proof?.stage,
                trackState: proof?.trackState,
                localConnection: proof?.localConnection,
                localIce: proof?.localIce,
                remoteIce: proof?.remoteIce,
                remoteGathering: proof?.remoteGathering,
              };
            }),
          )
          .toMatchObject({ status: "listening" });
      } catch (error) {
        await captureMicrophoneLossProof(page, "microphone-loss-setup-failure.png");
        throw error;
      }
      await captureMicrophoneLossProof(page, "microphone-loss-before-listening.png");

      await page.evaluate(() => {
        (
          window as Window & { openclawMicrophoneLossE2e?: MicrophoneLossE2eProof }
        ).openclawMicrophoneLossE2e?.endMicrophone();
      });

      const alert = page.locator('.agent-chat__talk-status[role="alert"]');
      await expect
        .poll(() => alert.textContent())
        .toContain("Microphone input stopped. Choose an available input and start again.");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const proof = (
              window as Window & { openclawMicrophoneLossE2e?: MicrophoneLossE2eProof }
            ).openclawMicrophoneLossE2e;
            return {
              tracksStopped: proof?.tracksStopped,
              peerClosed: proof?.peerClosed,
              trackState: proof?.trackState,
              audioElements: document.querySelectorAll("audio").length,
            };
          }),
        )
        .toEqual({ tracksStopped: 1, peerClosed: true, trackState: "ended", audioElements: 0 });
      await captureMicrophoneLossProof(page, "microphone-loss-after-error.png");
      await gateway.waitForRequest("talk.client.close");
      await page.getByRole("button", { name: "Dismiss voice input error" }).click();
      console.info(
        "[microphone-loss-e2e] native capture+local peer; injected track ended; visible error; track+peer+audio released",
      );
    });
  });
});
