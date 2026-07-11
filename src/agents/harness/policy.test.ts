import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentHarnessPolicy } from "./policy.js";

function openAIProviderConfig(overrides: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [],
          ...overrides,
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolveAgentHarnessPolicy", () => {
  it.each([
    {
      name: "official Responses route",
      params: { config: openAIProviderConfig({}) },
      runtime: "codex",
    },
    {
      name: "HTTP official Responses route",
      params: { config: openAIProviderConfig({ baseUrl: "http://api.openai.com/v1" }) },
      runtime: "openclaw",
    },
    {
      name: "HTTP official ChatGPT route",
      params: {
        config: openAIProviderConfig({
          api: "openai-chatgpt-responses",
          baseUrl: "http://chatgpt.com/backend-api/codex",
        }),
      },
      runtime: "openclaw",
    },
    {
      name: "custom endpoint",
      params: { config: openAIProviderConfig({ baseUrl: "https://relay.example.test/v1" }) },
      runtime: "openclaw",
    },
    {
      name: "authored Completions route",
      params: { config: openAIProviderConfig({ api: "openai-completions" }) },
      runtime: "openclaw",
    },
    {
      name: "request override",
      params: { config: openAIProviderConfig({ headers: { "x-route": "custom" } }) },
      runtime: "openclaw",
    },
  ])("uses the provider-owned runtime for $name", ({ params, runtime }) => {
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        env: {},
        ...params,
      }),
    ).toEqual({ runtime, runtimeSource: "implicit" });
  });

  it("keeps explicit runtime policy authoritative", () => {
    const config = openAIProviderConfig({ agentRuntime: { id: "codex" } });
    config.agents = { defaults: { params: { temperature: 0.2 } } };
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        env: {},
      }),
    ).toEqual({ runtime: "codex", runtimeSource: "provider" });
  });

  it.each(["default", "auto"] as const)(
    "treats configured %s runtime policy as implicit route selection",
    (runtime) => {
      expect(
        resolveAgentHarnessPolicy({
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          config: {
            models: {
              providers: {
                anthropic: {
                  api: "anthropic-messages",
                  baseUrl: "https://api.anthropic.com",
                  agentRuntime: { id: runtime },
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
          env: {},
        }),
      ).toEqual({ runtime: "auto", runtimeSource: "implicit" });
      expect(
        resolveAgentHarnessPolicy({
          provider: "openai",
          modelId: "gpt-5.5",
          config: openAIProviderConfig({ agentRuntime: { id: runtime } }),
          env: {},
        }),
      ).toEqual({ runtime: "codex", runtimeSource: "implicit" });
      const customConfig = openAIProviderConfig({
        baseUrl: "https://relay.example.test/v1",
      });
      customConfig.agents = {
        defaults: {
          models: { "openai/gpt-5.5": { agentRuntime: { id: runtime } } },
        },
      };
      expect(
        resolveAgentHarnessPolicy({
          provider: "openai",
          modelId: "gpt-5.5",
          config: customConfig,
          env: {},
        }),
      ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
    },
  );

  it.each([
    {
      name: "global params",
      agents: { defaults: { params: { temperature: 0.2 } } },
      agentId: undefined,
      sessionKey: undefined,
    },
    {
      name: "model params",
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": { params: { text_verbosity: "low" } } },
        },
      },
      agentId: undefined,
      sessionKey: undefined,
    },
    {
      name: "agent params",
      agents: { list: [{ id: "writer", params: { temperature: 0.2 } }] },
      agentId: "writer",
      sessionKey: undefined,
    },
    {
      name: "session agent params",
      agents: { list: [{ id: "writer", params: { temperature: 0.2 } }] },
      agentId: undefined,
      sessionKey: "agent:writer:main",
    },
  ])("keeps $name on OpenClaw", ({ agents, agentId, sessionKey }) => {
    const config = openAIProviderConfig({});
    config.agents = agents;
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        agentId,
        sessionKey,
        env: {},
      }),
    ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
  });

  it("keeps prepared request overrides on OpenClaw", () => {
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "present",
        env: {},
      }),
    ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
  });

  it("applies global request params before a concrete model is selected", () => {
    const config = openAIProviderConfig({});
    config.agents = { defaults: { params: { temperature: 0.2 } } };
    expect(resolveAgentHarnessPolicy({ provider: "openai", config, env: {} })).toEqual({
      runtime: "openclaw",
      runtimeSource: "implicit",
    });
  });

  it.each([
    {
      name: "later route facts fill an omitted adapter",
      models: [{ id: "gpt-5.5" }, { id: "gpt-5.5", api: "openai-completions" }],
      runtime: "openclaw",
    },
    {
      name: "a provider-looking native id stays distinct",
      models: [
        { id: "openai/gpt-5.5", api: "openai-responses" },
        { id: "gpt-5.5", api: "openai-completions" },
      ],
      runtime: "openclaw",
    },
    {
      name: "an authored empty header map stays authoritative",
      models: [
        { id: "gpt-5.5", headers: {} },
        { id: "gpt-5.5", headers: { "x-route": "custom" } },
      ],
      runtime: "codex",
    },
    {
      name: "later headers fill an omitted header map",
      models: [{ id: "gpt-5.5" }, { id: "gpt-5.5", headers: { "x-route": "custom" } }],
      runtime: "openclaw",
    },
  ])("keeps duplicate model config aligned: $name", ({ models, runtime }) => {
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: openAIProviderConfig({ models }),
        env: {},
      }),
    ).toEqual({ runtime, runtimeSource: "implicit" });
  });
});
