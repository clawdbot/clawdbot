import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { modelPickerValue, selectModelPicker } from "./model-providers.e2e.test-support.ts";

const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
const suite = createControlUiE2eSuite({ name: "Control UI Models reconnect" });

suite.define(() => {
  it("reloads the selected agent and clears a failed model draft after reconnect", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1280 },
        ...(recordVisuals
          ? {
              recordVideo: {
                dir: suite.artifactDir,
                size: { height: 1000, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
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
                {
                  id: "initial-model",
                  name: "Initial Model",
                  provider: "openai",
                  available: true,
                },
                {
                  id: "saved-model",
                  name: "Saved Model",
                  provider: "openai",
                  available: true,
                },
                {
                  id: "failed-draft",
                  name: "Failed Draft",
                  provider: "openai",
                  available: true,
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
                  profiles: [{ profileId: "openai:writer", type: "oauth", status: "ok" }],
                },
              ],
            },
            "usage.status": { updatedAt: NOW, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const agentPicker = page.locator(".agent-scope-control openclaw-agent-select");
        await agentPicker.locator(".agent-select__trigger").click();
        await agentPicker.locator('wa-dropdown-item[aria-label="Writer"]').click();
        await expect
          .poll(async () =>
            (await agentPicker.locator(".agent-select__label").textContent())?.trim(),
          )
          .toBe("Writer");
        await expect
          .poll(() =>
            modelPickerValue(page.locator(".model-providers__defaults wa-select").first()),
          )
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
        const savedPatchCount = (await gateway.getRequests("config.patch")).length;
        await selectModelPicker(primary, "openai/saved-model");
        await gateway.waitForRequest("config.patch", { after: savedPatchCount });
        await expect
          .poll(async () => page.getByRole("status").filter({ hasText: "Defaults saved" }).count())
          .toBeGreaterThan(0);

        await gateway.deferNext("config.patch");
        const failedPatchCount = (await gateway.getRequests("config.patch")).length;
        await selectModelPicker(primary, "openai/failed-draft");
        await gateway.waitForRequest("config.patch", { after: failedPatchCount });
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "synthetic model save rejected",
        });
        await page
          .getByRole("alert")
          .filter({ hasText: "synthetic model save rejected" })
          .waitFor();
        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(suite.artifactDir, "05-reconnect-save-error.png"),
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
          .poll(() =>
            modelPickerValue(page.locator(".model-providers__defaults wa-select").first()),
          )
          .toBe("openai/reconnected-model");
        await expect.poll(() => page.getByRole("alert").count()).toBe(0);
        await expect
          .poll(async () =>
            (await agentPicker.locator(".agent-select__label").textContent())?.trim(),
          )
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
            path: path.join(suite.artifactDir, "06-reconnected-model.png"),
          });
        }
      },
    );
  });
});
