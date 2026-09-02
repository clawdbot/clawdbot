import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  buildPluginApi,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
// Amazon Bedrock tests cover index plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { supportsBedrockPromptCaching } from "./bedrock-options.js";
import amazonBedrockPlugin from "./index.js";

type BedrockClientResult =
  | {
      models?: Array<{ modelArn?: string }>;
      modelSummaries?: Array<Record<string, unknown>>;
      inferenceProfileSummaries?: Array<Record<string, unknown>>;
    }
  | { stall: (signal: AbortSignal) => void }
  | Error;

const foundationModelResults: BedrockClientResult[] = [];
const inferenceProfileListResults: BedrockClientResult[] = [];
const inferenceProfileGetResults: BedrockClientResult[] = [];
const bedrockClientConfigs: Array<Record<string, unknown>> = [];
const destroyBedrockClient = vi.fn();
const refreshSharedConfigCache = vi.fn(async () => {});
const sendBedrockCommand = vi.fn(
  async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
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
    if (next && "stall" in next) {
      const signal = options?.abortSignal;
      if (!signal) {
        throw new Error("expected Bedrock control-plane abort signal");
      }
      next.stall(signal);
      return await new Promise<never>((_resolve, reject) => {
        const rejectFromSignal = () => {
          const reason = signal.reason;
          reject(reason instanceof Error ? reason : new Error("Bedrock request aborted"));
        };
        if (signal.aborted) {
          rejectFromSignal();
        } else {
          signal.addEventListener("abort", rejectFromSignal, { once: true });
        }
      });
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
  },
);

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
    destroy = destroyBedrockClient;
  }

  return {
    BedrockClient,
    GetInferenceProfileCommand,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
  };
});

vi.mock("@smithy/shared-ini-file-loader", () => ({
  loadSharedConfigFiles: refreshSharedConfigCache,
}));

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
const OPUS_APP_INFERENCE_PROFILE_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opus-temperature-profile";
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
      return { ...result, capturedPayload: payload };
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

function buildBedrockCachePayload(
  text = "Hello",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...overrides,
    system: [{ text: "You are helpful." }],
    messages: [{ role: "user", content: [{ text }] }],
  };
}

async function callBedrockConverse(
  extraParams: Record<string, unknown>,
  payload: Record<string, unknown> = {},
  modelId = NON_ANTHROPIC_MODEL,
): Promise<Record<string, unknown>> {
  return callWrappedStream(
    await registerWithConfig(),
    modelId,
    { api: "bedrock-converse-stream", provider: "amazon-bedrock", id: modelId } as never,
    runtimePluginConfig(),
    extraParams,
    payload,
  );
}

const requireRecord = createRequireRecord("record", "expected-label-record");

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
  expectRecordFields(requireRecord(result.capturedPayload, "captured payload"), {
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
    destroyBedrockClient.mockClear();
    refreshSharedConfigCache.mockClear();
    sendBedrockCommand.mockClear();
  });

  afterAll(() => {
    vi.doUnmock("@aws-sdk/client-bedrock");
    vi.resetModules();
  });

  it("publishes its stream through the provider lifecycle", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(
      provider.createStreamFn?.({ model: { api: "bedrock-converse-stream" } } as never),
    ).toBeTypeOf("function");
    expect(
      provider.createStreamFn?.({ model: { api: "anthropic-messages" } } as never),
    ).toBeUndefined();
  });

  it("returns raw discovery for the host to merge with materialized config", async () => {
    const provider = await registerWithConfig();

    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            "amazon-bedrock": {
              models: [
                {
                  id: NON_ANTHROPIC_MODEL,
                  input: ["text", "image"],
                },
              ],
            },
          },
        },
      },
      env: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv,
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(result.provider.models[0]).toMatchObject({
      id: NON_ANTHROPIC_MODEL,
      input: ["text"],
    });
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

  it("normalizes explicit Claude 4.6 rows with native max metadata", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      model: {
        id: "us.anthropic.claude-opus-4-6-v1",
        name: "Claude Opus 4.6",
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 4096,
      },
    } as never);

    expect(normalized?.thinkingLevelMap).toEqual({ xhigh: null, max: "max" });

    const restricted = provider.normalizeResolvedModel?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      model: {
        ...(normalized as NonNullable<typeof normalized>),
        thinkingLevelMap: { max: null },
      },
    } as never);

    expect(restricted?.thinkingLevelMap).toEqual({ xhigh: null, max: null });
  });

  it.each([
    {
      name: "mirrors Claude Opus 4.7 thinking levels for Bedrock model refs",
      modelIds: [
        "us.anthropic.claude-opus-4-7",
        "us.anthropic.claude-opus-4.7-v1:0",
        "eu.anthropic.claude-opus-4-7",
        "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-7",
      ],
      defaultLevel: "off",
    },
    {
      name: "defaults Claude Opus 5 Bedrock model refs to high adaptive thinking",
      modelIds: [
        "anthropic.claude-opus-5",
        "us.anthropic.claude-opus-5",
        "global.anthropic.claude-opus-5",
      ],
      defaultLevel: "high",
    },
    {
      name: "leaves Claude Opus 4.8 Bedrock model refs off by default",
      modelIds: [
        "us.anthropic.claude-opus-4-8",
        "us.anthropic.claude-opus-4.8-v1:0",
        "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
      ],
      defaultLevel: "off",
    },
    {
      name: "keeps mandatory-adaptive Claude 5 models at high default effort",
      modelIds: [
        "anthropic.claude-fable-5",
        "us.anthropic.claude-fable-5",
        "global.anthropic.claude-fable-5",
        "anthropic.claude-mythos-5",
        "us.anthropic.claude-mythos-5",
        "global.anthropic.claude-mythos-5",
      ],
      defaultLevel: "high",
    },
  ])("$name", async ({ modelIds, defaultLevel }) => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    for (const modelId of modelIds) {
      expectThinkingProfile(
        provider.resolveThinkingProfile?.({ provider: "amazon-bedrock", modelId } as never),
        {
          levelIds: ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"],
          defaultLevel,
        },
      );
    }
  });

  it("keeps Fable thinking policy for opaque deployment aliases", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expectThinkingProfile(
      provider.resolveThinkingProfile?.({
        provider: "amazon-bedrock",
        modelId: "company-fable",
        params: { canonicalModelId: "claude-fable-5" },
      } as never),
      {
        levelIds: ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"],
        defaultLevel: "high",
      },
    );
  });

  it("recognizes direct Claude 5 model refs as prompt-cache eligible", () => {
    expect(supportsBedrockPromptCaching("us.anthropic.claude-fable-5")).toBe(true);
    expect(supportsBedrockPromptCaching("us.anthropic.claude-mythos-5")).toBe(true);
    expect(supportsBedrockPromptCaching("global.anthropic.claude-opus-5")).toBe(true);
    expect(supportsBedrockPromptCaching("global.anthropic.claude-sonnet-5")).toBe(true);
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

  it.each([
    {
      name: "omits temperature for Bedrock Opus 4.7 model ids",
      id: "us.anthropic.claude-opus-4-7",
      options: { temperature: 0.2, maxTokens: 10 },
      expected: { maxTokens: 10 },
      checkAnthropicCache: true,
    },
    {
      name: "omits temperature for Bedrock Opus 4.8 model ids",
      id: "us.anthropic.claude-opus-4-8",
      options: { temperature: 0.2, maxTokens: 10 },
      expected: { maxTokens: 10 },
      checkAnthropicCache: true,
    },
    {
      name: "omits temperature for Bedrock Fable deployment aliases",
      id: "production-fable",
      canonicalModelId: "claude-fable-5",
      options: { temperature: 0.2, maxTokens: 10 },
      expected: { maxTokens: 10 },
      checkAnthropicCache: true,
    },
    {
      name: "omits temperature for canonical Bedrock Opus aliases",
      id: "production-claude",
      canonicalModelId: "claude-opus-4-8",
      options: { temperature: 0.2, maxTokens: 10 },
      expected: { maxTokens: 10 },
      checkAnthropicCache: true,
    },
    {
      name: "omits temperature for dotted Bedrock Opus 4.7 model ids",
      id: "us.anthropic.claude-opus-4.7-v1:0",
      options: { temperature: 0.2, maxTokens: 10 },
      expected: { maxTokens: 10 },
    },
    {
      name: "omits temperature for named Bedrock Opus 4.7 inference profile ARNs",
      id: "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-7",
      options: { temperature: 0, region: "us-west-2" },
      expected: { region: "us-west-2" },
    },
    {
      name: "omits temperature for non-US Bedrock Opus 4.7 regional profiles",
      id: "eu.anthropic.claude-opus-4-7",
      options: { temperature: 0.4, maxTokens: 12 },
      expected: { maxTokens: 12 },
    },
  ])("$name", async ({ id, canonicalModelId, options, expected, checkAnthropicCache }) => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const model = {
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      id,
      ...(canonicalModelId ? { params: { canonicalModelId } } : {}),
    };
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: id,
      ...(canonicalModelId ? { model } : {}),
      streamFn: spyStreamFn,
    } as never);
    const result = wrapped?.(model as never, { messages: [] } as never, options as never);

    expectWrappedResultFields(result, expected);
    expect(result).not.toHaveProperty("temperature");
    if (checkAnthropicCache) {
      expect(result).not.toHaveProperty("cacheRetention", "none");
    }
  });

  it("uses plugin discovery region when provider URLs do not encode one", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: NON_ANTHROPIC_MODEL,
      model: {
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        id: NON_ANTHROPIC_MODEL,
        baseUrl: "https://bedrock-runtime.internal.example",
      },
      config: {
        plugins: {
          entries: {
            "amazon-bedrock": {
              config: { discovery: { region: "eu-central-1" } },
            },
          },
        },
      },
      streamFn: spyStreamFn,
    } as never);

    const result = wrapped?.(MODEL_DESCRIPTOR, { messages: [] } as never, {}) as
      | Record<string, unknown>
      | undefined;

    expectWrappedResultFields(result, { region: "eu-central-1" });
  });

  it.each([
    {
      name: "preserves Bedrock Opus 4.7 max thinking in the final payload",
      modelId: "us.anthropic.claude-opus-4-7",
      thinkingLevel: "max",
      reasoning: "xhigh",
      initialEffort: "xhigh",
      expectedEffort: "max",
      adaptive: true,
    },
    {
      name: "preserves Bedrock Opus 4.6 max thinking in the final payload",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      thinkingLevel: "max",
      reasoning: "high",
      initialEffort: "high",
      expectedEffort: "max",
      adaptive: true,
    },
    {
      name: "keeps Bedrock Opus 4.7 xhigh thinking distinct from max",
      modelId: "us.anthropic.claude-opus-4-7",
      thinkingLevel: "xhigh",
      reasoning: "xhigh",
      initialEffort: "xhigh",
      expectedEffort: "xhigh",
    },
    {
      name: "uses adaptive max thinking for Bedrock Opus 4.8",
      modelId: "us.anthropic.claude-opus-4-8",
      modelName: "Claude Opus 4.8",
      thinkingLevel: "max",
      reasoning: "max",
      initialEffort: "xhigh",
      expectedEffort: "max",
      adaptive: true,
      omitTemperature: true,
    },
    {
      name: "does not re-upgrade Mythos Preview max thinking in the final payload",
      modelId: "us.anthropic.claude-mythos-preview",
      modelName: "Claude Mythos Preview",
      thinkingLevel: "max",
      reasoning: "max",
      initialEffort: "high",
      expectedEffort: "high",
      adaptive: true,
      omitTemperature: true,
    },
  ])(
    "$name",
    async ({
      modelId,
      modelName,
      thinkingLevel,
      reasoning,
      initialEffort,
      expectedEffort,
      adaptive,
      omitTemperature,
    }) => {
      const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
      const wrapped = provider.wrapStreamFn?.({
        provider: "amazon-bedrock",
        modelId,
        streamFn: spyStreamFn,
        thinkingLevel,
      } as never);
      const result = wrapped?.(
        {
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          id: modelId,
          ...(modelName ? { name: modelName, reasoning: true } : {}),
        } as never,
        { messages: [] } as never,
        { reasoning } as never,
      ) as Record<string, unknown> | undefined;
      const payload = {
        ...(omitTemperature ? { inferenceConfig: { temperature: 0.2 } } : {}),
        additionalModelRequestFields: {
          ...(adaptive ? { thinking: { type: "adaptive" } } : {}),
          output_config: { effort: initialEffort },
        },
      };

      await (result?.onPayload as ((value: Record<string, unknown>) => unknown) | undefined)?.(
        payload,
      );

      expect(payload.additionalModelRequestFields.output_config).toEqual({
        effort: expectedEffort,
      });
      if (adaptive) {
        expect(payload.additionalModelRequestFields.thinking).toEqual({ type: "adaptive" });
      }
      if (omitTemperature) {
        expect(payload.inferenceConfig).toEqual({});
      }
    },
  );

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

      expect(result).not.toHaveProperty("capturedPayload");
      // The onPayload hook should not exist when no guardrail is configured
      expectWrappedResultFields(result, { cacheRetention: "none" });
    });

    it.each([
      {
        name: "injects all four fields when guardrail config includes optional fields",
        guardrail: {
          guardrailIdentifier: "my-guardrail-id",
          guardrailVersion: "1",
          streamProcessingMode: "sync",
          trace: "enabled",
        },
        anthropic: false,
      },
      {
        name: "injects only required fields when optional fields are omitted",
        guardrail: { guardrailIdentifier: "abc123", guardrailVersion: "DRAFT" },
        anthropic: false,
      },
      {
        name: "injects guardrailConfig for Anthropic models without cacheRetention: none",
        guardrail: {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
        anthropic: true,
        checkCacheRetention: true,
      },
      {
        name: "injects guardrailConfig for non-Anthropic models with cacheRetention: none",
        guardrail: { guardrailIdentifier: "guardrail-nova", guardrailVersion: "3" },
        anthropic: false,
        checkCacheRetention: true,
      },
    ])("$name", async ({ guardrail, anthropic, checkCacheRetention }) => {
      const provider = await registerWithConfig({ guardrail });
      const result = await callWrappedStream(
        provider,
        anthropic ? ANTHROPIC_MODEL : NON_ANTHROPIC_MODEL,
        anthropic ? ANTHROPIC_MODEL_DESCRIPTOR : MODEL_DESCRIPTOR,
      );

      expect(result.capturedPayload).toEqual({ guardrailConfig: guardrail });
      if (checkCacheRetention && anthropic) {
        expect(result).not.toHaveProperty("cacheRetention", "none");
      }
      if (checkCacheRetention && !anthropic) {
        expectWrappedResultFields(result, { cacheRetention: "none" });
      }
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

      expect(result.capturedPayload).toEqual({
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

      expect(result).not.toHaveProperty("capturedPayload");
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
      const result = await callBedrockConverse({ serviceTier: "flex" });
      expectPayloadServiceTier(result, "flex");
    });

    it("injects serviceTier for valid snake_case value ('priority')", async () => {
      const result = await callBedrockConverse({ service_tier: "priority" });
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
      const result = await callBedrockConverse({ serviceTier: "not-a-tier" });
      expect(result).not.toHaveProperty("capturedPayload");
    });

    it.each(["fable", "opus", "sonnet"])(
      "omits unsupported service tiers for Claude %s 5",
      async (family) => {
        const modelId = `us.anthropic.claude-${family}-5`;
        const result = await callBedrockConverse({ serviceTier: "flex" }, {}, modelId);
        expect(result).not.toHaveProperty("capturedPayload");
      },
    );

    it.each(["fable", "opus", "sonnet"])(
      "keeps the standard service tier for Claude %s 5",
      async (family) => {
        const modelId = `us.anthropic.claude-${family}-5`;
        const result = await callBedrockConverse({ serviceTier: "default" }, {}, modelId);
        expectPayloadServiceTier(result, "default");
      },
    );

    it("does not overwrite caller-provided serviceTier in payload", async () => {
      const result = await callBedrockConverse(
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
      expect(result).not.toHaveProperty("capturedPayload");
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

    it.each([
      {
        name: "injects cache points for application inference profile ARNs",
        options: { cacheRetention: "short" },
        expectedCachePoint: { type: "default" },
        verifyUserMessage: true,
      },
      {
        name: "uses long TTL when cacheRetention is 'long'",
        options: { cacheRetention: "long" },
        expectedCachePoint: { type: "default", ttl: "1h" },
      },
      {
        name: "does not inject cache points when cacheRetention is 'none'",
        options: { cacheRetention: "none" },
      },
      {
        name: "defaults to 'short' cache retention when not explicitly set",
        options: {},
        expectedCachePoint: { type: "default" },
      },
    ])("$name", async ({ options, expectedCachePoint, verifyUserMessage }) => {
      const provider = await registerWithConfig(undefined);
      const payload = buildBedrockCachePayload();
      await callWrappedStreamWithPayload(
        provider,
        APP_INFERENCE_PROFILE_ARN,
        APP_INFERENCE_PROFILE_DESCRIPTOR,
        options,
        payload,
      );

      const system = requireArray(payload.system, "Bedrock system prompt");
      expect(system).toHaveLength(expectedCachePoint ? 2 : 1);
      if (expectedCachePoint) {
        expect(system[1]).toEqual({ cachePoint: expectedCachePoint });
      }
      if (verifyUserMessage) {
        const messages = requireArray(payload.messages, "Bedrock messages");
        const user = requireRecord(messages[0], "last user message");
        const content = requireArray(user.content, "last user content");
        expect(content).toHaveLength(2);
        expect(content[1]).toEqual({ cachePoint: { type: "default" } });
      }
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
      expect(expectDefined(messages[0], "cached user message").content).toHaveLength(2);
    });

    it("does not inject cache points for regular Anthropic model IDs handled by the shared runtime", async () => {
      const provider = await registerWithConfig(undefined);
      const payload = buildBedrockCachePayload();

      // Regular model IDs contain "claude" so the shared runtime handles caching natively.
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

    it("does not inject cache points for older Claude models not in the shared runtime cache list", async () => {
      const provider = await registerWithConfig(undefined);
      const oldClaudeModel = "anthropic.claude-3-opus-20240229-v1:0";
      const payload = buildBedrockCachePayload();

      // Claude 3 Opus is not in the shared runtime supportsPromptCaching list, but it's
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
      expect(expectDefined(messages[0], "first user message").content).toHaveLength(1);
      // Assistant message untouched
      expect(expectDefined(messages[1], "assistant message").content).toHaveLength(1);
      // Last user message should have a cache point
      const lastUserContent = expectDefined(messages[2], "last user message").content;
      expect(lastUserContent).toHaveLength(2);
      expect(lastUserContent[1]).toEqual({ cachePoint: { type: "default" } });
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
      const payload = buildBedrockCachePayload();

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
      expect(refreshSharedConfigCache).toHaveBeenCalledTimes(1);
      expect(destroyBedrockClient).toHaveBeenCalledTimes(1);
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
      const payload = buildBedrockCachePayload("Hello", {
        inferenceConfig: { temperature: 0.3, maxTokens: 10 },
      });

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
      const payload = buildBedrockCachePayload("Hello", {
        inferenceConfig: { temperature: 0.3, maxTokens: 10 },
      });

      await callWrappedStreamWithPayload(
        provider,
        OPUS_APP_INFERENCE_PROFILE_ARN,
        makeAppInferenceProfileDescriptor(OPUS_APP_INFERENCE_PROFILE_ARN),
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
      const payload = buildBedrockCachePayload();

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
      const firstPayload = buildBedrockCachePayload();
      const secondPayload = buildBedrockCachePayload("Hello again");

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
      expect(destroyBedrockClient).toHaveBeenCalledTimes(2);
    });

    it("times out stalled profile lookup, destroys its client, and retries next request", async () => {
      vi.useFakeTimers();
      try {
        const modelId =
          "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/timeout-retry";
        const firstStarted = createDeferred<AbortSignal>();
        inferenceProfileGetResults.push(
          { stall: firstStarted.resolve },
          {
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-20250514-v1:0",
              },
            ],
          },
        );
        const provider = await registerWithConfig(undefined);
        const firstPayload = buildBedrockCachePayload();
        const secondPayload = buildBedrockCachePayload("Hello again");

        const firstRequest = callWrappedStreamWithPayload(
          provider,
          modelId,
          makeAppInferenceProfileDescriptor(modelId),
          { cacheRetention: "short" },
          firstPayload,
        );
        const firstSignal = await firstStarted.promise;
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(firstRequest).resolves.toBe(firstPayload);

        expect(firstSignal.aborted).toBe(true);
        expect(firstSignal.reason).toMatchObject({ name: "TimeoutError" });
        expect(firstPayload.system).toEqual([{ text: "You are helpful." }]);
        expect(destroyBedrockClient).toHaveBeenCalledTimes(1);

        await callWrappedStreamWithPayload(
          provider,
          modelId,
          makeAppInferenceProfileDescriptor(modelId),
          { cacheRetention: "short" },
          secondPayload,
        );

        expect(secondPayload.system).toEqual([
          { text: "You are helpful." },
          { cachePoint: { type: "default" } },
        ]);
        expect(sendBedrockCommand).toHaveBeenCalledTimes(2);
        expect(refreshSharedConfigCache).toHaveBeenCalledTimes(2);
        expect(destroyBedrockClient).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves caller cancellation across both profile lookup paths", async () => {
      const cases = [
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque-abort",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/claude-abort",
      ];

      for (const [index, modelId] of cases.entries()) {
        const started = createDeferred<AbortSignal>();
        inferenceProfileGetResults.push({ stall: started.resolve });
        const provider = await registerWithConfig(undefined);
        const controller = new AbortController();
        const reason = new Error(`caller cancelled ${index}`);
        const payload = buildBedrockCachePayload("Hello", {
          inferenceConfig: { temperature: 0.3 },
        });

        const request = callWrappedStreamWithPayload(
          provider,
          modelId,
          makeAppInferenceProfileDescriptor(modelId),
          { cacheRetention: "short", temperature: 0.3, signal: controller.signal },
          payload,
        );
        await started.promise;
        controller.abort(reason);

        await expect(request).rejects.toBe(reason);
      }

      expect(sendBedrockCommand).toHaveBeenCalledTimes(2);
      expect(refreshSharedConfigCache).toHaveBeenCalledTimes(2);
      expect(destroyBedrockClient).toHaveBeenCalledTimes(2);
    });

    it("checks caller cancellation before refreshing AWS credentials", async () => {
      const modelId =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/pre-aborted";
      const controller = new AbortController();
      const reason = new Error("cancelled before payload");
      controller.abort(reason);
      const provider = await registerWithConfig(undefined);

      await expect(
        callWrappedStreamWithPayload(
          provider,
          modelId,
          makeAppInferenceProfileDescriptor(modelId),
          { cacheRetention: "short", signal: controller.signal },
          buildBedrockCachePayload(),
        ),
      ).rejects.toBe(reason);

      expect(refreshSharedConfigCache).not.toHaveBeenCalled();
      expect(sendBedrockCommand).not.toHaveBeenCalled();
      expect(destroyBedrockClient).not.toHaveBeenCalled();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
