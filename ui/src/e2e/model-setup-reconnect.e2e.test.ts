// Browser proof that model setup reloads after a same-client Gateway reconnect.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI model setup same-client reconnect",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "model-setup-reconnect",
);

function detection(modelRef: string) {
  return {
    candidates: [],
    manualProviders: [],
    configuredModel: modelRef,
    setupComplete: true,
    workspace: "/tmp/openclaw-e2e",
  };
}

suite.define(() => {
  it("re-detects once and replaces stale visible model state after reconnect", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          featureMethods: ["openclaw.setup.detect"],
          methodResponses: { "openclaw.setup.detect": detection("provider/original-model") },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        expect(response?.status()).toBe(200);
        await page.getByText("original-model", { exact: true }).waitFor();
        const initialDetections = (await gateway.getRequests("openclaw.setup.detect")).length;
        const initialConnections = (await gateway.getRequests("connect")).length;
        await gateway.setMethodResponse(
          "openclaw.setup.detect",
          detection("provider/reconnected-model"),
        );
        await gateway.deferNext("connect");
        await gateway.closeLatest(1012, "model setup reconnect proof");
        await expect
          .poll(async () => page.getByText("original-model", { exact: true }).count())
          .toBe(0);
        await expect
          .poll(async () => (await gateway.getRequests("connect")).length)
          .toBeGreaterThan(initialConnections);
        await gateway.resolveDeferred("connect");
        await expect
          .poll(async () => (await gateway.getRequests("openclaw.setup.detect")).length)
          .toBe(initialDetections + 1);
        await page.getByText("reconnected-model", { exact: true }).waitFor();
        expect(pageErrors).toEqual([]);

        if (captureUiProofEnabled) {
          await mkdir(artifactDir, { recursive: true });
          await page.locator("openclaw-model-setup-page").screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "00-reconnected-model-visible.png"),
          });
        }
      },
    );
  });
});
