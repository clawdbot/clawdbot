// Control UI tests cover Agents page Set Default persistence behavior.
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

describeControlUiE2e("Control UI agents Set Default mocked Gateway E2E", () => {
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

  it("persists Set Default through config.set instead of only staging the form draft", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "Main agent",
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", name: "Main agent" },
            { id: "kimi", name: "Kimi agent" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": {
          config: { agents: { list: [{ id: "main" }, { id: "kimi" }] } },
          hash: "hash-1",
          issues: [],
          raw: '{"agents":{"list":[{"id":"main"},{"id":"kimi"}]}}',
          valid: true,
        },
        "config.set": {
          config: { agents: { list: [{ id: "main" }, { id: "kimi", default: true }] } },
          hash: "hash-2",
          issues: [],
          raw: '{"agents":{"list":[{"id":"main"},{"id":"kimi","default":true}]}}',
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}agents`);
      expect(response?.status()).toBe(200);

      // Click auto-waits for the elements to be actionable (enabled), so
      // these implicitly assert the dropdown loaded and Set Default is clickable for a
      // non-default agent.
      const agentSelect = page.locator("wa-dropdown.agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      await agentSelect.getByRole("menuitemcheckbox", { name: "Kimi agent", exact: true }).click();
      await page.getByRole("button", { name: "Set Default", exact: true }).click();

      // The fix routes Set Default through the canonical save path; without it the click
      // only stages a form draft and never emits config.set, so this request never arrives.
      const setRequest = await gateway.waitForRequest("config.set");
      const raw = requestParams(setRequest).raw;
      expect(JSON.parse(String(raw))).toEqual({
        agents: { list: [{ id: "main" }, { id: "kimi", default: true }] },
      });
    } finally {
      await context.close();
    }
  });
});
