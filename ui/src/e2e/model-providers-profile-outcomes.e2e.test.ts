import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model provider profile outcomes" });
const NOW = Date.now();

suite.define(() => {
  it.each([
    {
      name: "keeps the selected agent ready when a sibling profile is rejected",
      providerOutcomes: [
        { provider: "openai", profileId: "openai:rejected", status: "auth-rejected" },
        { provider: "openai", profileId: "openai:ready", status: "ready" },
      ],
      status: "Ready",
      available: true,
    },
    {
      name: "keeps the selected agent's provider-wide rejection visible",
      providerOutcomes: [
        { provider: "openai", status: "auth-rejected" },
        { provider: "openai", profileId: "openai:ready", status: "ready" },
      ],
      status: "Credentials rejected",
      available: false,
    },
  ])("$name", async ({ providerOutcomes, status, available }) => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = {
          auth: {
            profiles: {
              "openai:rejected": { provider: "openai" },
              "openai:ready": { provider: "openai" },
            },
          },
        };
        const readyModel = {
          id: "gpt-ready",
          name: "GPT Ready",
          provider: "openai",
          available,
        };
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "models.probe"],
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
              hash: "multi-profile-model-provider",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "models.list": {
              cases: [
                {
                  match: { view: "configured", agentId: "writer", preparedOnly: true },
                  response: { models: [readyModel] },
                },
                {
                  match: { view: "configured", agentId: "writer", refresh: true },
                  response: {
                    models: [readyModel],
                    providerOutcomes,
                  },
                },
                { match: { view: "configured" }, response: { models: [] } },
              ],
            },
            "models.authStatus": {
              cases: [
                {
                  match: { agentId: "writer" },
                  response: {
                    ts: NOW,
                    providers: [
                      {
                        provider: "openai",
                        displayName: "OpenAI",
                        status: "ok",
                        profiles: [
                          { profileId: "openai:rejected", type: "oauth", status: "ok" },
                          { profileId: "openai:ready", type: "oauth", status: "ok" },
                        ],
                      },
                    ],
                  },
                },
                { response: { ts: NOW, providers: [] } },
              ],
            },
            "usage.status": { updatedAt: NOW, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agents.list");
        const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
        await pageScope.locator(".agent-select__trigger").click();
        await pageScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "Writer" })
          .click();
        await expect
          .poll(async () =>
            (await gateway.getRequests("models.list")).some((request) => {
              const params = request.params as Record<string, unknown> | undefined;
              return (
                params?.view === "configured" &&
                params.agentId === "writer" &&
                params.preparedOnly === true
              );
            }),
          )
          .toBe(true);

        const openaiCard = page.locator('[data-provider-id="openai"]');
        await openaiCard.waitFor();
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect
          .poll(async () => {
            const request = (await gateway.getRequests("models.list")).find((candidate) => {
              const params = candidate.params as Record<string, unknown> | undefined;
              return (
                params?.view === "configured" &&
                params.agentId === "writer" &&
                params.refresh === true
              );
            });
            return request?.params;
          })
          .toEqual({ view: "configured", agentId: "writer", refresh: true });
        await expect
          .poll(async () =>
            (
              await openaiCard.locator(".model-providers__head .settings-status").textContent()
            )?.trim(),
          )
          .toBe(status);
      },
    );
  });
});
