// Control UI tests cover the Model Providers settings page against a mocked Gateway.
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

const NOW = Date.now();

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Model Providers mocked Gateway E2E", () => {
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

  it("lists configured providers with auth state, quota, billing, and local spend", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1200, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      models: [
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", available: true },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
        { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google", available: false },
      ],
      methodResponses: {
        "models.authStatus": {
          ts: NOW,
          providers: [
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "anthropic:default", type: "oauth", status: "ok" }],
              usage: {
                providerId: "anthropic",
                plan: "Max 20x",
                windows: [{ label: "5h", usedPercent: 38, resetAt: NOW + 2 * 3_600_000 }],
              },
            },
            {
              provider: "openrouter",
              displayName: "OpenRouter",
              status: "static",
              profiles: [{ profileId: "openrouter:default", type: "api_key", status: "static" }],
            },
          ],
        },
        "usage.status": {
          updatedAt: NOW,
          providers: [
            {
              provider: "openrouter",
              displayName: "OpenRouter",
              windows: [],
              billing: [{ type: "balance", amount: 12.34, unit: "USD" }],
            },
          ],
        },
        "sessions.usage": {
          updatedAt: NOW,
          sessions: [],
          totals: null,
          aggregates: {
            messages: {
              total: 0,
              user: 0,
              assistant: 0,
              toolCalls: 0,
              toolResults: 0,
              errors: 0,
            },
            tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
            byModel: [],
            byProvider: [
              {
                provider: "anthropic",
                count: 3,
                totals: {
                  input: 100,
                  output: 50,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 1_500_000,
                  totalCost: 4.2,
                  inputCost: 4.2,
                  outputCost: 0,
                  cacheReadCost: 0,
                  cacheWriteCost: 0,
                  missingCostEntries: 0,
                },
              },
            ],
            byAgent: [],
            byChannel: [],
            daily: [],
          },
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      await page.locator(".page-title", { hasText: "Model Providers" }).first().waitFor();

      const claudeCard = page.locator(".model-providers__card", { hasText: "Claude" });
      await claudeCard.waitFor();
      // Alias auth row (claude-cli) merges onto the canonical anthropic card.
      await expect
        .poll(async () => claudeCard.locator(".provider-usage-card__id").textContent())
        .toBe("anthropic");
      await expect.poll(async () => claudeCard.textContent()).toContain("Max 20x");
      await expect.poll(async () => claudeCard.textContent()).toContain("Connected");
      await expect.poll(async () => claudeCard.textContent()).toContain("$4.20");
      await claudeCard.locator(".provider-usage-progress").first().waitFor();

      const openrouterCard = page.locator(".model-providers__card", { hasText: "OpenRouter" });
      await openrouterCard.waitFor();
      await expect.poll(async () => openrouterCard.textContent()).toContain("API key");
      await expect.poll(async () => openrouterCard.textContent()).toContain("$12.34");

      // openai qualifies via its available catalog model despite having no
      // auth row; the shared label map renders "OpenAI", not "Openai".
      const openaiCard = page.locator(".model-providers__card", { hasText: "OpenAI" });
      await openaiCard.waitFor();
      await expect.poll(async () => openaiCard.textContent()).toContain("1 model");

      // google is in the configured catalog with an unavailable model; the
      // page surfaces it instead of hiding the broken provider.
      const googleCard = page.locator(".model-providers__card", { hasText: "Google" });
      await googleCard.waitFor();
      await expect.poll(async () => googleCard.textContent()).toContain("0 of 1 models available");
      await expect.poll(async () => page.locator(".model-providers__card").count()).toBe(4);
    } finally {
      await context.close();
    }
  });
});
