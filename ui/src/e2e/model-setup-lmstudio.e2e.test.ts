// Control UI tests cover LM Studio setup against a mocked Gateway.
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
const prepareOptions = [
  {
    id: "lmstudio",
    brandId: "lmstudio",
    label: "LM Studio",
    hint: "Connect to a running LM Studio server and use an already loaded model",
    icon: "https://cdn.simpleicons.org/lmstudio",
    website: "https://lmstudio.ai/download",
  },
];

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI LM Studio setup mocked Gateway E2E", () => {
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

  it("connects, retries, verifies, and keeps LM Studio visible in settings", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const initialDetection = {
      candidates: [],
      manualProviders: [],
      prepareOptions,
      workspace: "/tmp/openclaw-e2e",
      setupComplete: false,
    };
    const modelRef = "lmstudio/qwen3-8b-instruct";
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "openclaw.setup.detect",
        "openclaw.setup.activate",
        "openclaw.setup.prepare.start",
        "wizard.next",
      ],
      methodResponses: {
        "openclaw.setup.detect": initialDetection,
        "openclaw.setup.prepare.start": {
          sessionId: "lmstudio-prepare-session",
          done: false,
          status: "running",
        },
        "openclaw.setup.activate": {
          ok: true,
          modelRef,
          latencyMs: 416,
          lines: ["Model ready"],
        },
        "wizard.next": {
          sequence: [
            {
              done: false,
              status: "running",
              step: {
                id: "lmstudio-base-url",
                type: "text",
                message: "LM Studio base URL",
                initialValue: "http://localhost:1234/v1",
              },
            },
            {
              done: false,
              status: "running",
              step: {
                id: "lmstudio-api-key",
                type: "text",
                message: "LM Studio API key",
                placeholder: "Leave blank if auth is disabled",
                sensitive: true,
              },
            },
            {
              done: false,
              status: "running",
              step: {
                id: "lmstudio-retry",
                type: "note",
                title: "LM Studio",
                message: [
                  "LM Studio could not be reached at http://localhost:1234/v1.",
                  "Start LM Studio (or run lms server start), then continue to retry.",
                ].join("\n"),
              },
            },
            {
              done: false,
              status: "running",
              step: {
                id: "lmstudio-retry-confirm",
                type: "confirm",
                message: "Retry this LM Studio connection now?",
                initialValue: true,
              },
            },
            { done: true, status: "done" },
          ],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup`);
      expect(response?.status()).toBe(200);
      const lmStudioRow = page.locator('[data-prepare-choice="lmstudio"]');
      await lmStudioRow.getByRole("button", { name: "Check & set up" }).waitFor();
      await expect
        .poll(() => lmStudioRow.locator('[data-provider-icon="lmstudio"]').count())
        .toBe(1);

      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "lmstudio-offer-desktop.png"),
        });
      }

      await lmStudioRow.getByRole("button", { name: "Check & set up" }).click();
      const start = await gateway.waitForRequest("openclaw.setup.prepare.start");
      expect(start.params).toMatchObject({ authChoice: "lmstudio" });
      await expect
        .poll(() => page.getByLabel("LM Studio base URL").inputValue())
        .toBe("http://localhost:1234/v1");
      await page.getByRole("button", { name: "Submit" }).click();
      await page.getByLabel("LM Studio API key").fill("");
      await page.getByRole("button", { name: "Submit" }).click();
      await page.getByText("LM Studio could not be reached at http://localhost:1234/v1.").waitFor();

      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "lmstudio-recovery-desktop.png"),
        });
      }

      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("Retry this LM Studio connection now?").waitFor();
      await gateway.setMethodResponse("openclaw.setup.detect", {
        ...initialDetection,
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
      });
      await page.getByRole("button", { name: "Yes" }).click();
      await page.getByRole("heading", { name: "Connection verified" }).waitFor();
      await expect
        .poll(() => page.locator(".model-setup-success").textContent())
        .toContain(modelRef);
      await expect
        .poll(() => page.locator(".model-setup-success").textContent())
        .toContain("Verified in 416 ms");
      await expect
        .poll(() => page.locator('.model-setup-success [data-provider-icon="lmstudio"]').count())
        .toBe(1);

      const activate = await gateway.waitForRequest("openclaw.setup.activate");
      expect(activate.params).toEqual({
        kind: "provider-auto:lmstudio",
        modelRef,
      });

      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "lmstudio-ready-desktop.png"),
        });
        await page.setViewportSize({ height: 844, width: 390 });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "lmstudio-ready-mobile.png"),
        });
      }

      await gateway.setMethodResponse("openclaw.setup.detect", {
        ...initialDetection,
        candidates: [],
        configuredModel: modelRef,
        setupComplete: true,
      });
      await page.setViewportSize({ height: 900, width: 1280 });
      await page.getByRole("button", { name: "Stay in settings" }).click();
      const currentConnection = page.locator(".model-setup__current");
      await currentConnection.getByText(modelRef, { exact: true }).waitFor();
      await expect
        .poll(() => currentConnection.locator('[data-provider-icon="lmstudio"]').count())
        .toBe(1);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "lmstudio-main-desktop.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
