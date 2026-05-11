import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  buildPluginApi,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAwsSharedIniFileLoaderForTest } from "./aws-credential-refresh.js";
import { resetBedrockDiscoveryCacheForTest } from "./discovery.js";
import amazonBedrockPlugin from "./index.js";
import {
  resetBedrockAppProfileCacheEligibilityForTest,
  setBedrockAppProfileControlPlaneForTest,
} from "./register.sync.runtime.js";

type BedrockClientResult =
  | {
      models?: Array<{ modelArn?: string }>;
      modelSummaries?: Array<Record<string, unknown>>;
      inferenceProfileSummaries?: Array<Record<string, unknown>>;
    }
  | Error;

const foundationModelResults: BedrockClientResult[] = [];
const inferenceProfileListResults: BedrockClientResult[] = [];
const inferenceProfileGetResults: BedrockClientResult[] = [];
const bedrockClientConfigs: Array<Record<string, unknown>> = [];
const refreshSharedConfigCache = vi.fn(async () => {});
const sendBedrockCommand = vi.fn(async (command: unknown) => {
  const commandName = command?.constructor?.name;
  const queue =
    commandName === "ListFoundationModelsCommand"
      ? foundationModelResults
      : commandName === "ListInferenceProfilesCommand"
        ? inferenceProfileListResults
        : inferenceProfileGetResults;
  const next = queue.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (next) {
    return next;
  }
  if (commandName === "ListFoundationModelsCommand") {
    return {
      modelSummaries: [
        {
          modelId: NON_ANTHROPIC_MODEL,
          modelName: "Nova Micro",
          providerName: "Amazon",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    };
  }
  if (commandName === "ListInferenceProfilesCommand") {
    return { inferenceProfileSummaries: [] };
  }
  return { models: [] };
});

vi.mock("@aws-sdk/client-bedrock", () => {
  class GetInferenceProfileCommand {
    constructor(readonly input: { inferenceProfileIdentifier: string }) {}
  }

  class ListFoundationModelsCommand {
    constructor(readonly input: Record<string, unknown> = {}) {}
  }

  class ListInferenceProfilesCommand {
    constructor(readonly input: Record<string, unknown> = {}) {}
  }

  class BedrockClient {
    constructor(config: Record<string, unknown> = {}) {
      bedrockClientConfigs.push(config);
    }

    send = sendBedrockCommand;
  }

  return {
    BedrockClient,
    GetInferenceProfileCommand,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
  };
});

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
  amazonBedrockPlugin.register(api);
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

const APP_INFERENCE_PROFILE_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
const APP_INFERENCE_PROFILE_DESCRIPTOR = {
  api: "openai-completions",
  provider: "amazon-bedrock",
  id: APP_INFERENCE_PROFILE_ARN,
} as never;

function makeAppInferenceProfileDescriptor(modelId: string): never {
  return {
    api: "openai-completions",
    provider: "amazon-bedrock",
    id: modelId,
  } as never;
}

async function callWrappedStream(
  provider: RegisteredProviderPlugin,
  modelId: string,
  modelDescriptor: never,
  config?: OpenClawConfig,
  extraParams?: Record<string, unknown>,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const wrapped = provider.wrapStreamFn?.({
    provider: "amazon-bedrock",
    modelId,
    config,
    streamFn: spyStreamFn,
    ...(extraParams ? { extraParams } : {}),
  } as never);

  const result = wrapped?.(modelDescriptor, { messages: [] } as never, {}) as unknown as Record<
    string,
    unknown
  >;

  if (typeof result?.onPayload === "function") {
    await (result.onPayload as (p: Record<string, unknown>, model: unknown) => Promise<unknown>)(
      payload,
      modelDescriptor,
    );
    if (Object.keys(payload).length > 0) {
      return { ...result, _capturedPayload: payload };
    }
  }

  return result;
}

function runtimePluginConfig(config?: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: {
      entries: config
        ? {
            "amazon-bedrock": {
              config,
            },
          }
        : {},
    },
  } as OpenClawConfig;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectWrappedResultFields(result: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(result, "wrapped stream result"), fields);
}

function expectPayloadServiceTier(result: Record<string, unknown>, type: string) {
  expectRecordFields(requireRecord(result._capturedPayload, "captured payload"), {
    serviceTier: { type },
  });
}

function expectThinkingProfile(
  profile: unknown,
  fields: { defaultLevel?: string; levelIds?: string[]; includesAdaptive?: boolean },
) {
  const record = requireRecord(profile, "thinking profile");
  if (fields.defaultLevel !== undefined) {
    expect(record.defaultLevel).toBe(fields.defaultLevel);
  }
  const levelIds = requireArray(record.levels, "thinking levels").map((level) =>
    String(requireRecord(level, "thinking level").id),
  );
  if (fields.levelIds) {
    expect(levelIds).toEqual(fields.levelIds);
  }
  if (fields.includesAdaptive !== undefined) {
    expect(levelIds.includes("adaptive")).toBe(fields.includesAdaptive);
  }
}

describe("amazon-bedrock provider plugin", () => {
  beforeEach(() => {
    foundationModelResults.length = 0;
    inferenceProfileListResults.length = 0;
    inferenceProfileGetResults.length = 0;
    bedrockClientConfigs.length = 0;
    refreshSharedConfigCache.mockClear();
    setAwsSharedIniFileLoaderForTest({ loadSharedConfigFiles: refreshSharedConfigCache });
    sendBedrockCommand.mockClear();
    resetBedrockDiscoveryCacheForTest();
    resetBedrockAppProfileCacheEligibilityForTest();
    setBedrockAppProfileControlPlaneForTest((region) => ({
      async getInferenceProfile(input) {
        class GetInferenceProfileCommand {
          constructor(readonly input: Record<string, unknown> = {}) {}
        }
        bedrockClientConfigs.push(region ? { region } : {});
        return await sendBedrockCommand(new GetInferenceProfileCommand(input));
      },
    }));
  });

  afterEach(() => {
    setBedrockAppProfileControlPlaneForTest(undefined);
    setAwsSharedIniFileLoaderForTest(undefined);
    resetBedrockDiscoveryCacheForTest();
    resetBedrockAppProfileCacheEligibilityForTest();
  });

  afterAll(() => {
    vi.doUnmock("@aws-sdk/client-bedrock");
    vi.resetModules();
  });

  it("marks Claude 4.6 Bedrock models as adaptive by default", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expectThinkingProfile(
      provider.resolveThinkingProfile?.({
        provider: "amazon-bedrock",
        modelId: "us.anthropic.claude-opus-4-6-v1",
      } as never),
      { includesAdaptive: true, defaultLevel: "adaptive" },
    );
    expectThinkingProfile(
      provider.resolveThinkingProfile?.({
        provider: "amazon-bedrock",
        modelId: "amazon.nova-micro-v1:0",
      } as never),
      { includesAdaptive: false },
    );
  });

  it("mirrors Claude Opus 4.7 thinking levels for Bedrock model refs", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    for (const modelId of [
      "us.anthropic.claude-opus-4-7",
      "us.anthropic.claude-opus-4.7-v1:0",
      "eu.anthropic.claude-opus-4-7",
      "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-7",
    ]) {
      expectThinkingProfile(
        provider.resolveThinkingProfile?.({
          provider: "amazon-bedrock",
          modelId,
        } as never),
        {
          levelIds: ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"],
          defaultLevel: "off",
        },
      );
    }
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

    expectWrappedResultFields(
      wrapped?.(
        {
          api: "openai-completions",
          provider: "amazon-bedrock",
          id: "amazon.nova-micro-v1:0",
        } as never,
        { messages: [] } as never,
        {},
      ),
      { cacheRetention: "none" },
    );
  });

  it("refreshes AWS shared config cache before Bedrock sends", async () => {
    await withEnvAsync(
      {
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_BEDROCK_SKIP_AUTH: undefined,
      },
      async () => {
        const order: string[] = [];
        refreshSharedConfigCache.mockImplementationOnce(async () => {
          order.push("refresh");
        });
        const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
        const wrapped = provider.wrapStreamFn?.({
          provider: "amazon-bedrock",
          modelId: ANTHROPIC_MODEL,
          streamFn: spyStreamFn,
        } as never);
        const result = wrapped?.(ANTHROPIC_MODEL_DESCRIPTOR, { messages: [] } as never, {
          onPayload: () => {
            order.push("original");
          },
        }) as Record<string, unknown> | undefined;

        await (
          result?.onPayload as ((p: Record<string, unknown>, model: unknown) => unknown) | undefined
        )?.({}, ANTHROPIC_MODEL_DESCRIPTOR);

        expect(refreshSharedConfigCache).toHaveBeenCalledWith({ ignoreCache: true });
        expect(order).toEqual(["refresh", "original"]);
      },
    );
  });

  it("omits temperature for Bedrock Opus 4.7 model ids", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-7",
      streamFn: spyStreamFn,
    } as never);

    const result = wrapped?.(
      {
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4-7",
      } as never,
      { messages: [] } as never,
      { temperature: 0.2, maxTokens: 10 },
    ) as Record<string, unknown> | undefined;

    expectWrappedResultFields(result, { maxTokens: 10 });
    expect(result).not.toHaveProperty("temperature");
  });

  it("omits temperature for dotted Bedrock Opus 4.7 model ids", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4.7-v1:0",
      streamFn: spyStreamFn,
    } as never);

    const result = wrapped?.(
      {
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4.7-v1:0",
      } as never,
      { messages: [] } as never,
      { temperature: 0.2, maxTokens: 10 },
    ) as Record<string, unknown> | undefined;

    expectWrappedResultFields(result, { maxTokens: 10 });
    expect(result).not.toHaveProperty("temperature");
  });

  it("omits temperature for named Bedrock Opus 4.7 inference profile ARNs", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const modelId =
      "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-7";
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId,
      streamFn: spyStreamFn,
    } as never);

    const result = wrapped?.(
      {
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        id: modelId,
      } as never,
      { messages: [] } as never,
      { temperature: 0, region: "us-west-2" } as never,
    ) as Record<string, unknown> | undefined;

    expectWrappedResultFields(result, { region: "us-west-2" });
    expect(result).not.toHaveProperty("temperature");
  });

  it("omits temperature for non-US Bedrock Opus 4.7 regional profiles", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "eu.anthropic.claude-opus-4-7",
      streamFn: spyStreamFn,
    } as never);

    const result = wrapped?.(
      {
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        id: "eu.anthropic.claude-opus-4-7",
      } as never,
      { messages: [] } as never,
      { temperature: 0.4, maxTokens: 12 },
    ) as Record<string, unknown> | undefined;

    expectWrappedResultFields(result, { maxTokens: 12 });
    expect(result).not.toHaveProperty("temperature");
  });

  it("preserves Bedrock Opus 4.7 max thinking in the final payload", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-7",
      streamFn: spyStreamFn,
      thinkingLevel: "max",
    } as never);

    const result = wrapped?.(
      {
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4-7",
      } as never,
      { messages: [] } as never,
      { reasoning: "xhigh" } as never,
    ) as Record<string, unknown> | undefined;
    const payload = {
      additionalModelRequestFields: {
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
      },
    };

    await (result?.onPayload as ((p: Record<string, unknown>) => unknown) | undefined)?.(payload);

    expect(payload.additionalModelRequestFields.output_config).toEqual({ effort: "max" });
  });

  it("keeps Bedrock Opus 4.7 xhigh thinking distinct from max", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-7",
      streamFn: spyStreamFn,
      thinkingLevel: "xhigh",
    } as never);

    const result = wrapped?.(
      {
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4-7",
      } as never,
      { messages: [] } as never,
      { reasoning: "xhigh" } as never,
    ) as Record<string, unknown> | undefined;

    const payload = {
      additionalModelRequestFields: {
        output_config: { effort: "xhigh" },
      },
    };

    await (result?.onPayload as ((p: Record<string, unknown>) => unknown) | undefined)?.(payload);

    expect(payload.additionalModelRequestFields.output_config).toEqual({ effort: "xhigh" });
  });

  it("classifies nested Bedrock deprecated-temperature validation as format failover", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(
      provider.classifyFailoverReason?.({
        provider: "amazon-bedrock",
        modelId: "us.anthropic.claude-opus-4-7",
        errorMessage:
          'ValidationException: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
      } as never),
    ).toBe("format");
  });

  describe("guardrail config schema", () => {
    it("defines discovery and guardrail objects with the expected shape", () => {
      const pluginJson = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"),
      );
      const discovery = pluginJson.configSchema?.properties?.discovery;
      const guardrail = pluginJson.configSchema?.properties?.guardrail;

      expectRecordFields(requireRecord(discovery, "discovery schema"), {
        type: "object",
        additionalProperties: false,
      });
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

      expectRecordFields(requireRecord(guardrail, "guardrail schema"), {
        type: "object",
        additionalProperties: false,
      });

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
      const result = await callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result).not.toHaveProperty("_capturedPayload");
      // The onPayload hook should not exist when no guardrail is configured
      expectWrappedResultFields(result, { cacheRetention: "none" });
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
      const result = await callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

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
      const result = await callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

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
      const result = await callWrappedStream(provider, ANTHROPIC_MODEL, ANTHROPIC_MODEL_DESCRIPTOR);

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
      const result = await callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      // Non-Anthropic models should get guardrailConfig
      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "guardrail-nova",
          guardrailVersion: "3",
        },
      });
      // Non-Anthropic models should also get cacheRetention: "none"
      expectWrappedResultFields(result, { cacheRetention: "none" });
    });

    it("uses live plugin config to inject guardrailConfig after startup disable", async () => {
      const provider = await registerWithConfig(undefined);
      const result = await callWrappedStream(
        provider,
        NON_ANTHROPIC_MODEL,
        MODEL_DESCRIPTOR,
        runtimePluginConfig({
          guardrail: {
            guardrailIdentifier: "live-guardrail",
            guardrailVersion: "7",
          },
        }),
      );

      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "live-guardrail",
          guardrailVersion: "7",
        },
      });
    });

    it("does not revive startup guardrail config when the live plugin entry is removed", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "startup-guardrail",
          guardrailVersion: "5",
        },
      });
      const result = await callWrappedStream(
        provider,
        NON_ANTHROPIC_MODEL,
        MODEL_DESCRIPTOR,
        runtimePluginConfig(undefined),
      );

      expect(result).not.toHaveProperty("_capturedPayload");
      expectWrappedResultFields(result, { cacheRetention: "none" });
    });
  });

  describe("service tier", () => {
    const CONVERSE_MODEL_DESCRIPTOR = {
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      id: NON_ANTHROPIC_MODEL,
    } as never;

    it("injects serviceTier for valid camelCase value ('flex')", async () => {
      const provider = await registerWithConfig(undefined);
      const result = await callWrappedStream(
        provider,
        NON_ANTHROPIC_MODEL,
        CONVERSE_MODEL_DESCRIPTOR,
        runtimePluginConfig(undefined),
        { serviceTier: "flex" },
      );
      expectPayloadServiceTier(result, "flex");
    });

    it("injects serviceTier for valid snake_case value ('priority')", async () => {
      const provider = await registerWithConfig(undefined);
      const result = await callWrappedStream(
        provider,
        NON_ANTHROPIC_MODEL,
        CONVERSE_MODEL_DESCRIPTOR,
        runtimePluginConfig(undefined),
        { service_tier: "priority" },
      );
      expectPayloadServiceTier(result, "priority");
    });

    it("injects serviceTier for all valid tier names", async () => {
      const provider = await registerWithConfig(undefined);
      for (const tier of ["flex", "priority", "default", "reserved"] as const) {
        const result = await callWrappedStream(
          provider,
          NON_ANTHROPIC_MODEL,
          CONVERSE_MODEL_DESCRIPTOR,
          runtimePluginConfig(undefined),
          { serviceTier: tier },
        );
        expectPayloadServiceTier(result, tier);
      }
    });

    it("does not inject serviceTier when value is invalid", async () => {
      const provider = await registerWithConfig(undefined);
      const result = await callWrappedStream(
        provider,
        NON_ANTHROPIC_MODEL,
        CONVERSE_MODEL_DESCRIPTOR,
        runtimePluginConfig(undefined),
        { serviceTier: "not-a-tier" },
      );
      expect(result).not.toHaveProperty("_capturedPayload");
    });

    it("does not overwrite caller-provided serviceTier in payload", async () => {
      const provider = await registerWithConfig(undefined);
      const result = await callWrappedStream(
        provider,
        NON_ANTHROPIC_MODEL,
        CONVERSE_MODEL_DESCRIPTOR,
        runtimePluginConfig(undefined),
        { serviceTier: "flex" },
        { serviceTier: { type: "priority" } },
      );
      expectPayloadServiceTier(result, "priority");
    });

    it("skips injection for non-converse API models", async () => {
      const provider = await registerWithConfig(undefined);
      const result = await callWrappedStream(
        provider,
        NON_ANTHROPIC_MODEL,
        { api: "openai-completions", provider: "amazon-bedrock", id: NON_ANTHROPIC_MODEL } as never,
        runtimePluginConfig(undefined),
        { serviceTier: "flex" },
      );
      expect(result).not.toHaveProperty("_capturedPayload");
    });
  });

  describe("application inference profile cache point injection", () => {
    /**
     * Invoke wrapStreamFn with a payload containing system/messages, then
     * trigger onPayload to capture the patched payload.
     */
    async function callWrappedStreamWithPayload(
      provider: RegisteredProviderPlugin,
      modelId: string,
      modelDescriptor: never,
      options: Record<string, unknown>,
      payload: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const wrapped = provider.wrapStreamFn?.({
        provider: "amazon-bedrock",
        modelId,
        streamFn: spyStreamFn,
      } as never);

      const result = wrapped?.(
        modelDescriptor,
        { messages: [] } as never,
        options,
      ) as unknown as Record<string, unknown>;

      if (typeof result?.onPayload === "function") {
        await (
          result.onPayload as (p: Record<string, unknown>, model: unknown) => Promise<unknown>
        )(payload, modelDescriptor);
      }
      return payload;
    }

    it("injects cache points for application inference profile ARNs", async () => {
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        { cacheRetention: "short" },
        payload,
      );

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(2);
      expect(system[1]).toEqual({ cachePoint: { type: "default" } });

      const messages = payload.messages as Array<{
        role: string;
        content: Array<Record<string, unknown>>;
      }>;
      const lastUserContent = messages[0].content;
      expect(lastUserContent).toHaveLength(2);
      expect(lastUserContent[1]).toEqual({ cachePoint: { type: "default" } });
    });

    it("uses long TTL when cacheRetention is 'long'", async () => {
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        { cacheRetention: "long" },
        payload,
      );

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system[1]).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
    });

    it("does not inject cache points when cacheRetention is 'none'", async () => {
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        { cacheRetention: "none" },
        payload,
      );

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(1);
    });

    it("does not double-inject cache points if already present", async () => {
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }, { cachePoint: { type: "default" } }],
        messages: [
          { role: "user", content: [{ text: "Hello" }, { cachePoint: { type: "default" } }] },
        ],
      };

      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        { cacheRetention: "short" },
        payload,
      );

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(2);

      const messages = payload.messages as Array<{
        role: string;
        content: Array<Record<string, unknown>>;
      }>;
      expect(messages[0].content).toHaveLength(2);
    });

    it("does not inject cache points for regular Anthropic model IDs (pi-ai handles them)", async () => {
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      // Regular model IDs contain "claude" so pi-ai handles caching natively.
      // wrapStreamFn should not install an onPayload hook for these.
      const wrapped = provider.wrapStreamFn?.({
        provider: "amazon-bedrock",
        modelId: ANTHROPIC_MODEL,
        streamFn: spyStreamFn,
      } as never);

      const result = wrapped?.(ANTHROPIC_MODEL_DESCRIPTOR, { messages: [] } as never, {
        cacheRetention: "short",
      }) as unknown as Record<string, unknown>;

      // For regular Anthropic models, no onPayload should be installed for cache injection.
      if (typeof result?.onPayload === "function") {
        (result.onPayload as (p: Record<string, unknown>) => void)(payload);
      }

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(1);
    });

    it("does not inject cache points for older Claude models not in pi-ai's cache list", async () => {
      const provider = await registerWithConfig(undefined);
      const oldClaudeModel = "anthropic.claude-3-opus-20240229-v1:0";
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      // Claude 3 Opus is not in pi-ai's supportsPromptCaching list, but it's
      // also not an application inference profile — we should not inject.
      const wrapped = provider.wrapStreamFn?.({
        provider: "amazon-bedrock",
        modelId: oldClaudeModel,
        streamFn: spyStreamFn,
      } as never);

      const result = wrapped?.({ id: oldClaudeModel } as never, { messages: [] } as never, {
        cacheRetention: "short",
      }) as unknown as Record<string, unknown>;

      if (typeof result?.onPayload === "function") {
        (result.onPayload as (p: Record<string, unknown>) => void)(payload);
      }

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(1);
    });

    it("defaults to 'short' cache retention when not explicitly set", async () => {
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        {},
        payload,
      );

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(2);
      // Default is "short" which means no ttl field
      expect(system[1]).toEqual({ cachePoint: { type: "default" } });
    });

    it("injects cache point only on last USER message", async () => {
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [
          { role: "user", content: [{ text: "First question" }] },
          { role: "assistant", content: [{ text: "Answer" }] },
          { role: "user", content: [{ text: "Follow-up" }] },
        ],
      };

      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        { cacheRetention: "short" },
        payload,
      );

      const messages = payload.messages as Array<{
        role: string;
        content: Array<Record<string, unknown>>;
      }>;
      // First user message should NOT have a cache point
      expect(messages[0].content).toHaveLength(1);
      // Assistant message untouched
      expect(messages[1].content).toHaveLength(1);
      // Last user message should have a cache point
      expect(messages[2].content).toHaveLength(2);
      expect(messages[2].content[1]).toEqual({ cachePoint: { type: "default" } });
    });

    it("injects cache points for opaque application inference profile ARNs after profile lookup", async () => {
      const modelId =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459da";
      inferenceProfileGetResults.push({
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-20250514-v1:0",
          },
        ],
      });
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        modelId,
        makeAppInferenceProfileDescriptor(modelId),
        { cacheRetention: "short" },
        payload,
      );

      const system = payload.system as Array<Record<string, unknown>>;
      expect(system[1]).toEqual({ cachePoint: { type: "default" } });
      expect(sendBedrockCommand).toHaveBeenCalledTimes(1);
      expect(bedrockClientConfigs).toEqual([{ region: "us-east-1" }]);
    });

    it("omits temperature for opaque application inference profile ARNs that resolve to Opus 4.7", async () => {
      const modelId =
        "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/z27qyso459dd";
      inferenceProfileGetResults.push({
        models: [
          {
            modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-4.7-v1:0",
          },
        ],
      });
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        inferenceConfig: { temperature: 0.3, maxTokens: 10 },
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        modelId,
        makeAppInferenceProfileDescriptor(modelId),
        { temperature: 0.3, maxTokens: 10, cacheRetention: "none" },
        payload,
      );

      expect(payload.inferenceConfig).toEqual({ maxTokens: 10 });
      expect(sendBedrockCommand).toHaveBeenCalledTimes(1);
      expect(bedrockClientConfigs).toEqual([{ region: "us-west-2" }]);
    });

    it("omits temperature for Claude-named application inference profile ARNs that resolve to Opus 4.7", async () => {
      inferenceProfileGetResults.push({
        models: [
          {
            modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7-v1:0",
          },
        ],
      });
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        inferenceConfig: { temperature: 0.3, maxTokens: 10 },
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        { temperature: 0.3, maxTokens: 10, cacheRetention: "short" },
        payload,
      );

      const system = payload.system as Array<Record<string, unknown>>;
      expect(payload.inferenceConfig).toEqual({ maxTokens: 10 });
      expect(system[1]).toEqual({ cachePoint: { type: "default" } });
      expect(sendBedrockCommand).toHaveBeenCalledTimes(1);
      expect(bedrockClientConfigs).toEqual([{ region: "us-east-1" }]);
    });

    it("does not inject cache points when any resolved profile target is not cacheable", async () => {
      const modelId =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459db";
      inferenceProfileGetResults.push({
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-20250514-v1:0",
          },
          {
            modelArn:
              "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-opus-20240229-v1:0",
          },
        ],
      });
      const provider = await registerWithConfig(undefined);
      const payload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        modelId,
        makeAppInferenceProfileDescriptor(modelId),
        { cacheRetention: "short" },
        payload,
      );

      expect(payload.system).toEqual([{ text: "You are helpful." }]);
      expect(payload.messages).toEqual([{ role: "user", content: [{ text: "Hello" }] }]);
    });

    it("retries opaque profile lookup after a transient failure instead of caching the fallback", async () => {
      const modelId =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/z27qyso459dc";
      inferenceProfileGetResults.push(new Error("throttled"), {
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-20250514-v1:0",
          },
        ],
      });
      const provider = await registerWithConfig(undefined);
      const firstPayload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      };
      const secondPayload: Record<string, unknown> = {
        system: [{ text: "You are helpful." }],
        messages: [{ role: "user", content: [{ text: "Hello again" }] }],
      };

      await callWrappedStreamWithPayload(
        provider,
        modelId,
        makeAppInferenceProfileDescriptor(modelId),
        { cacheRetention: "short" },
        firstPayload,
      );
      await callWrappedStreamWithPayload(
        provider,
        modelId,
        makeAppInferenceProfileDescriptor(modelId),
        { cacheRetention: "short" },
        secondPayload,
      );

      expect(firstPayload.system).toEqual([{ text: "You are helpful." }]);
      expect(secondPayload.system).toEqual([
        { text: "You are helpful." },
        { cachePoint: { type: "default" } },
      ]);
      expect(sendBedrockCommand).toHaveBeenCalledTimes(2);
    });
  });
});
