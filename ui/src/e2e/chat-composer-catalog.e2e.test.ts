// Control UI E2E tests cover chat composer catalog discovery.
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer catalog",
});

// Browser contexts preserve test isolation; keep one process warm for this file.
suite.define(() => {
  it("refreshes the configured usable catalog after advertised chat metadata", async () => {
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
      // The advertised default stays visible as a setup action while the usable
      // model remains selectable.
      const unavailableDefault = composer.locator('[data-chat-model-default="true"]');
      await expect.poll(() => unavailableDefault.count()).toBe(1);
      await expect.poll(() => unavailableDefault.getAttribute("disabled")).toBeNull();
      await expect
        .poll(() => unavailableDefault.getAttribute("data-chat-model-setup"))
        .toBe("true");
      await expect.poll(() => composer.locator('[data-chat-model-option=""]').count()).toBe(0);
    });
  });

  it("keeps an auth-cold configured catalog visible and blocks chat until setup", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          available: false,
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available: false,
        },
      ];
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.6-sol",
        models,
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: {
              contextTokens: 200_000,
              model: "gpt-5.6-sol",
              modelProvider: "openai",
            },
            path: "",
            sessions: [
              {
                key: "main",
                kind: "direct",
                model: "gpt-5.6-sol",
                modelProvider: "openai",
                status: "done",
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      const picker = composer.locator("details.chat-controls__model-picker");
      const options = picker.locator(
        "button[data-chat-model-option]:not([data-chat-model-target])",
      );
      await picker.locator("summary").click();
      await gateway.waitForRequest("models.list");
      await expect.poll(() => options.count()).toBe(2);
      await expect.poll(() => options.last().isVisible()).toBe(true);
      await expect.poll(() => options.first().textContent()).toContain("GPT-5.6 Sol");
      await expect.poll(() => options.first().textContent()).toContain("Default");
      await expect.poll(() => options.first().textContent()).toContain("Sign-in needed");
      await expect
        .poll(() =>
          options.evaluateAll(
            (rows) =>
              rows.every((row) => !row.hasAttribute("disabled")) &&
              rows.every((row) => row.getAttribute("data-chat-model-setup") === "true"),
          ),
        )
        .toBe(true);
      await expect
        .poll(() => composer.locator(".chat-controls__model-catalog-state").textContent())
        .toContain("Review the provider credential or sign-in, then retry");
      await expect.poll(() => composer.locator("textarea").isDisabled()).toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await composer.screenshot({
          animations: "disabled",
          path: `${artifactDir}/auth-cold-model-picker.png`,
        });
      }
      await options.first().click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
    });
  });

  it("loads agent-scoped startup models when the route switches sessions", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const workModel = {
        id: "work-model",
        name: "Work Model",
        provider: "openai",
        available: true,
      };
      const otherModel = {
        id: "other-model",
        name: "Other Model",
        provider: "anthropic",
        available: true,
      };
      const startupResponse = (sessionId: string, model: typeof workModel) => ({
        agentsList: {
          agents: [
            { id: "work", name: "Work" },
            { id: "other", name: "Other" },
          ],
          defaultId: "work",
          mainKey: "main",
          scope: "agent",
        },
        messages: [],
        metadata: { commands: [], models: [model] },
        sessionId,
        thinkingLevel: null,
      });
      const gateway = await installMockGateway(page, {
        defaultAgentId: "work",
        sessionKey: "agent:work:main",
        methodResponses: {
          "chat.startup": {
            cases: [
              {
                match: { sessionKey: "agent:work:main" },
                response: startupResponse("work-session", workModel),
              },
              {
                match: { sessionKey: "agent:other:main" },
                response: startupResponse("other-session", otherModel),
              },
            ],
          },
          "models.list": {
            cases: [
              {
                match: { agentId: "other", view: "configured" },
                response: { models: [otherModel] },
              },
            ],
          },
          "sessions.list": {
            count: 2,
            defaults: {
              contextTokens: 200_000,
              model: "other-model",
              modelProvider: "anthropic",
            },
            path: "",
            sessions: [
              {
                key: "agent:work:main",
                kind: "direct",
                model: "work-model",
                modelProvider: "openai",
                status: "done",
                updatedAt: Date.now(),
              },
              {
                key: "agent:other:main",
                kind: "direct",
                model: "other-model",
                modelProvider: "anthropic",
                status: "done",
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
        models: [workModel],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);

      const activeComposer = () =>
        page.locator('openclaw-chat-pane[aria-hidden="false"] .agent-chat__input');
      await expect
        .poll(() =>
          activeComposer().locator('[data-chat-model-option="openai/work-model"]').count(),
        )
        .toBe(1);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      await navigateToControlUiSession(page, "agent:other:main");
      const startupRequests = await gateway.getRequests("chat.startup");
      expect(
        startupRequests.filter(
          (request) =>
            (request.params as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:other:main",
        ),
      ).toHaveLength(1);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      await expect
        .poll(() =>
          activeComposer().locator('[data-chat-model-option="anthropic/other-model"]').count(),
        )
        .toBe(1);
      await expect
        .poll(() =>
          activeComposer().locator('[data-chat-model-option="openai/work-model"]').count(),
        )
        .toBe(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    });
  });

  it("keeps startup models visible and retries discovery when the picker reopens", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const startupModel = {
        id: "startup-model",
        name: "Startup Model",
        provider: "openai",
        available: true,
      };
      const discoveredModel = {
        id: "discovered-model",
        name: "Discovered Model",
        provider: "anthropic",
        available: true,
      };
      const gateway = await installMockGateway(page, {
        models: [startupModel],
        methodResponses: {
          "models.list": {
            sequence: [
              {
                __mockError: {
                  code: "UNAVAILABLE",
                  message: "catalog discovery failed",
                },
              },
              { models: [startupModel, discoveredModel] },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      await composer.locator('[data-chat-model-select="true"]').click();
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(1);
      await expect.poll(() => composer.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/startup-model"]').isVisible())
        .toBe(true);

      await composer.locator('[data-chat-model-select="true"]').click();
      await composer.locator('[data-chat-model-select="true"]').click();

      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
      await expect
        .poll(() =>
          composer.locator('[data-chat-model-option="anthropic/discovered-model"]').isVisible(),
        )
        .toBe(true);
      expect(await composer.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toEqual(expect.objectContaining({ view: "configured" }));
        expect(request.params).not.toEqual(expect.objectContaining({ preparedOnly: true }));
      }
    });
  });

  it("retires an empty picker snapshot when the Gateway reconnects", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const routedModel = {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: true,
      };
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.6-luna",
        models: [routedModel],
        methodResponses: {
          "models.list": {
            sequence: [{ models: [] }, { models: [routedModel] }],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const pickerTrigger = composer.locator('[data-chat-model-select="true"]');
      await pickerTrigger.click();
      await gateway.waitForRequest("models.list");
      await expect
        .poll(() => composer.locator("[data-chat-model-catalog-state]").textContent())
        .toContain("No models available");
      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: `${artifactDir}/01-empty-catalog-before-reconnect.png`,
        });
      }
      await pickerTrigger.click();

      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await gateway.setOnline(false);
      await expect.poll(() => pickerTrigger.getAttribute("aria-disabled")).toBe("true");
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: startupCount });
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').count())
        .toBe(1);

      await pickerTrigger.click();
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').isVisible())
        .toBe(true);
      await expect.poll(() => composer.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: `${artifactDir}/02-routable-model-after-reconnect.png`,
        });
      }
    });
  });

  it("refreshes a successful account catalog after the picker cooldown", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const initialTime = new Date("2026-08-21T12:00:00Z");
      await page.clock.setFixedTime(initialTime);
      const existingModel = {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: true,
      };
      const newlyAvailableModel = {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        provider: "openai",
        available: true,
      };
      const gateway = await installMockGateway(page, {
        models: [existingModel],
        methodResponses: {
          "models.list": {
            sequence: [
              { models: [existingModel] },
              { models: [existingModel, newlyAvailableModel] },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const pickerTrigger = composer.locator('[data-chat-model-select="true"]');
      await pickerTrigger.click();
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(1);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').isVisible())
        .toBe(true);
      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: `${artifactDir}/01-account-catalog-before-refresh.png`,
        });
      }

      await pickerTrigger.click();
      await page.clock.setFixedTime(new Date(initialTime.getTime() + 60_000 + 1));
      await pickerTrigger.click();
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(1);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/gpt-5.6-terra"]').count())
        .toBe(0);

      await pickerTrigger.click();
      await page.clock.setFixedTime(new Date(initialTime.getTime() + 5 * 60_000 + 1));
      await pickerTrigger.click();

      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/gpt-5.6-terra"]').isVisible())
        .toBe(true);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: `${artifactDir}/02-account-catalog-after-refresh.png`,
        });
      }
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toEqual(
          expect.objectContaining({ agentId: "main", refresh: true, view: "configured" }),
        );
      }
    });
  });

  it.each([
    [1280, 900, "desktop"],
    [390, 844, "mobile"],
  ] as const)(
    "restores the native composer placeholder after a whitespace-only %s draft",
    async (width, height, label) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");

        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        await textarea.fill("   ");
        await textarea.blur();

        await expect.poll(() => textarea.inputValue()).toBe("");
        await expect
          .poll(() => textarea.evaluate((node) => node.matches(":placeholder-shown")))
          .toBe(true);
        await expect.poll(() => textarea.getAttribute("placeholder")).toContain("Message");
        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await page.locator(".agent-chat__composer-shell").screenshot({
            animations: "disabled",
            path: `${artifactDir}/placeholder-${label}.png`,
          });
        }
      });
    },
  );
});
