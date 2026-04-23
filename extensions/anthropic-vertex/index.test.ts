import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";

const { hasAnthropicVertexAvailableAuthMock } = vi.hoisted(() => ({
  hasAnthropicVertexAvailableAuthMock: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    hasAnthropicVertexAvailableAuth: hasAnthropicVertexAvailableAuthMock,
  };
});

import anthropicVertexPlugin from "./index.js";

describe("anthropic-vertex provider plugin", () => {
  beforeEach(() => {
    hasAnthropicVertexAvailableAuthMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the ADC marker through the provider hook", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    expect(
      provider.resolveConfigApiKey?.({
        provider: "anthropic-vertex",
        env: {
          ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        } as NodeJS.ProcessEnv,
      } as never),
    ).toBe("gcp-vertex-credentials");
  });

  it("merges the implicit Vertex catalog into explicit provider overrides", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            "anthropic-vertex": {
              baseUrl: "https://europe-west4-aiplatform.googleapis.com",
              headers: { "x-test-header": "1" },
            },
          },
        },
      },
      env: {
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        GOOGLE_CLOUD_LOCATION: "us-east5",
      } as NodeJS.ProcessEnv,
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: undefined,
        mode: "none",
        source: "none",
      }),
    } as never);

    expect(result).toEqual({
      provider: {
        api: "anthropic-messages",
        apiKey: "gcp-vertex-credentials",
        baseUrl: "https://europe-west4-aiplatform.googleapis.com",
        headers: { "x-test-header": "1" },
        models: [
          expect.objectContaining({ id: "claude-opus-4-6" }),
          expect.objectContaining({ id: "claude-sonnet-4-6" }),
        ],
      },
    });
  });

  it("owns Anthropic-style replay policy", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic-vertex",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
  });

  it("resolves synthetic auth when ADC is available", async () => {
    hasAnthropicVertexAvailableAuthMock.mockReturnValue(true);
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const result = provider.resolveSyntheticAuth?.({
      provider: "anthropic-vertex",
      config: undefined,
      providerConfig: undefined,
    } as never);

    expect(result).toEqual({
      apiKey: "gcp-vertex-credentials",
      source: "gcp-vertex-credentials (ADC)",
      mode: "api-key",
    });
  });

  it("returns undefined when ADC is not available", async () => {
    hasAnthropicVertexAvailableAuthMock.mockReturnValue(false);
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const result = provider.resolveSyntheticAuth?.({
      provider: "anthropic-vertex",
      config: undefined,
      providerConfig: undefined,
    } as never);

    expect(result).toBeUndefined();
  });
});
