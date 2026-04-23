import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
  githubCopilotLoginCommand: vi.fn(),
  fetchCopilotUsage: vi.fn(),
}));

import plugin from "./index.js";

function _registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "github-copilot",
      name: "GitHub Copilot",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("github-copilot plugin", () => {
  it("registers embedding provider", () => {
    const registerMemoryEmbeddingProviderMock = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider: vi.fn(),
        registerMemoryEmbeddingProvider: registerMemoryEmbeddingProviderMock,
      }),
    );

    expect(registerMemoryEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    const adapter = registerMemoryEmbeddingProviderMock.mock.calls[0]?.[0];
    expect(adapter.id).toBe("github-copilot");
  });

  it("skips catalog discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(result).toBeNull();
    expect(resolveCopilotApiTokenMock).not.toHaveBeenCalled();
  });

  it("uses live plugin config to re-enable discovery after startup disable", async () => {
    resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot_api_token",
      baseUrl: "https://api.githubcopilot.live",
    });
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: true },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "gh_test_token",
      env: { GH_TOKEN: "gh_test_token" },
    });
    expect(result).toEqual({
      provider: {
        baseUrl: "https://api.githubcopilot.live",
        models: [],
      },
    });
  });
});
