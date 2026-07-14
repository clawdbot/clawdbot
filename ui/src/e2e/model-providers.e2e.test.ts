// Control UI tests cover the Model Providers settings page against a mocked Gateway.
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
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
const artifactDir = path.resolve(".artifacts/control-ui-e2e/model-providers");
const redactedConfigValue = "[redacted]";
const openaiInputValue = ["e2e", "test", "key"].join("-");
const googleInputValue = ["e2e", "google", "key"].join("-");

let browser: Browser;
let server: ControlUiE2eServer;

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.patch params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

function providerConfig(value: string): { apiKey: string } {
  return Object.fromEntries([["apiKey", value]]) as { apiKey: string };
}

describeControlUiE2e("Control UI Model Providers mocked Gateway E2E", () => {
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

      const claudeCard = page.locator(".model-providers__row", { hasText: "Claude" });
      await claudeCard.waitFor();
      // Alias auth row (claude-cli) merges onto the canonical anthropic card.
      await expect
        .poll(async () => claudeCard.locator(".settings-row__desc").first().textContent())
        .toContain("anthropic");
      await expect.poll(async () => claudeCard.textContent()).toContain("Max 20x");
      await expect.poll(async () => claudeCard.textContent()).toContain("Connected");
      await expect.poll(async () => claudeCard.textContent()).toContain("$4.20");
      await claudeCard.locator(".provider-usage-progress").first().waitFor();

      const openrouterCard = page.locator(".model-providers__row", { hasText: "OpenRouter" });
      await openrouterCard.waitFor();
      await expect.poll(async () => openrouterCard.textContent()).toContain("API key");
      await expect.poll(async () => openrouterCard.textContent()).toContain("$12.34");

      // openai qualifies via its available catalog model despite having no
      // auth row; the shared label map renders "OpenAI", not "Openai".
      const openaiCard = page.locator(".model-providers__row", { hasText: "OpenAI" });
      await openaiCard.waitFor();
      await expect.poll(async () => openaiCard.textContent()).toContain("1 model");

      // google is in the configured catalog with an unavailable model; the
      // page surfaces it instead of hiding the broken provider.
      const googleCard = page.locator(".model-providers__row", { hasText: "Google" });
      await googleCard.waitFor();
      await expect.poll(async () => googleCard.textContent()).toContain("0 of 1 models available");
      await expect.poll(async () => page.locator(".model-providers__row").count()).toBe(4);
    } finally {
      await context.close();
    }
  });

  it("configures credentials, probes a provider, and changes default models", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1200, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1200, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          utilityModel: "openai/gpt-5.5-mini",
        },
      },
      models: { providers: { openai: providerConfig(redactedConfigValue) } },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "models.probe"],
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
        {
          id: "gpt-5.5-mini",
          name: "GPT-5.5 Mini",
          provider: "openai",
          available: true,
        },
        {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
          available: true,
        },
        { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google", available: true },
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "model-providers-hash",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "config.patch": { ok: true },
        "models.list": {
          cases: [
            {
              match: { view: "configured" },
              response: {
                models: [
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    provider: "openai",
                    available: true,
                  },
                  {
                    id: "gpt-5.5-mini",
                    name: "GPT-5.5 Mini",
                    provider: "openai",
                    available: true,
                  },
                  {
                    id: "claude-sonnet-4-5",
                    name: "Claude Sonnet 4.5",
                    provider: "anthropic",
                    available: true,
                  },
                ],
              },
            },
            {
              match: { view: "all", includeProviderCapabilities: true },
              response: {
                models: [
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    provider: "openai",
                    available: true,
                    apiKeySupported: true,
                  },
                  {
                    id: "claude-sonnet-4-5",
                    name: "Claude Sonnet 4.5",
                    provider: "anthropic",
                    available: true,
                    apiKeySupported: true,
                  },
                  {
                    id: "gemini-3-pro",
                    name: "Gemini 3 Pro",
                    provider: "google",
                    available: true,
                    apiKeySupported: true,
                  },
                ],
              },
            },
          ],
        },
        "models.authStatus": {
          ts: NOW,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "static",
              profiles: [],
              apiKey: { source: "config" },
            },
            {
              provider: "anthropic",
              displayName: "Anthropic",
              status: "ok",
              profiles: [{ profileId: "anthropic:default", type: "oauth", status: "ok" }],
            },
          ],
        },
        "models.probe": {
          provider: "openai",
          status: "ok",
          latencyMs: 87,
          results: [{ label: "Config API key", status: "ok", latencyMs: 87 }],
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const openaiCard = page.locator('[data-provider-id="openai"]');
      await openaiCard.waitFor();
      await expect.poll(async () => openaiCard.textContent()).toContain("API key set in config");
      await expect
        .poll(async () => page.locator(".model-providers__defaults select").first().inputValue())
        .toBe("openai/gpt-5.5");
      if (recordVisuals) {
        await page.screenshot({
          path: path.join(artifactDir, "01-configured.png"),
          fullPage: true,
        });
      }

      await openaiCard.getByRole("button", { name: "Replace key" }).click();
      await openaiCard.getByLabel("API key").fill(openaiInputValue);
      const patchCount = (await gateway.getRequests("config.patch")).length;
      await openaiCard.getByRole("button", { name: "Save" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("config.patch")).length)
        .toBe(patchCount + 1);
      const keyPatch = requestRaw(await gateway.waitForRequest("config.patch"));
      expect(keyPatch).toEqual({
        models: { providers: { openai: providerConfig(openaiInputValue) } },
      });
      await expect.poll(async () => openaiCard.textContent()).toContain("Secret saved.");

      await openaiCard.getByRole("button", { name: "Test connection" }).click();
      const probe = await gateway.waitForRequest("models.probe");
      expect(probe.params).toEqual({ provider: "openai" });
      await expect.poll(async () => openaiCard.textContent()).toContain("87 ms");

      const primary = page.locator(".model-providers__defaults select").first();
      const defaultPatchCount = (await gateway.getRequests("config.patch")).length;
      await primary.selectOption("anthropic/claude-sonnet-4-5");
      expect((await gateway.getRequests("config.patch")).length).toBe(defaultPatchCount);
      const updatedDefaultsConfig = {
        ...config,
        agents: {
          defaults: {
            ...config.agents.defaults,
            model: "anthropic/claude-sonnet-4-5",
          },
        },
      };
      await gateway.setMethodResponse("config.get", {
        config: updatedDefaultsConfig,
        sourceConfig: updatedDefaultsConfig,
        hash: "model-providers-hash-defaults",
        issues: [],
        raw: JSON.stringify(updatedDefaultsConfig),
        valid: true,
      });
      await page
        .locator(".settings-section", {
          has: page.getByRole("heading", { name: "Default models" }),
        })
        .getByRole("button", { name: "Save" })
        .click();
      await expect
        .poll(async () => (await gateway.getRequests("config.patch")).length)
        .toBe(defaultPatchCount + 1);
      expect(requestRaw(await gateway.waitForRequest("config.patch"))).toEqual({
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-5",
            utilityModel: "openai/gpt-5.5-mini",
          },
        },
      });

      const addSection = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "Add provider" }),
      });
      await addSection.getByRole("button", { name: "Add provider", exact: true }).click();
      await addSection.getByLabel("Provider").selectOption("google");
      await addSection.getByLabel("API key").fill(googleInputValue);
      const savedConfig = {
        ...updatedDefaultsConfig,
        models: {
          providers: {
            openai: providerConfig(redactedConfigValue),
            google: providerConfig(redactedConfigValue),
          },
        },
      };
      await gateway.setMethodResponse("config.get", {
        config: savedConfig,
        sourceConfig: savedConfig,
        hash: "model-providers-hash-2",
        issues: [],
        raw: JSON.stringify(savedConfig),
        valid: true,
      });
      await gateway.setMethodResponse("models.authStatus", {
        ts: NOW,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            status: "static",
            profiles: [],
            apiKey: { source: "config" },
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            status: "ok",
            profiles: [{ profileId: "anthropic:default", type: "oauth", status: "ok" }],
          },
          {
            provider: "google",
            displayName: "Google",
            status: "static",
            profiles: [],
            apiKey: { source: "config" },
          },
        ],
      });
      const addPatchCount = (await gateway.getRequests("config.patch")).length;
      await addSection.getByRole("button", { name: "Save provider" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("config.patch")).length)
        .toBe(addPatchCount + 1);
      expect(requestRaw(await gateway.waitForRequest("config.patch"))).toEqual({
        models: { providers: { google: providerConfig(googleInputValue) } },
      });
      await page.locator('[data-provider-id="google"]').waitFor();

      if (recordVisuals) {
        await page.screenshot({ path: path.join(artifactDir, "02-probed.png"), fullPage: true });
      }
    } finally {
      await context.close();
    }
  });
});
