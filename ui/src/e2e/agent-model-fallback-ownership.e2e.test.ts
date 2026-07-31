// Real browser proof that agent model fallbacks follow the Gateway's ownership contract.
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

const primaryModel = "openai/gpt-5.4";
const inheritedFallback = "anthropic/claude-sonnet-4-6";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI agent model fallback ownership", () => {
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

  it.each([
    {
      name: "inherits global fallbacks when the agent has no model override",
      model: undefined,
      expectedFallbacks: [inheritedFallback],
    },
    {
      name: "does not inherit global fallbacks for a string primary",
      model: primaryModel,
      expectedFallbacks: [],
    },
    {
      name: "does not inherit global fallbacks for an object primary",
      model: { primary: primaryModel },
      expectedFallbacks: [],
    },
    {
      name: "preserves explicitly disabled agent fallbacks",
      model: { primary: primaryModel, fallbacks: [] },
      expectedFallbacks: [],
    },
    {
      name: "displays the agent's own fallback instead of the global fallback",
      model: { primary: primaryModel, fallbacks: ["google/gemini-3-pro"] },
      expectedFallbacks: ["google/gemini-3-pro"],
    },
  ])("$name", async ({ model, expectedFallbacks }) => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const writer = { id: "writer", ...(model === undefined ? {} : { model }) };
    const config = {
      agents: {
        defaults: { model: { primary: primaryModel, fallbacks: [inheritedFallback] } },
        list: [{ id: "main" }, writer],
      },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [
            { id: "main", identity: { name: "Main" }, name: "Main" },
            { id: "writer", identity: { name: "Writer" }, name: "Writer" },
          ],
        },
        "config.get": {
          config,
          sourceConfig: config,
          hash: "agent-model-fallback-ownership",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/agents/main/tools`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      const agentPicker = page.locator("openclaw-agents-page openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      // Switching agents is the user action under test; the Tools panel must survive it.
      await agentPicker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Writer" })
        .evaluate((item) => (item as HTMLElement).click());
      await expect
        .poll(() =>
          agentPicker.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
        )
        .toBe("writer");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/writer/tools");
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/settings/agents/writer/overview");

      const fallbackInput = page.locator(".agent-chip-input");
      await fallbackInput.waitFor({ timeout: 10_000 });
      await expect
        .poll(async () =>
          (await fallbackInput.locator(".chip").allTextContents()).map((value) =>
            value.replace("×", "").trim(),
          ),
        )
        .toEqual(expectedFallbacks);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
