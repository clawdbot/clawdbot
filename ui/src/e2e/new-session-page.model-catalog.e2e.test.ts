// Covers model-catalog metadata failure and recovery on the new-session page.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const captureCatalogRetryProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const catalogRetryProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "new-session-catalog-retry",
);

function catalogDiscoveryRequests(
  requests: Array<{ params?: unknown }>,
): Array<{ params?: unknown }> {
  return requests.filter(
    ({ params }) =>
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      (params as { limitPerHost?: unknown }).limitPerHost === 1,
  );
}

suite.define(() => {
  it("selects a context window before creating a session", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-luna",
      methodResponses: {
        "sessions.create": { key: "agent:main:context-window", runStarted: true },
      },
      models: [
        {
          available: true,
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
        },
        {
          available: true,
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "anthropic",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.click();
      await page.locator('[data-chat-model-option="anthropic/claude-fable-5"]').click();
      await modelSelect.click();

      const contextWindowToggle = page.locator('[data-chat-context-window-toggle="200k"]');
      await expect.poll(() => contextWindowToggle.isVisible()).toBe(true);
      expect(await contextWindowToggle.getAttribute("aria-checked")).toBe("true");
      await contextWindowToggle.click();
      await expect
        .poll(() => page.locator("[data-chat-model-context-badge]").textContent())
        .toContain("200K");

      await page.locator(".new-session-page__message").fill("use the smaller window");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "use the smaller window",
        model: "anthropic/claude-fable-5",
        contextWindow: "200k",
      });
    } finally {
      await context.close();
    }
  });

  it("shows metadata failure truthfully and recovers when the picker opens", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const models = [
      {
        available: true,
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
      },
      {
        available: true,
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      },
      {
        available: true,
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        provider: "openai",
      },
    ];
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-luna",
      methodResponses: {
        "chat.metadata": {
          sequence: [
            {
              __mockError: {
                code: "UNAVAILABLE",
                message: "metadata request timed out",
              },
            },
            { commands: [], models },
          ],
        },
      },
      models,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("chat.metadata");

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      const errorState = page.locator('[data-chat-model-catalog-state="error"]');
      await pollLocatorText(
        errorState.locator(".chat-controls__model-catalog-state-label > span"),
      ).toBe("Models unavailable");
      expect(await errorState.count()).toBe(1);
      expect(await page.locator("[data-chat-model-option]").count()).toBe(0);

      await modelSelect.click();

      await expect.poll(async () => (await gateway.getRequests("chat.metadata")).length).toBe(2);
      expect((await gateway.getRequests("chat.metadata"))[1]?.params).toMatchObject({
        agentId: "main",
      });
      await expect.poll(() => page.locator("[data-chat-model-option]").count()).toBe(3);
      expect(await page.locator("[data-chat-model-catalog-state]").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("restores the model picker after startup-sidecars metadata becomes available", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const recoveredModel = {
      available: true,
      id: "gpt-5.6-luna",
      name: "Recovered GPT-5.6 Luna",
      provider: "openai",
      reasoning: true,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.metadata": {
          sequence: [
            {
              __mockError: {
                code: "UNAVAILABLE",
                details: { reason: "startup-sidecars" },
                message: "gateway startup sidecars are still initializing",
                retryable: true,
                retryAfterMs: 100,
              },
            },
            { commands: [], models: [recoveredModel] },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await expect.poll(async () => (await gateway.getRequests("chat.metadata")).length).toBe(2);

      const modelSelect = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await modelSelect.click();
      await expect
        .poll(() => page.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').textContent())
        .toContain(recoveredModel.name);

      // The picker's own revalidation lands after the rows render, so wait for it.
      await expect.poll(async () => (await gateway.getRequests("chat.metadata")).length).toBe(3);
      expect(await gateway.getRequests("chat.metadata")).toEqual([
        expect.objectContaining({ params: { agentId: "main" } }),
        expect.objectContaining({ params: { agentId: "main" } }),
        expect.objectContaining({ params: { agentId: "main" } }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("shows a retryable CLI-agent failure and recovers both picker catalogs", async () => {
    if (captureCatalogRetryProof) {
      await mkdir(catalogRetryProofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureCatalogRetryProof
        ? { recordVideo: { dir: catalogRetryProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const models = [
      {
        available: true,
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
      },
    ];
    const unavailable = {
      __mockError: {
        code: "UNAVAILABLE",
        message: "CLI-agent catalog is warming",
      },
    };
    const discoveryMatch = { agentId: "main", limitPerHost: 1 };
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "sessions.catalog.list",
      ],
      methodResponses: {
        "sessions.catalog.list": {
          cases: [
            { match: discoveryMatch, response: unavailable },
            { match: {}, response: { catalogs: [] } },
          ],
        },
      },
      models,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await expect
        .poll(async () =>
          catalogDiscoveryRequests(await gateway.getRequests("sessions.catalog.list")),
        )
        .toHaveLength(1);

      await page.locator('[data-chat-model-select="true"]').click();

      await expect
        .poll(async () =>
          catalogDiscoveryRequests(await gateway.getRequests("sessions.catalog.list")),
        )
        .toHaveLength(2);
      const errorState = page.locator(
        '[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]',
      );
      await expect.poll(() => errorState.isVisible()).toBe(true);
      await pollLocatorText(
        errorState.locator(".chat-controls__model-catalog-state-label > span"),
      ).toBe("CLI agents unavailable");
      const retry = page.locator('[data-chat-model-target-retry="cliAgents"]');
      await expect.poll(() => retry.isEnabled()).toBe(true);
      await pollLocatorText(retry).toContain("Retry");
      await pollLocatorText(
        page.locator(
          '[data-chat-model-option="openai/gpt-5.6-luna"] .chat-controls__model-option-name',
        ),
      ).toBe("GPT-5.6 Luna");
      expect(await page.getByText("Models unavailable", { exact: true }).count()).toBe(0);
      await expect.poll(async () => (await gateway.getRequests("chat.metadata")).length).toBe(2);
      if (captureCatalogRetryProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(catalogRetryProofDir, "01-cli-agents-retry.png"),
        });
      }

      await gateway.setMethodResponse("sessions.catalog.list", {
        cases: [
          {
            match: discoveryMatch,
            response: {
              catalogs: [
                {
                  id: "anthropic",
                  label: "Claude Code",
                  capabilities: {
                    continueSession: false,
                    archive: false,
                    createSession: { model: "anthropic/claude-sonnet-4-6" },
                  },
                  hosts: [],
                },
              ],
            },
          },
          { match: {}, response: { catalogs: [] } },
        ],
      });
      await retry.click();

      await expect
        .poll(async () =>
          catalogDiscoveryRequests(await gateway.getRequests("sessions.catalog.list")),
        )
        .toHaveLength(3);
      await expect.poll(async () => (await gateway.getRequests("chat.metadata")).length).toBe(3);
      await expect
        .poll(() => page.locator('[data-chat-model-target="anthropic"]').isVisible())
        .toBe(true);
      await pollLocatorText(
        page.locator(
          '[data-chat-model-target-group="cliAgents"] .chat-controls__provider-heading > span:last-child',
        ),
      ).toBe("CLI agents");
      await pollLocatorText(
        page.locator('[data-chat-model-target="anthropic"] .chat-controls__model-option-name'),
      ).toBe("Claude Code");
      expect(await errorState.count()).toBe(0);
      if (captureCatalogRetryProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(catalogRetryProofDir, "02-cli-agents-recovered.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
