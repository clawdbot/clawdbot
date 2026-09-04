// Control UI tests cover local-provider recovery against a mocked Gateway.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI local-provider recovery mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("model-setup-recovery", artifactRoot)
    : undefined;
});

suite.define(() => {
  it("shows a failed LM Studio connection with its detected endpoint", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const modelRef = "lmstudio/qwen3-8b-instruct";
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "openclaw.setup.verify",
            "openclaw.setup.prepare.start",
            "wizard.next",
          ],
          methodResponses: {
            "openclaw.setup.detect": {
              candidates: [
                {
                  kind: "provider-auto:lmstudio",
                  brandId: "lmstudio",
                  label: "LM Studio",
                  detail: "qwen3-8b-instruct at http://localhost:1234/v1",
                  modelRef,
                  recommended: false,
                  credentials: true,
                },
              ],
              manualProviders: [],
              prepareOptions: [
                {
                  id: "lmstudio",
                  brandId: "lmstudio",
                  label: "LM Studio",
                  hint: "Connect to a running LM Studio server and use an already loaded model",
                  actionLabel: "Connect server",
                },
              ],
              workspace: "/tmp/openclaw-e2e",
              configuredModel: modelRef,
              setupComplete: true,
            },
            "openclaw.setup.verify": {
              ok: false,
              status: "unavailable",
              error: "connect ECONNREFUSED 127.0.0.1:1234",
            },
            "openclaw.setup.prepare.start": {
              sessionId: "lmstudio-recovery-session",
              done: false,
              status: "running",
            },
            "wizard.next": {
              done: false,
              status: "running",
              step: {
                id: "lmstudio-base-url",
                type: "text",
                message: "LM Studio base URL",
                initialValue: "http://localhost:1234/v1",
              },
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        expect(response?.status()).toBe(200);
        const selectedModel = page.locator(".model-setup__current");
        await selectedModel.getByText("LM Studio", { exact: true }).waitFor();
        await selectedModel.getByRole("button", { name: "Check model" }).click();
        await selectedModel.getByText("qwen3-8b-instruct at http://localhost:1234/v1").waitFor();
        await selectedModel
          .getByText("connect ECONNREFUSED 127.0.0.1:1234", { exact: false })
          .waitFor();
        await selectedModel.getByRole("button", { name: "Try again" }).waitFor();
        await expect.poll(() => selectedModel.getByText("Change connection").count()).toBe(0);
        await expect
          .poll(() => page.locator('[data-candidate-kind="provider-auto:lmstudio"]').count())
          .toBe(0);

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "local-provider-failure-desktop.png"),
          });
          await page.setViewportSize({ height: 844, width: 390 });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "local-provider-failure-mobile.png"),
          });
        }

        const verify = await gateway.waitForRequest("openclaw.setup.verify");
        expect(verify.params).toEqual({ agentId: "main" });
      },
    );
  });
});
