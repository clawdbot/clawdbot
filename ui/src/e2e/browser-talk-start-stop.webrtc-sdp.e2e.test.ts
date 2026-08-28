// Control UI E2E tests cover WebRTC SDP response handling through a real page.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureWebRtcSdpAlertProof,
  installOversizedWebRtcSdpFixture,
  installWebRtcSdpFailureFixture,
  type WebRtcSdpE2eProof,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser Talk WebRTC SDP responses",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it("cancels a failed OpenAI WebRTC SDP response body in the live Control UI", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": {
            provider: "openai",
            voiceSessionId: "voice-openai-sdp-error-e2e",
            transport: "webrtc",
            clientSecret: "test-client-secret",
            offerUrl: "https://api.openai.com/v1/realtime/calls",
            offerResponseMaxBytes: 256 * 1024,
          },
        },
      });
      await installWebRtcSdpFailureFixture(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.locator('[data-chat-talk-capability="realtime"]').count())
        .toBe(0);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");

      const alert = page.locator('.agent-chat__talk-status[role="alert"]');
      await expect.poll(() => alert.textContent()).toContain("Realtime WebRTC setup failed (502)");
      await captureWebRtcSdpAlertProof(page, "01-http-failure-alert.png");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { openclawWebRtcSdpE2e?: WebRtcSdpE2eProof })
                .openclawWebRtcSdpE2e,
          ),
        )
        .toEqual({
          bodyCancelCount: 1,
          bodyCancelResolvedCount: 1,
          fetchCount: 1,
          remoteDescriptionCount: 0,
          statuses: [502],
        });
      console.info(
        `[webrtc-sdp-e2e] trigger=OpenAI WebRTC offer; transition=status:error+502; ` +
          `body.cancel=1/resolved; outcome=visible setup failure`,
      );
    });
  });

  it("rejects and cancels an oversized OpenAI SDP answer before peer setup", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": {
            provider: "openai",
            voiceSessionId: "voice-openai-sdp-oversized-e2e",
            transport: "webrtc",
            clientSecret: "test-client-secret",
            offerUrl: "https://api.openai.com/v1/realtime/calls",
            offerResponseMaxBytes: 256 * 1024,
          },
        },
      });
      await installOversizedWebRtcSdpFixture(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.locator('[data-chat-talk-capability="realtime"]').count())
        .toBe(0);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");

      const alert = page.locator('.agent-chat__talk-status[role="alert"]');
      await expect
        .poll(() => alert.textContent())
        .toContain("Realtime WebRTC SDP answer: text response exceeds 262144 bytes");
      await captureWebRtcSdpAlertProof(page, "02-oversized-answer-alert.png");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { openclawWebRtcSdpE2e?: WebRtcSdpE2eProof })
                .openclawWebRtcSdpE2e,
          ),
        )
        .toEqual({
          bodyCancelCount: 1,
          bodyCancelResolvedCount: 1,
          fetchCount: 1,
          remoteDescriptionCount: 0,
          statuses: [200],
        });
      console.info(
        `[webrtc-sdp-e2e] trigger=oversized OpenAI SDP answer; ` +
          `body.cancel=1/resolved; remote-description=0; outcome=visible size failure`,
      );
    });
  });
});
