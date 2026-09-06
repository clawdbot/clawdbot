// Real Chromium UI and local WebRTC peer; injected legacy WebKit acquisition failure.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureMicrophoneLossProof,
  installMicrophoneLossWebRtcFixture,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser Talk WebKit errors",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it.each(["dismiss", "accept", "denied"] as const)(
    "requires explicit consent for system-default recovery (%s)",
    async (decision) => {
      await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "talk.catalog": videoTalkCatalog("openai"),
            "talk.client.create": {
              provider: "openai",
              voiceSessionId: "voice-consent-e2e",
              transport: "webrtc",
              clientSecret: "test-client-secret",
            },
          },
        });
        await installMicrophoneLossWebRtcFixture(page);
        await page.addInitScript(
          ({ denyDefault }) => {
            const requests: MediaStreamConstraints[] = [];
            const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.enumerateDevices = async () => [
              {
                kind: "audioinput",
                deviceId: "usb",
                label: "USB Microphone",
                groupId: "",
                toJSON: () => ({}),
              },
            ];
            navigator.mediaDevices.getUserMedia = async (request) => {
              requests.push(request ?? {});
              if (typeof request?.audio === "object" && request.audio.deviceId) {
                throw Object.assign(new Error("Invalid constraint"), {
                  name: "OverconstrainedError",
                  constraint: "",
                });
              }
              if (denyDefault) {
                throw new DOMException("denied", "NotAllowedError");
              }
              return getUserMedia(request);
            };
            Object.defineProperty(window, "openclawWebKitVoiceConstraints", { value: requests });
          },
          { denyDefault: decision === "denied" },
        );
        const requests = () =>
          page.evaluate(
            () =>
              (window as Window & { openclawWebKitVoiceConstraints?: MediaStreamConstraints[] })
                .openclawWebKitVoiceConstraints,
          );
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await page.locator("[data-settings-microphone]").selectOption("usb");
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
        const alert = page.locator('.agent-chat__talk-status[role="alert"]');
        await expect
          .poll(() => alert.textContent())
          .toContain("The selected microphone is unavailable");
        const recovery = page.getByRole("button", {
          name: "Use System default for this call",
          exact: true,
        });
        await expect.poll(() => recovery.isVisible()).toBe(true);
        expect(await requests()).toEqual([
          {
            audio: {
              autoGainControl: true,
              deviceId: { exact: "usb" },
              echoCancellation: true,
              noiseSuppression: true,
            },
          },
        ]);
        expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
        expect(await gateway.getRequests("talk.session.create")).toHaveLength(0);
        await captureMicrophoneLossProof(suite, page, "consent-before-choice.png");
        if (decision === "dismiss") {
          const retiredButton = await recovery.elementHandle();
          await page.getByRole("button", { name: "Dismiss voice input error" }).click();
          await expect.poll(() => alert.count()).toBe(0);
          // A queued activation of the retired control cannot regain consent.
          await retiredButton!.evaluate((button) => (button as HTMLButtonElement).click());
          await retiredButton!.dispose();
          expect(await requests()).toHaveLength(1);
          expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
          expect(await gateway.getRequests("talk.session.create")).toHaveLength(0);
          await captureMicrophoneLossProof(suite, page, "consent-dismissed.png");
        } else {
          // Use a real pointer activation; the owner unit test covers the
          // pre-render double-click race, and this checks stale DOM activation.
          const retiredButton = await recovery.elementHandle();
          await recovery.click();
          await retiredButton!.evaluate((button) => (button as HTMLButtonElement).click());
          await retiredButton!.dispose();
          if (decision === "denied") {
            await expect.poll(() => alert.textContent()).toContain("Microphone access is blocked");
            expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
            expect(await gateway.getRequests("talk.session.create")).toHaveLength(0);
          } else {
            await expect
              .poll(() =>
                page.locator('.agent-chat__voice-activity[data-status="listening"]').count(),
              )
              .toBe(1);
            expect(await gateway.getRequests("talk.client.create")).toHaveLength(1);
          }
          expect(await requests()).toEqual([
            {
              audio: {
                autoGainControl: true,
                deviceId: { exact: "usb" },
                echoCancellation: true,
                noiseSuppression: true,
              },
            },
            { audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } },
          ]);
          await expect.poll(() => recovery.count()).toBe(0);
          await captureMicrophoneLossProof(
            suite,
            page,
            decision === "accept" ? "consent-call-listening.png" : "consent-default-denied.png",
          );
          if (decision === "accept") {
            await page.getByRole("button", { name: "Stop voice input" }).click();
            await gateway.waitForRequest("talk.client.close");
          }
        }
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await expect
          .poll(() => page.locator("[data-settings-microphone]").inputValue())
          .toBe("usb");
        await captureMicrophoneLossProof(suite, page, "consent-preference-preserved.png");
      });
    },
  );
});
