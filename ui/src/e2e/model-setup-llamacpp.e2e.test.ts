// Control UI tests cover llama.cpp setup against a mocked Gateway.
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
    id: "ollama",
    brandId: "ollama",
    label: "Ollama",
    hint: "Connect to an Ollama server and select a cloud or local model",
    actionLabel: "Choose connection",
  },
  {
    id: "llama-cpp",
    brandId: "llama-cpp",
    label: "llama.cpp",
    hint: "Run one private GGUF model directly inside this Gateway",
    actionLabel: "Set up model",
  },
  {
    id: "lmstudio",
    brandId: "lmstudio",
    label: "LM Studio",
    hint: "Connect to a running LM Studio server and use an already loaded model",
    actionLabel: "Connect server",
    icon: "https://cdn.simpleicons.org/lmstudio",
    website: "https://lmstudio.ai/download",
  },
];

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI llama.cpp setup mocked Gateway E2E", () => {
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

  it("downloads, verifies, and keeps llama.cpp visible in settings", async () => {
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
    const modelRef = "llama-cpp/gemma-4-e4b-it-q4_k_m";
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
          sessionId: "llama-cpp-prepare-session",
          done: false,
          status: "running",
        },
        "openclaw.setup.activate": {
          ok: true,
          modelRef,
          latencyMs: 731,
          lines: ["Model ready"],
        },
        "wizard.next": {
          sequence: [
            {
              done: false,
              status: "running",
              step: {
                id: "llama-cpp-consent",
                type: "confirm",
                message:
                  "OpenClaw will download Gemma 4 E4B IT Q4_K_M (about 5.0 GB) and run it directly inside this Gateway. Continue?",
                initialValue: false,
              },
            },
            {
              done: false,
              status: "running",
              step: {
                id: "llama-cpp-download-20",
                type: "progress",
                message: "Downloading Gemma 4 E4B… 20% (1.0/5.0 GB, 38 MB/s)",
                executor: "gateway",
              },
            },
            {
              done: false,
              status: "running",
              step: {
                id: "llama-cpp-download-100",
                type: "progress",
                message: "Gemma 4 E4B model downloaded",
                executor: "gateway",
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
      const llamaCppRow = page.locator('[data-prepare-choice="llama-cpp"]');
      await llamaCppRow.getByRole("button", { name: "Set up model" }).waitFor();
      await expect
        .poll(() => llamaCppRow.locator('[data-provider-icon="llamacpp"]').count())
        .toBe(1);
      await expect.poll(() => llamaCppRow.textContent()).not.toContain("Gemma");
      await expect.poll(() => llamaCppRow.textContent()).not.toContain("GB");
      await expect.poll(() => llamaCppRow.textContent()).not.toContain("RAM");

      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "llama-cpp-offer-desktop.png"),
        });
      }

      await llamaCppRow.getByRole("button", { name: "Set up model" }).click();
      const start = await gateway.waitForRequest("openclaw.setup.prepare.start");
      expect(start.params).toMatchObject({ authChoice: "llama-cpp" });
      await page.getByRole("heading", { name: "Set up a local model" }).waitFor();
      await page.getByText("OpenClaw will download Gemma 4 E4B IT Q4_K_M").waitFor();

      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "llama-cpp-confirm-desktop.png"),
        });
      }

      await gateway.setMethodResponse("openclaw.setup.detect", {
        ...initialDetection,
        candidates: [
          {
            kind: "provider-auto:llama-cpp",
            brandId: "llama-cpp",
            label: "llama.cpp",
            detail: "Gemma 4 E4B downloaded",
            modelRef,
            recommended: true,
            credentials: true,
          },
        ],
      });
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("heading", { name: "Connection verified" }).waitFor();
      await expect
        .poll(() => page.locator(".model-setup-success").textContent())
        .toContain(modelRef);
      await expect
        .poll(() => page.locator(".model-setup-success").textContent())
        .toContain("Verified in 731 ms");
      await expect
        .poll(() => page.locator('.model-setup-success [data-provider-icon="llamacpp"]').count())
        .toBe(1);

      const activate = await gateway.waitForRequest("openclaw.setup.activate");
      expect(activate.params).toEqual({
        kind: "provider-auto:llama-cpp",
        modelRef,
      });

      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "llama-cpp-ready-desktop.png"),
        });
        await page.setViewportSize({ height: 844, width: 390 });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "llama-cpp-ready-mobile.png"),
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
      await currentConnection.getByText("llama.cpp", { exact: true }).waitFor();
      await currentConnection.getByText("gemma-4-e4b-it-q4_k_m", { exact: true }).waitFor();
      await expect
        .poll(() => currentConnection.locator('[data-provider-icon="llamacpp"]').count())
        .toBe(1);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "llama-cpp-main-desktop.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
