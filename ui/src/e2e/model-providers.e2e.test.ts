// Control UI tests cover the Models settings page against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator } from "playwright";
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
const utilityHelpArtifactDir = path.resolve(".artifacts/control-ui-e2e/utility-model-help");
const readinessArtifactDir = path.resolve(".artifacts/control-ui-e2e/models-provider-readiness");
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

function modelPickerValue(locator: Locator) {
  return locator.evaluate((element) => String((element as HTMLElement & { value?: string }).value));
}

async function selectModelPicker(locator: Locator, value: string) {
  await locator.evaluate(async (element, next) => {
    const select = element as HTMLElement & { value: string; updateComplete: Promise<unknown> };
    select.value = next;
    await select.updateComplete;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

describeControlUiE2e("Control UI Models mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    if (recordVisuals) {
      await mkdir(artifactDir, { recursive: true });
      await mkdir(utilityHelpArtifactDir, { recursive: true });
      await mkdir(readinessArtifactDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("defers live provider discovery until refresh while preserving model setup", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const config = { auth: { profiles: { "openai:chatgpt": { provider: "openai" } } } };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "models.probe", "openclaw.setup.detect"],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "credential-only-model-provider",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "models.list": {
          cases: [
            {
              match: { view: "configured", agentId: "main", preparedOnly: true },
              response: { models: [] },
            },
            {
              match: { view: "configured", agentId: "main", refresh: true },
              response: {
                models: [],
                providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
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
              status: "ok",
              profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "ok" }],
            },
          ],
        },
        "openclaw.setup.detect": {
          candidates: [],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          workspace: "/tmp/openclaw-e2e",
          setupComplete: false,
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      const openaiCard = page.locator('[data-provider-id="openai"]');
      const readiness = page.locator('[data-model-readiness="model-required"]');
      await readiness.waitFor();
      await expect
        .poll(async () => readiness.textContent())
        .toContain("Connect a verified AI model");
      await expect.poll(async () => readiness.textContent()).toContain("Model required");
      await expect.poll(async () => openaiCard.textContent()).toContain("Credentials configured");
      await expect.poll(async () => openaiCard.textContent()).not.toContain("Signed in");
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toEqual([
        expect.objectContaining({
          params: { agentId: "main", preparedOnly: true, view: "configured" },
        }),
      ]);
      expect(await page.getByRole("heading", { name: "Add provider" }).count()).toBe(0);
      expect(await page.locator(".model-providers__defaults").count()).toBe(0);

      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(readinessArtifactDir, "after-desktop.png"),
        });
        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        const providerTitle = openaiCard.locator(".settings-row__title").first();
        await expect
          .poll(() => providerTitle.evaluate((node) => node.getBoundingClientRect().width))
          .toBeGreaterThan(40);
        await expect
          .poll(() => providerTitle.evaluate((node) => node.getBoundingClientRect().height))
          .toBeLessThan(32);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(readinessArtifactDir, "after-mobile.png"),
        });
        await page.setViewportSize({ height: 1000, width: 1440 });
      }

      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(async () => openaiCard.textContent()).toContain("Credentials rejected");
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(2);

      await readiness.getByRole("button", { name: "Connect a verified AI model" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
    } finally {
      await context.close();
    }
  });

  it("lists configured providers with auth state, quota, billing, and local spend", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1200, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1200, width: 1280 } } }
        : {}),
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
          providerCapabilities: [
            { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
            { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
            { provider: "google", apiKeySupported: true, quickApiKeySetup: true },
          ],
          providers: [
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "anthropic:default", type: "oauth", status: "expired" }],
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
      await page.locator(".page-title", { hasText: "Models" }).first().waitFor();

      const claudeCard = page.locator(".model-providers__row", { hasText: "Claude" });
      await claudeCard.waitFor();
      // Alias auth row (claude-cli) merges onto the canonical anthropic card.
      await expect
        .poll(async () => claudeCard.locator(".settings-row__desc").first().textContent())
        .toContain("anthropic");
      await expect.poll(async () => claudeCard.textContent()).toContain("Max 20x");
      await expect.poll(async () => claudeCard.textContent()).toContain("Credentials configured");
      await expect.poll(async () => claudeCard.textContent()).not.toContain("Expired");
      await expect.poll(async () => claudeCard.textContent()).not.toContain("Expiring");
      await expect.poll(async () => claudeCard.textContent()).not.toContain("Not signed in");
      await expect.poll(async () => claudeCard.textContent()).toContain("$4.20");
      await claudeCard.locator(".provider-usage-progress").first().waitFor();
      await expect.poll(() => page.getByText("Model auth expired: Claude").count()).toBe(0);

      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "claude-cli-oauth-alias.png"),
        });
      }

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

  it("explains the utility model with accessible pointer, keyboard, and narrow-layout behavior", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const config = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        models: { providers: { openai: providerConfig(redactedConfigValue) } },
      };
      await installMockGateway(page, {
        models: [
          { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
          {
            id: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            provider: "openai",
            available: true,
          },
        ],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: `utility-help-${colorScheme}`,
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "models.authStatus": { ts: NOW, providers: [] },
          "usage.status": { updatedAt: NOW, providers: [] },
          "sessions.usage": { aggregates: { byProvider: [] } },
        },
      });

      try {
        await page.goto(`${server.baseUrl}settings/model-providers`);
        await page.locator(".page-title", { hasText: "Models" }).first().waitFor();
        const defaults = page.locator(".model-providers__defaults");
        const utilityField = defaults.locator(".field").nth(1);
        const utilityLabel = utilityField.locator(".model-providers__utility-label");
        await utilityField.waitFor();
        expect(await utilityLabel.evaluate((node) => getComputedStyle(node).columnGap)).toBe("8px");
        await expect
          .poll(() => modelPickerValue(utilityField.locator("wa-select")))
          .toBe("__openclaw_automatic_utility__");

        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-default-full.png`),
          });
          await utilityField.screenshot({
            animations: "disabled",
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-default-crop.png`),
          });
        }

        const helpButton = defaults.getByRole("button", { name: "About the utility model" });
        await expect.poll(() => helpButton.count()).toBe(1);
        await expect.poll(() => helpButton.locator("svg").count()).toBe(1);
        expect(await helpButton.getAttribute("aria-haspopup")).toBe("dialog");

        const defaultColor = await helpButton.evaluate((node) => getComputedStyle(node).color);
        await helpButton.hover();
        await expect
          .poll(() => helpButton.evaluate((node) => getComputedStyle(node).color))
          .not.toBe(defaultColor);
        const hoverTooltip = utilityLabel.locator("openclaw-tooltip wa-tooltip");
        expect(await hoverTooltip.count()).toBe(1);
        await expect
          .poll(() => hoverTooltip.evaluate((node) => node.hasAttribute("open")))
          .toBe(true);
        await expect.poll(() => hoverTooltip.textContent()).toContain("short background tasks");
        const helpButtonBox = await helpButton.boundingBox();
        expect(helpButtonBox).not.toBeNull();
        expect(helpButtonBox?.width).toBeLessThanOrEqual(16);
        expect(helpButtonBox?.height).toBeLessThanOrEqual(16);
        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-hover-tooltip-full.png`),
          });
        }

        await helpButton.click();
        const popover = page.locator("wa-popover.model-providers__utility-help-popover");
        const popoverDialog = popover.locator("dialog");
        const popoverBody = popover.locator('[part="body"]');
        await expect.poll(() => popoverDialog.isVisible()).toBe(true);
        await expect.poll(() => popover.textContent()).toContain("short background tasks");
        await expect.poll(() => popover.textContent()).toContain("primary model provider");

        expect(
          await popover.evaluate((node) => ({
            distance: Reflect.get(node, "distance"),
            placement: Reflect.get(node, "placement"),
            skidding: Reflect.get(node, "skidding"),
          })),
        ).toEqual({ distance: 8, placement: "top", skidding: 0 });
        if (recordVisuals) {
          const labelBox = await utilityLabel.boundingBox();
          const popoverBox = await popoverBody.boundingBox();
          if (!labelBox || !popoverBox) {
            throw new Error("expected utility label and popover bounds");
          }
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-open-full.png`),
          });
          const x = Math.min(labelBox.x, popoverBox.x);
          const y = Math.max(0, popoverBox.y);
          const right = Math.max(labelBox.x + labelBox.width, popoverBox.x + popoverBox.width);
          const bottom = Math.max(labelBox.y + labelBox.height, popoverBox.y + popoverBox.height);
          await page.screenshot({
            animations: "disabled",
            clip: {
              x,
              y,
              width: right - x,
              height: bottom - y,
            },
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-open-crop.png`),
          });
        }

        await page.locator(".page-title", { hasText: "Models" }).first().click();
        await expect.poll(() => popoverDialog.isHidden()).toBe(true);

        await helpButton.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect
          .poll(() => helpButton.evaluate((node) => node.matches(":focus-visible")))
          .toBe(true);
        await page.keyboard.press("Enter");
        await expect.poll(() => popoverDialog.isVisible()).toBe(true);
        await expect
          .poll(() => popover.evaluate((node) => node.shadowRoot?.activeElement?.localName))
          .toBe("dialog");
        await page.keyboard.press("Escape");
        await expect.poll(() => popoverDialog.isHidden()).toBe(true);
        expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
        await expect
          .poll(() => helpButton.evaluate((node) => node === document.activeElement))
          .toBe(true);

        await page.setViewportSize({ height: 844, width: 390 });
        await utilityField.scrollIntoViewIfNeeded();
        await helpButton.click();
        await expect.poll(() => popoverDialog.isVisible()).toBe(true);
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        const mobilePopoverBox = await popoverBody.boundingBox();
        if (!mobilePopoverBox) {
          throw new Error("expected utility help popover bounds on mobile");
        }
        expect(mobilePopoverBox.x).toBeGreaterThanOrEqual(0);
        expect(mobilePopoverBox.x + mobilePopoverBox.width).toBeLessThanOrEqual(390);

        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(utilityHelpArtifactDir, `${colorScheme}-mobile-open.png`),
          });
        }
      } finally {
        await context.close();
      }
    }
  });

  it("renders one complete uppercased grapheme in custom provider fallback icons", async () => {
    const bottomProviderId = "e\u0301-proxy";
    const cases = [
      { id: "ß-provider", expected: "S" },
      { id: "🧭-proxy", expected: "🧭" },
      { id: "🇺🇸-proxy", expected: "🇺🇸" },
      { id: "👩‍💻-proxy", expected: "👩‍💻" },
      { id: bottomProviderId, expected: "E\u0301" },
    ];
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      models: cases.map(({ id }) => ({
        id: "test-model",
        name: "Test Model",
        provider: id,
        available: true,
      })),
      methodResponses: {
        "models.authStatus": { ts: NOW, providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      await page.locator(".page-title", { hasText: "Models" }).first().waitFor();

      for (const { id, expected } of cases) {
        const icon = page.locator(`[data-provider-id="${id}"] .provider-brand-icon--fallback`);
        await icon.waitFor();
        await expect.poll(async () => (await icon.textContent())?.trim()).toBe(expected);
      }

      if (recordVisuals) {
        await page.screenshot({
          path: path.join(artifactDir, "03-unicode-fallback-icons.png"),
          fullPage: true,
        });
        await page.locator(`[data-provider-id="${bottomProviderId}"]`).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(artifactDir, "04-unicode-fallback-icons-bottom.png"),
          fullPage: true,
        });
      }
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
      featureMethods: ["chat.metadata", "chat.startup", "config.patch", "models.probe"],
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
              match: { view: "all", agentId: "main", refresh: true },
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
          providerCapabilities: [
            { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
            { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
            { provider: "google", apiKeySupported: true, quickApiKeySetup: true },
          ],
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
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toEqual([
        expect.objectContaining({
          params: { agentId: "main", preparedOnly: true, view: "configured" },
        }),
      ]);
      await expect.poll(async () => openaiCard.textContent()).toContain("API key set in config");
      await expect
        .poll(() => modelPickerValue(page.locator(".model-providers__defaults wa-select").first()))
        .toBe("openai/gpt-5.5");
      if (recordVisuals) {
        await page.screenshot({
          path: path.join(artifactDir, "01-configured.png"),
          fullPage: true,
        });
      }

      await openaiCard.getByRole("button", { name: "Replace key" }).click();
      await openaiCard.getByLabel("API key").fill(openaiInputValue);
      // The { after } cursor waits for and returns the save-triggered patch,
      // so a slow runner can't hand back an earlier config.patch stale.
      const patchCount = (await gateway.getRequests("config.patch")).length;
      await openaiCard.getByRole("button", { name: "Save" }).click();
      const keyPatch = requestRaw(
        await gateway.waitForRequest("config.patch", {
          after: patchCount,
        }),
      );
      expect(keyPatch).toEqual({
        models: { providers: { openai: providerConfig(openaiInputValue) } },
      });
      await expect.poll(async () => openaiCard.textContent()).toContain("Secret saved.");

      await openaiCard.getByRole("button", { name: "Test connection" }).click();
      const probe = await gateway.waitForRequest("models.probe");
      expect(probe.params).toEqual({ provider: "openai", agentId: "main" });
      await expect.poll(async () => openaiCard.textContent()).toContain("87 ms");

      const primary = page.locator(".model-providers__defaults wa-select").first();
      const defaultPatchCount = (await gateway.getRequests("config.patch")).length;
      await selectModelPicker(primary, "anthropic/claude-sonnet-4-5");
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
      expect(
        requestRaw(await gateway.waitForRequest("config.patch", { after: defaultPatchCount })),
      ).toEqual({
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
        providerCapabilities: [
          { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
          { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
          { provider: "google", apiKeySupported: true, quickApiKeySetup: true },
        ],
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
      expect(
        requestRaw(await gateway.waitForRequest("config.patch", { after: addPatchCount })),
      ).toEqual({
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

  it("reloads the selected agent and clears a failed model draft after reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const initialConfig = {
      agents: { defaults: { model: "openai/initial-model" } },
    };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": {
          config: initialConfig,
          sourceConfig: initialConfig,
          hash: "model-providers-reconnect-1",
          issues: [],
          raw: JSON.stringify(initialConfig),
          valid: true,
        },
        "models.list": {
          models: [
            { id: "initial-model", name: "Initial Model", provider: "openai", available: true },
            { id: "saved-model", name: "Saved Model", provider: "openai", available: true },
            { id: "failed-draft", name: "Failed Draft", provider: "openai", available: true },
          ],
        },
        "models.authStatus": {
          ts: NOW,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai:writer", type: "oauth", status: "ok" }],
            },
          ],
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const agentPicker = page.locator(".agent-scope-control openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.locator('wa-dropdown-item[aria-label="Writer"]').click();
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      await expect
        .poll(() => modelPickerValue(page.locator(".model-providers__defaults wa-select").first()))
        .toBe("openai/initial-model");

      const primary = page.locator(".model-providers__defaults wa-select").first();
      const savedConfig = {
        agents: { defaults: { model: "openai/saved-model" } },
      };
      await gateway.setMethodResponse("config.get", {
        config: savedConfig,
        sourceConfig: savedConfig,
        hash: "model-providers-reconnect-saved",
        issues: [],
        raw: JSON.stringify(savedConfig),
        valid: true,
      });
      await selectModelPicker(primary, "openai/saved-model");
      await page
        .locator(".settings-section", {
          has: page.getByRole("heading", { name: "Default models" }),
        })
        .getByRole("button", { name: "Save" })
        .click();
      await expect
        .poll(async () =>
          page.getByRole("status").filter({ hasText: "Default models saved" }).count(),
        )
        .toBeGreaterThan(0);

      await selectModelPicker(primary, "openai/failed-draft");
      await gateway.deferNext("config.patch");
      await page
        .locator(".settings-section", {
          has: page.getByRole("heading", { name: "Default models" }),
        })
        .getByRole("button", { name: "Save" })
        .click();
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "synthetic model save rejected",
      });
      await page.getByRole("alert").filter({ hasText: "synthetic model save rejected" }).waitFor();
      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "05-reconnect-save-error.png"),
        });
      }

      const reconnectedConfig = {
        agents: { defaults: { model: "openai/reconnected-model" } },
      };
      await gateway.setMethodResponse("config.get", {
        config: reconnectedConfig,
        sourceConfig: reconnectedConfig,
        hash: "model-providers-reconnect-2",
        issues: [],
        raw: JSON.stringify(reconnectedConfig),
        valid: true,
      });
      await gateway.setMethodResponse("models.list", {
        models: [
          {
            id: "reconnected-model",
            name: "Reconnected Model",
            provider: "openai",
            available: true,
          },
        ],
      });
      const authRequestCount = (await gateway.getRequests("models.authStatus")).length;
      await gateway.closeLatest(1012, "model provider reconnect proof");
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBeGreaterThan(authRequestCount);
      await expect
        .poll(() => modelPickerValue(page.locator(".model-providers__defaults wa-select").first()))
        .toBe("openai/reconnected-model");
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      for (const request of (await gateway.getRequests("models.authStatus")).slice(
        authRequestCount,
      )) {
        expect(request.params).toEqual(expect.objectContaining({ agentId: "writer" }));
      }
      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "06-reconnected-model.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
