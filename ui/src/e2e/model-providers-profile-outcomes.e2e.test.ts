import path from "node:path";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model provider profile outcomes" });
const NOW = Date.now();

suite.define(() => {
  it("lifts an account, makes room during dragging, and saves its dropped priority", async () => {
    const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1280 },
        ...(recordVisuals
          ? { recordVideo: { dir: suite.artifactDir, size: { height: 1000, width: 1280 } } }
          : {}),
      },
      async ({ page }) => {
        const provider = {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [
            { profileId: "openai:alex", type: "oauth", status: "ok", email: "alex@example.com" },
            { profileId: "openai:blair", type: "oauth", status: "ok", email: "blair@example.com" },
          ],
          profileOrder: ["openai:alex", "openai:blair"],
        };
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "models.authOrderSet"],
          models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
          methodResponses: {
            "config.get": {
              config: {},
              sourceConfig: {},
              hash: "roster",
              raw: "{}",
              valid: true,
              issues: [],
            },
            "models.authStatus": { ts: NOW, providers: [provider] },
            "usage.status": { updatedAt: NOW, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const card = page.locator('[data-provider-id="openai"]');
        const alex = card.locator('[data-profile-id="openai:alex"]');
        const blair = card.locator('[data-profile-id="openai:blair"]');
        const grip = alex.locator(".model-providers__profile-grip");
        await expect.poll(() => grip.isEnabled()).toBe(true);
        await grip.scrollIntoViewIfNeeded();
        const start = await grip.boundingBox();
        const first = await alex.boundingBox();
        const second = await blair.boundingBox();
        if (!start || !first || !second) {
          throw new Error("Expected both account rows and the drag handle to be visible");
        }
        await gateway.deferNext("models.authOrderSet");
        const x = start.x + start.width / 2;
        const y = start.y + start.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + first.height * 0.75, { steps: 6 });
        await expect.poll(async () => (await alex.boundingBox())?.y).toBeGreaterThan(first.y);
        await expect.poll(async () => (await blair.boundingBox())?.y).toBeLessThan(second.y);
        expect(await gateway.getRequests("models.authOrderSet")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({ path: path.join(suite.artifactDir, "account-lifted.png") });
        }
        await page.mouse.up();
        const request = await gateway.waitForRequest("models.authOrderSet");
        const profileIds = ["openai:blair", "openai:alex"];
        expect(request.params).toEqual({ agentId: "main", provider: "openai", profileIds });
        const visibleOrder = () =>
          card
            .locator(".model-providers__profile")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-profile-id")));
        await expect.poll(visibleOrder).toEqual(profileIds);
        expect(await card.getByText("Saving", { exact: true }).count()).toBe(0);
        await gateway.setMethodResponse("models.authStatus", {
          ts: NOW,
          providers: [{ ...provider, profileOrder: profileIds, profileOrderStored: true }],
        });
        await gateway.resolveDeferred("models.authOrderSet", { provider: "openai", profileIds });
        await card.getByRole("button", { name: "Clear custom order", exact: true }).waitFor();
        await expect.poll(visibleOrder).toEqual(profileIds);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "account-priority-saved.png"),
          });
        }
      },
    );
  });

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
