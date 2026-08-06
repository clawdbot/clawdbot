// Control UI tests cover local-provider recovery against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI local-provider recovery mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows a failed LM Studio connection with its detected endpoint", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup`);
      expect(response?.status()).toBe(200);
      const selectedModel = page.locator(".model-setup__current");
      await selectedModel.getByText("LM Studio", { exact: true }).waitFor();
      await selectedModel.getByRole("button", { name: "Check model" }).click();
      await selectedModel.getByText("qwen3-8b-instruct at http://localhost:1234/v1").waitFor();
      await selectedModel.getByText("LM Studio isn’t responding.").waitFor();
      await selectedModel.getByRole("button", { name: "Try again" }).waitFor();
      await expect.poll(() => selectedModel.getByText("Change connection").count()).toBe(0);
      await expect
        .poll(() => page.locator('[data-candidate-kind="provider-auto:lmstudio"]').count())
        .toBe(0);

      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
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
      expect(verify.params).toEqual({});
    } finally {
      await context.close();
    }
  });
});
