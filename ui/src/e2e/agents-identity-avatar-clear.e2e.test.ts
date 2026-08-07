// Control UI proof: avatar Remove → Save sends agents.update avatar:null and refreshes.
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agents identity avatar clear mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

suite.define(() => {
  it("Remove → Save clears avatar through agents.update null and refreshes identity", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const avatarUrl = "https://example.com/avatar.png";
        const withAvatarList = {
          agents: [
            {
              id: "main",
              name: "Main agent",
              identity: { name: "Main agent", avatar: avatarUrl, emoji: "🦞" },
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        };
        const clearedList = {
          agents: [
            {
              id: "main",
              name: "Main agent",
              identity: { name: "Main agent", emoji: "🦞" },
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        };
        const identityGet = {
          agentId: "main",
          name: "Main agent",
          emoji: "🦞",
          avatar: avatarUrl,
          avatarStatus: "external",
        };
        const gateway = await installMockGateway(page, {
          assistantName: "Main agent",
          defaultAgentId: "main",
          // Advertise agents.update so canUpdateIdentity enables Remove/Save.
          featureMethods: [
            "chat.abort",
            "chat.metadata",
            "chat.startup",
            "config.apply",
            "config.patch",
            "config.set",
            "agents.list",
            "agent.identity.get",
            "agents.update",
            "agents.files.list",
            "agents.files.get",
            "agents.files.set",
          ],
          methodResponses: {
            "agents.list": withAvatarList,
            "agent.identity.get": identityGet,
            "agents.update": { ok: true, agentId: "main" },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}agents`);
        expect(response?.status()).toBe(200);
        await page.locator("button.agents-refresh-btn").waitFor({ state: "visible" });
        await page.locator("wa-tab.hub-tab", { hasText: "Overview" }).first().click();
        await page.locator(".agent-identity-editor").waitFor({ state: "visible" });

        const remove = page.getByTestId("agent-identity-avatar-remove");
        await remove.waitFor({ state: "visible", timeout: 15_000 });
        await expect.poll(async () => remove.isEnabled()).toBe(true);
        const updatePromise = gateway.waitForRequest("agents.update");
        await remove.click();
        const save = page.locator(".agent-identity-editor__actions button.btn.primary");
        await expect.poll(async () => save.isEnabled()).toBe(true);
        await save.click();

        const updateRequest = await updatePromise;
        const params = requestParams(updateRequest);
        expect(params).toMatchObject({ agentId: "main", avatar: null });

        await gateway.setMethodResponse("agents.list", clearedList);
        await gateway.setMethodResponse("agent.identity.get", {
          agentId: "main",
          name: "Main agent",
          emoji: "🦞",
          avatar: "",
          avatarStatus: "none",
        });
        await page.goto(`${suite.server.baseUrl}agents`);
        await page.locator("button.agents-refresh-btn").waitFor({ state: "visible" });
        await page.locator("wa-tab.hub-tab", { hasText: "Overview" }).first().click();
        await page.locator(".agent-identity-editor").waitFor({ state: "visible" });
        await page.getByTestId("agent-identity-avatar-remove").waitFor({ state: "detached" });
        expect(await page.getByTestId("agent-identity-avatar-remove").count()).toBe(0);
        console.log(
          [
            "----- control-ui-avatar-remove-save -----",
            `url=${suite.server.baseUrl}agents`,
            "action=Remove → Save",
            `gateway_request=${JSON.stringify({ method: "agents.update", params })}`,
            `gateway_result=${JSON.stringify({ ok: true, agentId: "main" })}`,
            "refreshed_state=Remove control absent after cleared agents.list / agent.identity.get",
          ].join("\n"),
        );
      },
    );
  });
});
