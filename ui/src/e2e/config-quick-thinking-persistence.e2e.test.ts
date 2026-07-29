// Control UI tests cover shared model-behavior persistence through the mocked Gateway.
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

let browser: Browser;
let server: ControlUiE2eServer;

function configResponse(
  thinkingDefault: "low" | "high",
  hash: string,
  fastModeDefault?: boolean | "auto",
) {
  const config = {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        thinkingDefault,
        ...(fastModeDefault === undefined ? {} : { fastModeDefault }),
      },
    },
  };
  return {
    config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.set params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

describeControlUiE2e("Control UI Models settings behavior persistence mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("links General to the Models page", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      const response = await page.goto(`${server.baseUrl}settings/general`);
      expect(response?.status()).toBe(200);

      const modelsRow = page.getByRole("button", { name: /Models/ });
      await modelsRow.waitFor();
      await modelsRow.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("reads and writes only agents.defaults.thinkingDefault", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const initialConfig = configResponse("low", "hash-1");
    const savedConfig = configResponse("high", "hash-2");
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": initialConfig,
        "config.set": savedConfig,
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);

      const modelCard = page.locator("#settings-model-behavior");
      const lowButton = modelCard.getByRole("radio", { name: "Low", exact: true });
      await lowButton.waitFor();
      expect(await lowButton.getAttribute("aria-checked")).toBe("true");

      await modelCard.getByRole("radio", { name: "High", exact: true }).click();

      const raw = requestRaw(await gateway.waitForRequest("config.set"));
      expect(raw).toEqual({
        agents: { defaults: { model: "openai/gpt-5.5", thinkingDefault: "high" } },
      });
      expect(JSON.stringify(raw)).not.toContain("thinkingLevel");
      expect(JSON.stringify(raw)).not.toContain("fastMode");

      const freshPage = await context.newPage();
      await installMockGateway(freshPage, {
        methodResponses: { "config.get": savedConfig },
      });
      await freshPage.goto(`${server.baseUrl}settings/model-providers`);
      const highButton = freshPage
        .locator("#settings-model-behavior")
        .getByRole("radio", { name: "High", exact: true });
      await highButton.waitFor();
      expect(await highButton.getAttribute("aria-checked")).toBe("true");
    } finally {
      await context.close();
    }
  });

  it.each([
    { initial: false, initialLabel: "Standard", next: true, nextLabel: "Fast" },
    { initial: true, initialLabel: "Fast", next: "auto" as const, nextLabel: "Auto" },
    { initial: "auto" as const, initialLabel: "Auto", next: false, nextLabel: "Standard" },
  ])(
    "persists agents.defaults.fastModeDefault from $initialLabel to $nextLabel",
    async ({ initial, initialLabel, next, nextLabel }) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const initialConfig = configResponse("low", "hash-1", initial);
      const gateway = await installMockGateway(page, {
        methodResponses: { "config.get": initialConfig },
      });

      try {
        const response = await page.goto(`${server.baseUrl}settings/model-providers`);
        expect(response?.status()).toBe(200);

        const modelCard = page.locator("#settings-model-behavior");
        const initialButton = modelCard.getByRole("radio", { name: initialLabel, exact: true });
        await initialButton.waitFor();
        expect(await initialButton.getAttribute("aria-checked")).toBe("true");

        await modelCard.getByRole("radio", { name: nextLabel, exact: true }).click();

        const raw = requestRaw(await gateway.waitForRequest("config.set"));
        expect(raw).toEqual({
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
              thinkingDefault: "low",
              fastModeDefault: next,
            },
          },
        });
        expect(raw.agents).not.toHaveProperty("defaults.fastMode");

        const reloadResponse = await page.reload();
        expect(reloadResponse?.status()).toBe(200);
        const persistedButton = modelCard.getByRole("radio", { name: nextLabel, exact: true });
        await persistedButton.waitFor();
        expect(await persistedButton.getAttribute("aria-checked")).toBe("true");
      } finally {
        await context.close();
      }
    },
  );
});
