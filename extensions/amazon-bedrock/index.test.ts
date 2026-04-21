import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { buildPluginApi } from "../../src/plugins/api-builder.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import amazonBedrockPlugin from "./index.js";

type RegisteredProviderPlugin = Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

/** Register the amazon-bedrock plugin with an optional pluginConfig override. */
async function registerWithConfig(
  pluginConfig?: Record<string, unknown>,
): Promise<RegisteredProviderPlugin> {
  const providers: RegisteredProviderPlugin[] = [];
  const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const api = buildPluginApi({
    id: "amazon-bedrock",
    name: "Amazon Bedrock Provider",
    source: "test",
    registrationMode: "full",
    config: {} as OpenClawConfig,
    pluginConfig,
    runtime: {} as PluginRuntime,
    logger: noopLogger,
    resolvePath: (input) => input,
    handlers: {
      registerProvider(provider: RegisteredProviderPlugin) {
        providers.push(provider);
      },
    },
  });
  await amazonBedrockPlugin.register(api);
  const provider = providers[0];
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}

/** Spy streamFn that returns the options it receives. */
const spyStreamFn = (_model: unknown, _context: unknown, options: Record<string, unknown>) =>
  options;

const ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6-v1";
const NON_ANTHROPIC_MODEL = "amazon.nova-micro-v1:0";

const MODEL_DESCRIPTOR = {
  api: "openai-completions",
  provider: "amazon-bedrock",
  id: NON_ANTHROPIC_MODEL,
} as never;

const ANTHROPIC_MODEL_DESCRIPTOR = {
  api: "openai-completions",
  provider: "amazon-bedrock",
  id: ANTHROPIC_MODEL,
} as never;

/**
 * Call wrapStreamFn and then invoke the returned stream function, capturing
 * the payload via the onPayload hook that streamWithPayloadPatch installs.
 */
function callWrappedStream(
  provider: RegisteredProviderPlugin,
  modelId: string,
  modelDescriptor: never,
): Record<string, unknown> {
  const wrapped = provider.wrapStreamFn?.({
    provider: "amazon-bedrock",
    modelId,
    streamFn: spyStreamFn,
  } as never);

  // The wrapped stream returns the options object (from spyStreamFn).
  // For guardrail-wrapped streams, streamWithPayloadPatch intercepts onPayload,
  // so we need to invoke onPayload on the returned options to trigger the patch.
  const result = wrapped?.(modelDescriptor, { messages: [] } as never, {}) as unknown as Record<
    string,
    unknown
  >;

  // If onPayload was installed by streamWithPayloadPatch, call it to apply the patch.
  if (typeof result?.onPayload === "function") {
    const payload: Record<string, unknown> = {};
    (result.onPayload as (p: Record<string, unknown>) => void)(payload);
    return { ...result, _capturedPayload: payload };
  }

  return result;
}

describe("amazon-bedrock provider plugin", () => {
  it("marks Claude 4.6 Bedrock models as adaptive by default", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "amazon-bedrock",
        modelId: "us.anthropic.claude-opus-4-6-v1",
      } as never),
    ).toMatchObject({
      levels: expect.arrayContaining([{ id: "adaptive" }]),
      defaultLevel: "adaptive",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "amazon-bedrock",
        modelId: "amazon.nova-micro-v1:0",
      } as never),
    ).toMatchObject({
      levels: expect.not.arrayContaining([{ id: "adaptive" }]),
    });
  });

  it("owns Anthropic-style replay policy for Claude Bedrock models", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "amazon-bedrock",
        modelApi: "bedrock-converse-stream",
        modelId: ANTHROPIC_MODEL,
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
  });

  it("disables prompt caching for non-Anthropic Bedrock models", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "amazon.nova-micro-v1:0",
      streamFn: (_model: unknown, _context: unknown, options: Record<string, unknown>) => options,
    } as never);

    expect(
      wrapped?.(
        {
          api: "openai-completions",
          provider: "amazon-bedrock",
          id: "amazon.nova-micro-v1:0",
        } as never,
        { messages: [] } as never,
        {},
      ),
    ).toMatchObject({
      cacheRetention: "none",
    });
  });

  describe("guardrail config schema", () => {
    it("defines discovery and guardrail objects with the expected shape", () => {
      const pluginJson = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"),
      );
      const discovery = pluginJson.configSchema?.properties?.discovery;
      const guardrail = pluginJson.configSchema?.properties?.guardrail;

      expect(discovery).toBeDefined();
      expect(discovery.type).toBe("object");
      expect(discovery.additionalProperties).toBe(false);
      expect(discovery.properties.enabled).toEqual({ type: "boolean" });
      expect(discovery.properties.region).toEqual({ type: "string" });
      expect(discovery.properties.providerFilter).toEqual({
        type: "array",
        items: { type: "string" },
      });
      expect(discovery.properties.refreshInterval).toEqual({
        type: "integer",
        minimum: 0,
      });
      expect(discovery.properties.defaultContextWindow).toEqual({
        type: "integer",
        minimum: 1,
      });
      expect(discovery.properties.defaultMaxTokens).toEqual({
        type: "integer",
        minimum: 1,
      });

      expect(guardrail).toBeDefined();
      expect(guardrail.type).toBe("object");
      expect(guardrail.additionalProperties).toBe(false);

      // Required fields
      expect(guardrail.required).toEqual(["guardrailIdentifier", "guardrailVersion"]);

      // Property types
      expect(guardrail.properties.guardrailIdentifier).toEqual({ type: "string" });
      expect(guardrail.properties.guardrailVersion).toEqual({ type: "string" });

      // Enum constraints
      expect(guardrail.properties.streamProcessingMode).toEqual({
        type: "string",
        enum: ["sync", "async"],
      });
      expect(guardrail.properties.trace).toEqual({
        type: "string",
        enum: ["enabled", "disabled", "enabled_full"],
      });
    });
  });

  describe("guardrail payload injection", () => {
    it("does not inject guardrailConfig when guardrail is absent from plugin config", async () => {
      const provider = await registerWithConfig(undefined);
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result).not.toHaveProperty("_capturedPayload");
      // The onPayload hook should not exist when no guardrail is configured
      expect(result).toMatchObject({ cacheRetention: "none" });
    });

    it("injects all four fields when guardrail config includes optional fields", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "my-guardrail-id",
          guardrailVersion: "1",
          streamProcessingMode: "sync",
          trace: "enabled",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "my-guardrail-id",
          guardrailVersion: "1",
          streamProcessingMode: "sync",
          trace: "enabled",
        },
      });
    });

    it("injects only required fields when optional fields are omitted", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "abc123",
          guardrailVersion: "DRAFT",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "abc123",
          guardrailVersion: "DRAFT",
        },
      });
    });

    it("injects guardrailConfig for Anthropic models without cacheRetention: none", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
      });
      const result = callWrappedStream(provider, ANTHROPIC_MODEL, ANTHROPIC_MODEL_DESCRIPTOR);

      // Anthropic models should get guardrailConfig
      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
      });
      // Anthropic models should NOT get cacheRetention: "none"
      expect(result).not.toHaveProperty("cacheRetention", "none");
    });

    it("injects guardrailConfig for non-Anthropic models with cacheRetention: none", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "guardrail-nova",
          guardrailVersion: "3",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      // Non-Anthropic models should get guardrailConfig
      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "guardrail-nova",
          guardrailVersion: "3",
        },
      });
      // Non-Anthropic models should also get cacheRetention: "none"
      expect(result).toMatchObject({ cacheRetention: "none" });
    });
  });
});
