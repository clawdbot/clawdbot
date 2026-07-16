import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import anthropicVertexPlugin from "./index.js";

describe("anthropic-vertex provider plugin", () => {
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
});
