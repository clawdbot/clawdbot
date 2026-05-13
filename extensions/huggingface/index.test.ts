import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, describe, expect, it, vi } from "vitest";

const buildHuggingfaceProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    baseUrl: "https://router.huggingface.co/v1",
    api: "openai-completions",
    models: [],
  })),
);

vi.mock("./provider-catalog.js", () => ({
  buildHuggingfaceProvider: buildHuggingfaceProviderMock,
}));

vi.mock("./onboard.js", () => ({
  applyHuggingfaceConfig: vi.fn((cfg) => cfg),
  HUGGINGFACE_DEFAULT_MODEL_REF: "huggingface/deepseek-ai/DeepSeek-R1",
}));

import plugin from "./index.js";

function registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "huggingface",
      name: "Hugging Face",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  const firstCall = registerProviderMock.mock.calls[0];
  if (!firstCall) {
    throw new Error("expected huggingface provider registration");
  }
  return firstCall[0];
}

describe("huggingface plugin", () => {
  afterAll(() => {
    vi.doUnmock("./provider-catalog.js");
    vi.doUnmock("./onboard.js");
    vi.resetModules();
  });

  it("skips catalog discovery when plugin discovery is disabled", async () => {
    const provider = registerProvider();

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            huggingface: {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      resolveProviderApiKey: () => ({
        apiKey: "hf_test_token",
        discoveryApiKey: "hf_test_token",
      }),
    } as never);

    expect(result).toBeNull();
    expect(buildHuggingfaceProviderMock).not.toHaveBeenCalled();
  });
});
