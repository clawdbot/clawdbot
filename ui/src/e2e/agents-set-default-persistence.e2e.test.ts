// Control UI tests cover Agents page Set Default persistence behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agents Set Default mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

suite.define(() => {
  it("persists Set Default through config.set instead of only staging the form draft", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const initialConfig = {
          agents: { entries: { main: { default: true }, kimi: {} } },
        };
        const savedConfig = {
          agents: { entries: { main: {}, kimi: { default: true } } },
        };
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
              config: initialConfig,
              sourceConfig: initialConfig,
              hash: "hash-1",
              issues: [],
              raw: JSON.stringify(initialConfig),
              valid: true,
            },
            "config.set": {
              config: savedConfig,
              sourceConfig: savedConfig,
              hash: "hash-2",
              issues: [],
              raw: JSON.stringify(savedConfig),
              valid: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}agents`);
        expect(response?.status()).toBe(200);

        // Click auto-waits for the elements to be actionable (enabled), so
        // these implicitly assert the dropdown loaded and Set Default is clickable for a
        // non-default agent.
        const agentSelect = page.locator("wa-dropdown.agent-select");
        await agentSelect.locator(".agent-select__trigger").click();
        await agentSelect.getByRole("menuitemradio", { name: "Kimi agent", exact: true }).click();
        await page.getByRole("button", { name: "Set Default", exact: true }).click();

        // The fix routes Set Default through the canonical save path; without it the click
        // only stages a form draft and never emits config.set, so this request never arrives.
        const setRequest = await gateway.waitForRequest("config.set");
        const raw = requestParams(setRequest).raw;
        expect(JSON.parse(String(raw))).toEqual(savedConfig);
        expect(requireRecord(JSON.parse(String(raw))).agents).not.toHaveProperty("list");
      },
    );
  });
});
