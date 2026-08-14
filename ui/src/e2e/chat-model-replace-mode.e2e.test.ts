import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI replace-mode model catalog",
});

suite.define(() => {
  it("explains model filtering in replace mode", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }];
      const gateway = await installMockGateway(page, {
        models,
        methodResponses: {
          "chat.startup": {
            agentsList: {
              agents: [{ id: "main", name: "OpenClaw" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            messages: [],
            metadata: {
              catalogMode: "replace",
              commands: [],
              models,
            },
            sessionId: "control-ui-e2e-session",
            thinkingLevel: null,
          },
          "models.list": {
            catalogMode: "replace",
            models,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      await composer.locator('[data-chat-model-select="true"]').click();
      const hint = composer.locator(".chat-controls__catalog-hint");
      expect(await gateway.getRequests("models.list")).toEqual([
        expect.objectContaining({ params: { view: "configured" } }),
      ]);
      await expect
        .poll(async () => (await hint.textContent())?.replace(/\s+/g, " ").trim())
        .toBe("Replace mode filters models according to your model settings. Manage models");
      await expect
        .poll(() => hint.getByRole("link", { name: "Manage models" }).getAttribute("href"))
        .toBe("/settings/model-providers");
    });
  });

  it("keeps the replace-mode hint after chat metadata refresh", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.3-codex-spark",
        models: [
          { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
          {
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            provider: "codex",
            available: false,
          },
        ],
        methodResponses: {
          "chat.startup": {
            agentsList: {
              agents: [{ id: "main", name: "OpenClaw" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            messages: [],
            sessionId: "control-ui-e2e-session",
            thinkingLevel: null,
          },
          "chat.metadata": {
            catalogMode: "replace",
            commands: [],
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
              {
                id: "gpt-5.3-codex-spark",
                name: "GPT-5.3 Codex Spark",
                provider: "codex",
                available: false,
              },
            ],
          },
          "sessions.list": {
            count: 1,
            defaults: {
              contextTokens: 200_000,
              model: "gpt-5.3-codex-spark",
              modelProvider: "openai",
            },
            path: "",
            sessions: [
              {
                contextTokens: 200_000,
                displayName: "Main",
                hasActiveRun: false,
                key: "main",
                kind: "direct",
                label: "Main",
                model: "gpt-5.5",
                modelProvider: "openai",
                status: "done",
                totalTokens: 0,
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      const providers = composer.locator("[data-chat-model-provider]");
      await expect
        .poll(async () => (await providers.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI"]);
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.5");
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="codex"]').count())
        .toBe(0);
      // The advertised default is configured but unavailable, so its row stays
      // visible and disabled while the usable model remains selectable.
      const unavailableDefault = composer.locator('[data-chat-model-default="true"]');
      await expect.poll(() => unavailableDefault.count()).toBe(1);
      await expect.poll(() => unavailableDefault.getAttribute("disabled")).not.toBeNull();
      await expect.poll(() => composer.locator('[data-chat-model-option=""]').count()).toBe(0);
      await composer.locator('[data-chat-model-select="true"]').click();
      const hint = composer.locator(".chat-controls__catalog-hint");
      await expect
        .poll(async () => (await hint.textContent())?.replace(/\s+/g, " ").trim())
        .toBe("Replace mode filters models according to your model settings. Manage models");
      await expect
        .poll(() => hint.getByRole("link", { name: "Manage models" }).getAttribute("href"))
        .toBe("/settings/model-providers");
    });
  });
});
