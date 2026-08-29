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
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
const artifactDir = path.resolve(
  process.env.OPENCLAW_UI_E2E_PROOF_DIR ?? ".artifacts/control-ui-e2e/model-providers-progressive",
);

describeControlUiE2e("Control UI progressive Model Providers loading", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    if (recordVisuals) {
      await mkdir(artifactDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders provider controls before usage and cost settle", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1_000, width: 1_280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_280 } } }
        : {}),
    });
    const page = await context.newPage();
    const now = Date.now();
    const gateway = await installMockGateway(page, {
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
      heldMethods: ["usage.status", "sessions.usage"],
      methodResponses: {
        "config.get": {
          config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
          sourceConfig: {},
          hash: "progressive-model-providers",
          issues: [],
          raw: "{}",
          valid: true,
        },
        "models.authStatus": {
          ts: now,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "static",
              profiles: [],
              apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
            },
          ],
        },
        "usage.status": {
          updatedAt: now,
          providers: [{ provider: "openai", displayName: "OpenAI", plan: "Pro", windows: [] }],
        },
        "sessions.usage": {
          aggregates: {
            byProvider: [
              {
                provider: "openai",
                count: 1,
                totals: { totalTokens: 100, totalCost: 1.25 },
              },
            ],
          },
        },
      },
    });

    try {
      expect((await page.goto(`${server.baseUrl}settings/model-providers`))?.status()).toBe(200);
      await gateway.waitForRequest("usage.status");
      await gateway.waitForRequest("sessions.usage");
      const provider = page.locator('[data-provider-id="openai"]');
      await provider.waitFor();
      await expect.poll(async () => provider.textContent()).toContain("Credentials configured");
      await expect.poll(async () => provider.textContent()).toContain("Loading");
      expect(await gateway.getRequests("usage.status")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.usage")).toHaveLength(1);
      if (recordVisuals) {
        await page.screenshot({ path: path.join(artifactDir, "before.png"), fullPage: true });
      }

      await gateway.resolveDeferred("usage.status");
      await expect.poll(async () => provider.textContent()).toContain("Pro");
      expect(await provider.textContent()).not.toContain("$1.25");
      if (recordVisuals) {
        await page.screenshot({ path: path.join(artifactDir, "usage-ready.png"), fullPage: true });
      }

      await gateway.resolveDeferred("sessions.usage");
      await expect.poll(async () => provider.textContent()).toContain("$1.25");
      expect(await page.locator('[data-provider-id="unknown-provider"]').count()).toBe(0);
      if (recordVisuals) {
        await page.screenshot({ path: path.join(artifactDir, "after.png"), fullPage: true });
      }
    } finally {
      await context.close();
    }
  });
});
