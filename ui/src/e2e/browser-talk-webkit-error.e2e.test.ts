// Control UI E2E coverage for legacy WebKit media errors.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureComposerProof } from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI browser Talk WebKit errors" });

suite.define(() => {
  it("renders legacy WebKit overconstraints as actionable microphone guidance", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "talk.client.create": {
            provider: "openai",
            transport: "gateway-relay",
            relaySessionId: "relay-webkit-overconstraint-e2e",
            audio: {
              inputEncoding: "pcm16",
              inputSampleRateHz: 16_000,
              outputEncoding: "pcm16",
              outputSampleRateHz: 24_000,
            },
          },
          "talk.session.close": {},
        },
      });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            enumerateDevices: async () => [
              { kind: "audioinput", deviceId: "usb", label: "USB Microphone" },
            ],
            getUserMedia: async () => {
              throw Object.assign(new Error("Invalid constraint"), {
                name: "OverconstrainedError",
                constraint: "",
              });
            },
          },
        });
      });

      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-microphone]").selectOption("usb");
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Tap to talk" }).click();
      await gateway.waitForRequest("talk.client.create");

      await expect
        .poll(() => page.getByRole("alert").locator(".agent-chat__talk-status-text").textContent())
        .toBe("The selected microphone is unavailable. Choose another input or System default.");
      await expect
        .poll(() => gateway.getRequests("talk.session.close").then((requests) => requests.length))
        .toBe(1);
      await captureComposerProof(page, "webkit-selected-microphone-unavailable-composer.png");
      await page.getByRole("alert").screenshot({
        path: ".artifacts/control-ui-e2e/voice-controls/webkit-selected-microphone-alert.png",
      });
    });
  });
});
