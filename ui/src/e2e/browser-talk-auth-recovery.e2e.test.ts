import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  installTalkBrowserFixtures,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Talk auth recovery" });

suite.define(() => {
  it("recovers Auto with inactive legacy auth but keeps an active strict restart fail-closed", async () => {
    const artifactDir = createControlUiE2eArtifactDir("talk-auth-recovery");
    const viewport = { width: 1366, height: 900 };
    await suite.withPage(
      { permissions: ["microphone"], viewport, recordVideo: { dir: artifactDir, size: viewport } },
      async ({ page }) => {
        const relaySessionId = "relay-auth-recovery";
        const clientError = "Synthetic client transport unavailable";
        const gateway = await installMockGateway(page, {
          agentModel: "synthetic-chat",
          models: [{ id: "synthetic-chat", name: "Synthetic chat", provider: "example" }],
          methodResponses: {
            "talk.catalog": videoTalkCatalog("openai"),
            // Actual talk.config projection: the Google auth row is inherited
            // from voice-call, not an invalid Talk-local strict selection.
            "talk.config": {
              config: {
                talk: {
                  realtime: {
                    provider: "openai",
                    providers: { google: { authMethod: "api-key" }, openai: {} },
                  },
                },
              },
            },
            "talk.session.create": {
              provider: "openai",
              transport: "gateway-relay",
              relaySessionId,
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
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        const start = page.getByRole("button", { name: "Start voice input" });
        await start.waitFor({ state: "visible" });
        const capture = async (name: string) =>
          writeFile(
            path.join(artifactDir, name),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator(".agent-chat__composer-shell"),
            ]),
          );
        await capture("ready.png");
        try {
          await gateway.deferNext("talk.client.create");
          await start.click();
          await gateway.waitForRequest("talk.client.create");
          await gateway.rejectDeferred("talk.client.create", {
            code: "UNAVAILABLE",
            message: clientError,
          });
          const relay = await gateway.waitForRequest("talk.session.create");
          expect(relay.params).toMatchObject({
            mode: "realtime",
            transport: "gateway-relay",
            brain: "agent-consult",
          });
          expect(relay.params).not.toHaveProperty("capabilities");
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (window as Window & { openclawTalkE2eState?: { inputProcessor?: unknown } })
                    .openclawTalkE2eState?.inputProcessor != null,
              ),
            )
            .toBe(true);
          await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });
          await expect
            .poll(() =>
              page.locator('.agent-chat__voice-activity[data-status="listening"]').count(),
            )
            .toBe(1);
          await capture("auto-listening.png");
          await page.getByRole("button", { name: "Stop voice input" }).click();
          await gateway.waitForRequest("talk.session.close");
          await expect.poll(() => start.isVisible()).toBe(true);
          await gateway.setMethodResponse("talk.config", {
            config: {
              talk: {
                realtime: { provider: "openai", providers: { openai: { authMethod: "oauth" } } },
              },
            },
          });
          const creates = (await gateway.getRequests("talk.client.create")).length;
          await gateway.deferNext("talk.client.create");
          await start.click();
          await gateway.waitForRequest("talk.client.create", { after: creates });
          await gateway.rejectDeferred("talk.client.create", {
            code: "UNAVAILABLE",
            message: clientError,
          });
          await expect.poll(() => page.getByRole("alert").textContent()).toContain(clientError);
          expect(await gateway.getRequests("talk.session.create")).toHaveLength(1);
          expect(await gateway.getRequests("talk.session.close")).toHaveLength(1);
          await expect
            .poll(() =>
              page
                .evaluate(
                  () =>
                    (
                      window as Window & {
                        openclawTalkE2eState?: {
                          tracksStopped: number;
                          audioContextsClosed: number;
                        };
                      }
                    ).openclawTalkE2eState,
                )
                .then((state) => ({
                  stopped: state?.tracksStopped,
                  closed: state?.audioContextsClosed,
                })),
            )
            .toEqual({ stopped: 2, closed: 2 });
        } finally {
          await capture("outcome.png");
          const traffic = (await gateway.getRequests()).filter((request) =>
            request.method.startsWith("talk."),
          );
          await writeFile(
            path.join(artifactDir, "requests.json"),
            JSON.stringify(traffic, null, 2),
          );
        }
      },
    );
  });
});
