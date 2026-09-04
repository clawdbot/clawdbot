/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendPage,
  chooseProviderSetup,
  createProviderSetupHarness,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage setup routing", () => {
  it("routes selected provider setup to its available surface", async () => {
    const { context, request, runtimeConfig } = createProviderSetupHarness();
    const authChoice = "github-copilot";
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-5",
            fallbacks: ["local-cli/current-model"],
          },
        },
      },
    };
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { config, sourceConfig: config, hash: "config-hash", valid: true, issues: [] };
      }
      if (method === "models.authStatus") {
        return {
          ts: 1,
          providers: [],
          providerCapabilities: [
            {
              provider: "github-copilot",
              apiKeySupported: false,
              quickApiKeySetup: false,
            },
            {
              provider: "local-cli",
              apiKeySupported: false,
              quickApiKeySetup: false,
              setupActions: [
                {
                  choiceId: "local-cli-reconnect",
                  label: "Local CLI",
                  actionLabel: "Reconnect",
                },
              ],
            },
          ],
        };
      }
      if (method === "openclaw.setup.detect") {
        return {
          candidates: [],
          manualProviders: [],
          authOptions: [
            {
              id: authChoice,
              brandId: "github-copilot",
              groupLabel: "Copilot",
              label: "GitHub Copilot",
              hint: "Device login with your GitHub account",
              kind: "device-code",
              featured: false,
            },
            {
              id: "local-cli-oauth",
              brandId: "local-cli",
              groupLabel: "Local CLI",
              label: "OAuth",
              kind: "oauth",
              featured: false,
            },
          ],
          prepareOptions: [
            {
              id: "local-cli-reconnect",
              brandId: "local-cli",
              label: "Local CLI",
            },
          ],
          workspace: "/tmp/workspace",
          setupComplete: true,
        };
      }
      return originalRequest(method);
    });
    await runtimeConfig.ensureLoaded();
    const page = appendPage(context);
    try {
      await chooseProviderSetup(page, authChoice);
      const values = [
        ...(page.querySelector<HTMLSelectElement>(".model-providers__add-form select")?.options ??
          []),
      ].map((option) => option.value);
      expect(values).not.toContain("local-cli-reconnect");
      expect(values).toContain("local-cli-oauth");
    } finally {
      page.remove();
      runtimeConfig.dispose();
    }
  });
});
