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
  it("guides a pending microphone request and clears guidance when voice connects", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": {
            provider: "openai",
            voiceSessionId: "voice-microphone-access-e2e",
            transport: "webrtc",
            clientSecret: "test-client-secret",
          },
        },
      });
      await installMicrophoneLossWebRtcFixture(page);
      await page.addInitScript(() => {
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        let release = () => {};
        const permission = new Promise<void>((resolve) => {
          release = resolve;
        });
        const proof = { requested: false, release: () => release() };
        Object.defineProperty(window, "openclawMicrophoneAccessE2e", { value: proof });
        navigator.mediaDevices.getUserMedia = (constraints) => {
          proof.requested = true;
          return permission.then(() => getUserMedia(constraints));
        };
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { openclawMicrophoneAccessE2e?: { requested: boolean } })
                .openclawMicrophoneAccessE2e?.requested,
          ),
        )
        .toBe(true);
      expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
      await captureMicrophoneLossProof(suite, page, "prepared-input-pending.png");
      const guidance = page.locator('.agent-chat__talk-status[role="status"]');
      await expect
        .poll(() => guidance.allTextContents())
        .toEqual([
          expect.stringContaining(
            "Waiting for microphone access. Bring this tab to the foreground and allow access if prompted.",
          ),
        ]);
      await expect.poll(() => guidance.isVisible()).toBe(true);
      await page.evaluate(() =>
        (
          window as Window & { openclawMicrophoneAccessE2e?: { release: () => void } }
        ).openclawMicrophoneAccessE2e?.release(),
      );
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      await expect.poll(() => guidance.count()).toBe(0);
      expect(await gateway.getRequests("talk.client.create")).toHaveLength(1);
      await captureMicrophoneLossProof(suite, page, "prepared-input-ready.png");
      await page.getByRole("button", { name: "Stop voice input" }).click();
    });
  });

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
        await captureMicrophoneLossProof(suite, page, "microphone-loss-setup-failure.png");
        throw error;
      }
      await captureMicrophoneLossProof(suite, page, "microphone-loss-before-listening.png");

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
      await captureMicrophoneLossProof(suite, page, "microphone-loss-after-error.png");
      await gateway.waitForRequest("talk.client.close");
      await page.getByRole("button", { name: "Dismiss voice input error" }).click();
      console.info(
        "[microphone-loss-e2e] native capture+local peer; injected track ended; visible error; track+peer+audio released",
      );
    });
  });
});
