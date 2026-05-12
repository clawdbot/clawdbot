import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildVllmProviderMock = vi.hoisted(() => vi.fn());
type DiscoverOpenAICompatibleSelfHostedProviderParams = {
  buildProvider: (args: { apiKey?: string }) => Promise<Record<string, unknown>>;
  ctx: {
    resolveProviderApiKey: () => {
      apiKey?: string;
    };
    resolveProviderAuth: () => {
      discoveryApiKey?: string;
    };
  };
  providerId: string;
};
const discoverOpenAICompatibleSelfHostedProviderMock = vi.hoisted(() =>
  vi.fn(async (params: DiscoverOpenAICompatibleSelfHostedProviderParams) => ({
    provider: {
      ...(await params.buildProvider({
        apiKey: params.ctx.resolveProviderAuth().discoveryApiKey,
      })),
      apiKey: params.ctx.resolveProviderApiKey().apiKey,
    },
  })),
);

vi.mock("./api.js", () => ({
  VLLM_DEFAULT_API_KEY_ENV_VAR: "VLLM_API_KEY",
  VLLM_DEFAULT_BASE_URL: "http://127.0.0.1:8000/v1",
  VLLM_MODEL_PLACEHOLDER: "meta-llama/Meta-Llama-3-8B-Instruct",
  VLLM_PROVIDER_LABEL: "vLLM",
  buildVllmProvider: (...args: unknown[]) => buildVllmProviderMock(...args),
}));

vi.mock("openclaw/plugin-sdk/provider-setup", () => ({
  discoverOpenAICompatibleSelfHostedProvider: (
    params: DiscoverOpenAICompatibleSelfHostedProviderParams,
  ) => discoverOpenAICompatibleSelfHostedProviderMock(params),
}));

type ProviderDiscoveryRun = (ctx: {
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: () => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: () => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
  };
}) => Promise<unknown>;

type RegisteredVllmProvider = {
  id: string;
  catalog?: {
    order?: string;
    run: ProviderDiscoveryRun;
  };
};

describe("vllm provider discovery contract", () => {
  beforeEach(() => {
    buildVllmProviderMock.mockReset();
    discoverOpenAICompatibleSelfHostedProviderMock.mockClear();
  });

  it("keeps self-hosted discovery provider-owned", async () => {
    const { default: plugin } = await import("./index.js");
    let provider: RegisteredVllmProvider | undefined;
    plugin.register({
      registerProvider: (registeredProvider) => {
        provider = registeredProvider as RegisteredVllmProvider;
      },
    } as OpenClawPluginApi);
    expect(provider?.id).toBe("vllm");
    expect(provider?.catalog?.order).toBe("late");
    const catalog = provider?.catalog;
    if (!catalog) {
      throw new Error("expected vllm provider catalog hook");
    }

    buildVllmProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
    });

    await expect(
      catalog.run({
        config: {},
        env: {
          VLLM_API_KEY: "env-vllm-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({
          apiKey: "VLLM_API_KEY",
          discoveryApiKey: "env-vllm-key",
        }),
        resolveProviderAuth: () => ({
          apiKey: "VLLM_API_KEY",
          discoveryApiKey: "env-vllm-key",
          mode: "api_key",
          source: "env",
        }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        apiKey: "VLLM_API_KEY",
        models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
      },
    });
    expect(buildVllmProviderMock).toHaveBeenCalledWith({
      apiKey: "env-vllm-key",
    });
    expect(discoverOpenAICompatibleSelfHostedProviderMock).toHaveBeenCalledTimes(1);
    const [discoveryParams] = discoverOpenAICompatibleSelfHostedProviderMock.mock.calls.at(0) ?? [];
    if (discoveryParams === undefined) {
      throw new Error("expected discovery parameters");
    }
    expect(discoveryParams.providerId).toBe("vllm");
    expect(discoveryParams.buildProvider).toBeTypeOf("function");
  });
});
