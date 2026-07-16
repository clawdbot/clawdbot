// Control UI tests cover guided model setup against a mocked Gateway.
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

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Model Setup mocked Gateway E2E", () => {
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

  it("detects a reusable CLI login, activates it, and opens chat", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "openclaw.setup.detect",
        "openclaw.setup.activate",
      ],
      methodResponses: {
        "openclaw.setup.detect": {
          candidates: [
            {
              kind: "codex-cli",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          workspace: "/tmp/openclaw-e2e",
          setupComplete: false,
        },
        "openclaw.setup.activate": {
          ok: true,
          modelRef: "openai/gpt-5",
          latencyMs: 73,
          lines: ["Model ready"],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup`);
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
      const candidate = page.locator('[data-candidate-kind="codex-cli"]');
      await candidate.getByRole("button", { name: "Test & use" }).click();

      const detect = await gateway.waitForRequest("openclaw.setup.detect");
      expect(detect.params).toEqual({});
      const activate = await gateway.waitForRequest("openclaw.setup.activate");
      expect(activate.params).toEqual({ kind: "codex-cli", modelRef: "openai/gpt-5" });

      await page.getByText("Your AI is ready").waitFor();
      await expect
        .poll(async () => page.locator(".model-setup__success").textContent())
        .toContain("openai/gpt-5 · 73 ms");
      await page.getByRole("button", { name: "Open Chat" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
    } finally {
      await context.close();
    }
  });
});
