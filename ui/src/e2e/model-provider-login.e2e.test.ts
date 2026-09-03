import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI provider login", () => {
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

  it("signs in without changing the configured model", async () => {
    const artifactDir = recordVisuals
      ? createControlUiE2eArtifactDir("model-provider-login")
      : undefined;
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const authCapabilities = [
      {
        provider: "xai",
        apiKeySupported: true,
        accessOptions: [{ id: "xai-oauth", label: "xAI OAuth", mode: "login" }],
      },
    ];
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: { xai: { models: [{ id: "grok-4.5", name: "Grok 4.5" }] } },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.patch",
        "openclaw.setup.auth.start",
        "models.authLogout",
        "wizard.next",
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "provider-login-config",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "models.list": {
          models: [
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
            {
              id: "grok-4.5",
              name: "Grok 4.5",
              provider: "xai",
              available: false,
              unavailableReason: "missing-auth",
            },
          ],
        },
        "models.authStatus": {
          ts: 1,
          providerCapabilities: authCapabilities,
          providers: [],
        },
        "openclaw.setup.auth.start": {
          sessionId: "xai-login-session",
          done: false,
          status: "running",
        },
        "models.authLogout": {
          provider: "xai",
          removedProfiles: ["xai:owner"],
          abortedRunIds: [],
        },
        "wizard.next": {
          sequence: [
            {
              done: false,
              status: "running",
              step: {
                id: "xai-device-code",
                type: "note",
                title: "xAI OAuth",
                message: "Open the xAI sign-in page.",
                externalUrl: "https://accounts.x.ai/oauth2/device",
                deviceCode: { code: "XAI-ABCD", expiresInMinutes: 10 },
              },
            },
            { done: true, status: "done" },
          ],
        },
        "usage.status": { updatedAt: 1, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const xaiCard = page.locator('[data-provider-id="xai"]');
      await xaiCard.waitFor();
      await xaiCard.getByRole("button", { name: "Sign in with xAI OAuth" }).click();

      const start = await gateway.waitForRequest("openclaw.setup.auth.start");
      expect(start.params).toEqual(
        expect.objectContaining({ agentId: "main", authChoice: "xai-oauth" }),
      );
      expect(start.params).not.toHaveProperty("sessionId");
      await page.getByText("XAI-ABCD").waitFor();
      await expect
        .poll(() => page.getByRole("link", { name: "Open sign-in page" }).getAttribute("href"))
        .toBe("https://accounts.x.ai/oauth2/device");
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "device-code.png"),
        });
      }

      await gateway.setMethodResponse("models.authStatus", {
        ts: 2,
        providerCapabilities: authCapabilities,
        providers: [
          {
            provider: "xai",
            displayName: "xAI",
            status: "ok",
            profiles: [
              {
                profileId: "xai:owner",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
            ],
          },
        ],
      });
      await gateway.deferNext("models.authStatus");
      await page.getByRole("button", { name: "Continue" }).click();

      await page.getByRole("status").filter({ hasText: "Signed in." }).waitFor();
      await gateway.resolveDeferred("models.authStatus");
      await expect.poll(async () => xaiCard.textContent()).toContain("Signed in");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await expect
        .poll(() =>
          page
            .locator(".model-providers__defaults wa-select")
            .first()
            .evaluate((element) => String((element as HTMLElement & { value?: string }).value)),
        )
        .toBe("openai/gpt-5.5");

      await gateway.setMethodResponse("models.list", {
        models: [
          { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
          { id: "grok-4.5", name: "Grok 4.5", provider: "xai", available: true },
        ],
      });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect
        .poll(() => page.locator('wa-option[value="xai/grok-4.5"]').count())
        .toBeGreaterThan(0);
      await expect.poll(async () => xaiCard.textContent()).toContain("1 model");
      const openaiCard = page.locator('[data-provider-id="openai"]');
      await expect.poll(async () => openaiCard.textContent()).toContain("1 model");

      await gateway.deferNext("models.authLogout");
      await xaiCard.getByRole("button", { name: "Log out", exact: true }).click();
      const confirm = xaiCard.getByRole("alert");
      await confirm.getByRole("button", { name: "Log out", exact: true }).click();
      await gateway.waitForRequest("models.authLogout");
      await gateway.setMethodResponse("models.authStatus", {
        ts: 3,
        providerCapabilities: authCapabilities,
        providers: [],
      });
      await gateway.setMethodResponse("models.list", {
        models: [
          { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
          {
            id: "grok-4.5",
            name: "Grok 4.5",
            provider: "xai",
            available: false,
            unavailableReason: "missing-auth",
          },
        ],
      });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await gateway.resolveDeferred("models.authLogout", {
        provider: "xai",
        removedProfiles: ["xai:owner"],
        abortedRunIds: [],
      });
      await xaiCard.getByRole("button", { name: "Sign in with xAI OAuth" }).waitFor();
      await expect.poll(async () => xaiCard.textContent()).not.toContain("Signed in");
      await expect.poll(async () => openaiCard.textContent()).toContain("1 model");
      await expect
        .poll(() =>
          page
            .locator(".model-providers__defaults wa-select")
            .first()
            .evaluate((element) => String((element as HTMLElement & { value?: string }).value)),
        )
        .toBe("openai/gpt-5.5");
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toEqual({
          agentId: "main",
          preparedOnly: true,
          view: "configured",
        });
      }
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "signed-in.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("uses the shared wizard for masked credentials and provider setup", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const accessCapabilities = [
      {
        provider: "groq",
        apiKeySupported: true,
        accessOptions: [{ id: "groq-api-key", label: "Groq API key", mode: "login" }],
      },
      {
        provider: "vllm",
        apiKeySupported: false,
        accessOptions: [{ id: "vllm", label: "vLLM", mode: "setup" }],
      },
    ];
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          groq: {
            models: [
              {
                id: "llama-3.3-70b",
                name: "Llama 3.3 70B",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 8192,
              },
            ],
          },
          vllm: { models: [{ id: "local-model", name: "Local model" }] },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.patch",
        "openclaw.setup.auth.start",
        "models.authLogout",
        "openclaw.setup.prepare.start",
        "wizard.next",
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "provider-access-config",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "models.list": {
          models: [
            {
              id: "llama-3.3-70b",
              name: "Llama 3.3 70B",
              provider: "groq",
              available: false,
              unavailableReason: "missing-auth",
            },
            {
              id: "local-model",
              name: "Local model",
              provider: "vllm",
              available: false,
              unavailableReason: "missing-auth",
            },
          ],
        },
        "models.authStatus": {
          ts: 1,
          providerCapabilities: accessCapabilities,
          providers: [],
        },
        "openclaw.setup.auth.start": {
          sessionId: "groq-login-session",
          done: false,
          status: "running",
        },
        "models.authLogout": {
          provider: "groq",
          removedProfiles: ["groq:default"],
          abortedRunIds: [],
        },
        "openclaw.setup.prepare.start": {
          sessionId: "vllm-setup-session",
          done: false,
          status: "running",
        },
        "wizard.next": {
          sequence: [
            {
              done: false,
              status: "running",
              step: {
                id: "groq-key",
                type: "text",
                message: "Enter Groq API key",
                sensitive: true,
              },
            },
            { done: true, status: "done" },
          ],
        },
        "usage.status": { updatedAt: 1, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const groqCard = page.locator('[data-provider-id="groq"]');
      await groqCard.getByRole("button", { name: "Sign in with Groq API key" }).click();
      const secretInput = page.getByLabel("Enter Groq API key");
      await secretInput.waitFor();
      expect(await secretInput.getAttribute("type")).toBe("password");
      await secretInput.fill("test-groq-key");
      await gateway.setMethodResponse("models.authStatus", {
        ts: 2,
        providerCapabilities: accessCapabilities,
        providers: [
          {
            provider: "groq",
            displayName: "Groq",
            status: "static",
            profiles: [
              {
                profileId: "groq:default",
                type: "api_key",
                status: "static",
                logoutSupported: true,
              },
            ],
          },
        ],
      });
      await gateway.setMethodResponse("models.list", {
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            provider: "groq",
            available: true,
          },
          {
            id: "local-model",
            name: "Local model",
            provider: "vllm",
            available: false,
            unavailableReason: "missing-auth",
          },
        ],
      });
      await page.getByRole("button", { name: "Submit" }).click();
      await page.getByRole("status").filter({ hasText: "Signed in." }).waitFor();
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect.poll(async () => groqCard.textContent()).toContain("Signed in");
      await expect
        .poll(() => page.locator('wa-option[value="groq/llama-3.3-70b"]').count())
        .toBeGreaterThan(0);

      await gateway.deferNext("models.authLogout");
      await groqCard.getByRole("button", { name: "Log out", exact: true }).click();
      await groqCard
        .getByRole("alert")
        .getByRole("button", { name: "Log out", exact: true })
        .click();
      const logout = await gateway.waitForRequest("models.authLogout");
      expect(logout.params).toEqual({
        agentId: "main",
        provider: "groq",
        profileIds: ["groq:default"],
      });
      await gateway.setMethodResponse("models.authStatus", {
        ts: 3,
        providerCapabilities: accessCapabilities,
        providers: [],
      });
      await gateway.setMethodResponse("models.list", {
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            provider: "groq",
            available: false,
            unavailableReason: "missing-auth",
          },
          {
            id: "local-model",
            name: "Local model",
            provider: "vllm",
            available: false,
            unavailableReason: "missing-auth",
          },
        ],
      });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await gateway.resolveDeferred("models.authLogout", {
        provider: "groq",
        removedProfiles: ["groq:default"],
        abortedRunIds: [],
      });
      await groqCard.getByRole("button", { name: "Sign in with Groq API key" }).waitFor();
      await expect.poll(async () => groqCard.textContent()).not.toContain("Signed in");
      await expect
        .poll(() => page.locator('wa-option[value="groq/llama-3.3-70b"]').count())
        .toBe(0);

      await gateway.setMethodResponse("wizard.next", {
        sequence: [
          {
            done: false,
            status: "running",
            step: {
              id: "vllm-url",
              type: "text",
              message: "vLLM base URL",
              placeholder: "http://127.0.0.1:8000/v1",
            },
          },
          { done: true, status: "done" },
        ],
      });
      await page.getByRole("button", { name: "Set up vLLM" }).click();
      await page.getByLabel("vLLM base URL").fill("http://127.0.0.1:8000/v1");
      await page.getByRole("button", { name: "Submit" }).click();
      await page.getByRole("status").filter({ hasText: "Configured" }).waitFor();

      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
      expect(await gateway.getRequests("openclaw.setup.prepare.start")).toHaveLength(1);
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toEqual({
          agentId: "main",
          preparedOnly: true,
          view: "configured",
        });
      }
    } finally {
      await context.close();
    }
  });
});
