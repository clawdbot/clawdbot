// Amazon Bedrock tests cover discovery plugin behavior.
import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverBedrockModels,
  mergeImplicitBedrockProvider,
  resolveBedrockConfigApiKey,
  resolveImplicitBedrockProvider,
} from "./api.js";

const sendMock = vi.fn();
const destroyMock = vi.fn();
const clientFactory = () => ({ send: sendMock, destroy: destroyMock }) as unknown as BedrockClient;

const baseActiveAnthropicSummary = {
  modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
  modelName: "Claude 3.7 Sonnet",
  providerName: "anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  modelLifecycle: { status: "ACTIVE" },
};

function buildActiveAnthropicSummary(
  modelId: string,
  modelName: string,
  inputModalities: string[] = ["TEXT"],
): typeof baseActiveAnthropicSummary {
  return { ...baseActiveAnthropicSummary, modelId, modelName, inputModalities };
}

function mockBedrockDiscovery(
  modelSummaries: Record<string, unknown>[],
  inferenceProfileSummaries: Record<string, unknown>[] = [],
): void {
  sendMock
    .mockResolvedValueOnce({ modelSummaries })
    .mockResolvedValueOnce({ inferenceProfileSummaries });
}

function buildBedrockProfile(
  inferenceProfileId: string,
  inferenceProfileName: string,
  foundationModels: string[] = [],
  options: {
    region?: string;
    type?: "SYSTEM_DEFINED" | "APPLICATION";
    status?: "ACTIVE" | "LEGACY";
    arn?: string;
  } = {},
): Record<string, unknown> {
  const region = options.region ?? "us-east-1";
  return {
    inferenceProfileId,
    inferenceProfileName,
    ...(options.arn ? { inferenceProfileArn: options.arn } : {}),
    status: options.status ?? "ACTIVE",
    type: options.type ?? "SYSTEM_DEFINED",
    models: foundationModels.map((model) => ({
      modelArn: model.startsWith("arn:")
        ? model
        : `arn:aws:bedrock:${region}::foundation-model/${model}`,
    })),
  };
}

function mockSingleActiveSummary(overrides: Partial<typeof baseActiveAnthropicSummary> = {}): void {
  mockBedrockDiscovery([{ ...baseActiveAnthropicSummary, ...overrides }]);
}

function expectModelFields(model: unknown, expected: Record<string, unknown>): void {
  if (!model || typeof model !== "object") {
    throw new Error("Expected model record");
  }
  const actual = model as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

function discoverFreshBedrockModels(
  params: Parameters<typeof discoverBedrockModels>[0],
): ReturnType<typeof discoverBedrockModels> {
  return discoverBedrockModels({
    ...params,
    discoveryMode: "strict",
    config: { ...params.config, refreshInterval: 0 },
  });
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockClear();
    destroyMock.mockClear();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    mockBedrockDiscovery([
      buildActiveAnthropicSummary(
        "anthropic.claude-3-7-sonnet-20250219-v1:0",
        "Claude 3.7 Sonnet",
        ["TEXT", "IMAGE"],
      ),
      {
        modelId: "anthropic.claude-3-haiku-20240307-v1:0",
        modelName: "Claude 3 Haiku",
        providerName: "anthropic",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: false,
        modelLifecycle: { status: "ACTIVE" },
      },
      {
        modelId: "meta.llama3-8b-instruct-v1:0",
        modelName: "Llama 3 8B",
        providerName: "meta",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "INACTIVE" },
      },
      {
        modelId: "amazon.titan-embed-text-v1",
        modelName: "Titan Embed",
        providerName: "amazon",
        inputModalities: ["TEXT"],
        outputModalities: ["EMBEDDING"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
    ]);

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      name: "Claude 3.7 Sonnet",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 4096,
    });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("applies provider filter", async () => {
    mockSingleActiveSummary();

    const models = await discoverFreshBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    mockSingleActiveSummary({
      modelId: "example.unknown-text-v1:0",
      modelName: "Example Unknown Text",
      providerName: "example",
    });

    const models = await discoverFreshBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expectModelFields(models[0], { contextWindow: 64000, maxTokens: 8192 });
  });

  it("keeps the conservative fallback for unknown inference profiles", async () => {
    mockBedrockDiscovery(
      [],
      [
        buildBedrockProfile(
          "jp.example.unknown-text-v1:0",
          "JP Example Unknown Text",
          ["example.unknown-text-v1:0"],
          { region: "ap-northeast-1" },
        ),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "ap-northeast-1", clientFactory });

    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "jp.example.unknown-text-v1:0",
      contextWindow: 32000,
      maxTokens: 4096,
      input: ["text"],
    });
  });

  it.each([
    {
      label: "Fable",
      profileId: "us.anthropic.claude-fable-5",
      profileName: "US Claude Fable 5",
      foundationId: "anthropic.claude-fable-5",
    },
    {
      label: "Mythos",
      profileId: "us.anthropic.claude-mythos-5",
      profileName: "US Claude Mythos 5",
      foundationId: "anthropic.claude-mythos-5",
    },
  ])(
    "marks known $label inference profile fallbacks as reasoning capable",
    async ({ profileId, profileName, foundationId }) => {
      mockBedrockDiscovery([], [buildBedrockProfile(profileId, profileName, [foundationId])]);

      const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });

      expect(models).toHaveLength(1);
      expectModelFields(models[0], {
        id: profileId,
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
      });
    },
  );

  it("applies the Opus 5 contract to inference-profile-only discovery", async () => {
    mockBedrockDiscovery(
      [],
      [
        buildBedrockProfile("global.anthropic.claude-opus-5", "Global Claude Opus 5", [
          "anthropic.claude-opus-5",
        ]),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });

    expectModelFields(models[0], {
      id: "global.anthropic.claude-opus-5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      params: { canonicalModelId: "claude-opus-5" },
    });
  });

  it("applies the Sonnet 5 contract to inference-profile-only discovery", async () => {
    mockBedrockDiscovery(
      [],
      [
        buildBedrockProfile("global.anthropic.claude-sonnet-5", "Global Claude Sonnet 5", [
          "anthropic.claude-sonnet-5",
        ]),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });

    expectModelFields(models[0], {
      id: "global.anthropic.claude-sonnet-5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
      params: { canonicalModelId: "claude-sonnet-5" },
    });
  });

  it("skips Mythos Preview inference profiles because Mantle owns that route", async () => {
    mockBedrockDiscovery(
      [],
      [
        buildBedrockProfile("us.anthropic.claude-mythos-preview", "US Claude Mythos Preview", [
          "anthropic.claude-mythos-preview",
        ]),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });

    expect(models).toEqual([]);
  });

  it("normalizes region-prefixed versioned model ids when resolving context windows", async () => {
    mockBedrockDiscovery(
      [],
      [
        buildBedrockProfile(
          "jp.anthropic.claude-sonnet-4-6",
          "JP Claude Sonnet 4.6",
          ["anthropic.claude-sonnet-4-6"],
          { region: "ap-northeast-1" },
        ),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "ap-northeast-1", clientFactory });

    expectModelFields(models[0], {
      id: "jp.anthropic.claude-sonnet-4-6",
      contextWindow: 1_000_000,
    });
  });

  it("uses 1M context window for dotted Claude Opus 4.8 Bedrock refs", async () => {
    mockBedrockDiscovery(
      [buildActiveAnthropicSummary("anthropic.claude-opus-4.8-v1:0", "Claude Opus 4.8")],
      [
        buildBedrockProfile("us.anthropic.claude-opus-4.8-v1:0", "US Claude Opus 4.8", [
          "anthropic.claude-opus-4.8-v1:0",
        ]),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });

    expectModelFields(
      models.find((model) => model.id === "anthropic.claude-opus-4.8-v1:0"),
      {
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
    );
    expectModelFields(
      models.find((model) => model.id === "us.anthropic.claude-opus-4.8-v1:0"),
      {
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
    );
  });

  it("applies Fable limits and reasoning metadata to foundation and profile models", async () => {
    mockBedrockDiscovery(
      [
        buildActiveAnthropicSummary("anthropic.claude-fable-5", "Claude Fable 5", [
          "TEXT",
          "IMAGE",
        ]),
      ],
      [
        buildBedrockProfile("company-fable", "Company Fable", ["anthropic.claude-fable-5"], {
          type: "APPLICATION",
        }),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });
    const expected = {
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    };

    expectModelFields(
      models.find((model) => model.id === "anthropic.claude-fable-5"),
      expected,
    );
    expectModelFields(
      models.find((model) => model.id === "company-fable"),
      {
        ...expected,
        params: { canonicalModelId: "claude-fable-5" },
      },
    );
  });

  it("caches results when refreshInterval is enabled", async () => {
    mockSingleActiveSummary();

    await discoverBedrockModels({ region: "cache-reuse", clientFactory });
    await discoverBedrockModels({ region: "cache-reuse", clientFactory });
    // 2 calls on first discovery (ListFoundationModels + ListInferenceProfiles), 0 on cached second.
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("skips cache when refreshInterval expiry overflows", async () => {
    mockSingleActiveSummary();
    mockSingleActiveSummary();

    await discoverBedrockModels({
      region: "cache-overflow",
      config: { refreshInterval: 1 },
      now: () => 8_640_000_000_000_000,
      clientFactory,
    });
    await discoverBedrockModels({
      region: "cache-overflow",
      config: { refreshInterval: 1 },
      now: () => 8_640_000_000_000_000,
      clientFactory,
    });
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("skips cache when refreshInterval is 0", async () => {
    mockSingleActiveSummary();
    mockSingleActiveSummary();

    await discoverBedrockModels({
      region: "cache-disabled",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    await discoverBedrockModels({
      region: "cache-disabled",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    // 2 calls per discovery (ListFoundationModels + ListInferenceProfiles) × 2 runs.
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("aborts stalled Bedrock model discovery requests", async () => {
    vi.useFakeTimers();
    const abortSignals: AbortSignal[] = [];
    try {
      sendMock.mockImplementation((_command: unknown, options?: { abortSignal?: AbortSignal }) => {
        const signal = options?.abortSignal;
        if (!signal) {
          throw new Error("expected Bedrock discovery abort signal");
        }
        abortSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            },
            { once: true },
          );
        });
      });

      const discovery = discoverFreshBedrockModels({ region: "abort-timeout", clientFactory });
      const rejected = expect(discovery).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30_000);

      await rejected;
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(abortSignals).toHaveLength(2);
      expect(abortSignals.every((signal) => signal.aborted)).toBe(true);
      expect(destroyMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the Bedrock config apiKey from AWS auth env vars", () => {
    expect(
      resolveBedrockConfigApiKey({
        AWS_BEARER_TOKEN_BEDROCK: "bearer", // pragma: allowlist secret
        AWS_PROFILE: "default",
      }),
    ).toBe("AWS_BEARER_TOKEN_BEDROCK");

    // When no AWS env vars are present (e.g. instance role), no marker should be injected.
    // The aws-sdk credential chain handles auth at request time. (#49891)
    expect(resolveBedrockConfigApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();

    // When AWS_PROFILE is explicitly set, it should return the marker.
    expect(resolveBedrockConfigApiKey({ AWS_PROFILE: "default" } as NodeJS.ProcessEnv)).toBe(
      "AWS_PROFILE",
    );
  });

  it("discovers inference profiles and inherits foundation model capabilities", async () => {
    const foundationId = "anthropic.claude-sonnet-4-6";
    mockBedrockDiscovery(
      [buildActiveAnthropicSummary(foundationId, "Claude Sonnet 4.6", ["TEXT", "IMAGE"])],
      [
        buildBedrockProfile(
          "us.anthropic.claude-sonnet-4-6",
          "US Anthropic Claude Sonnet 4.6",
          [foundationId, "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6"],
          {
            arn: "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-sonnet-4-6",
          },
        ),
        buildBedrockProfile(
          "eu.anthropic.claude-sonnet-4-6",
          "EU Anthropic Claude Sonnet 4.6",
          [foundationId],
          {
            region: "eu-west-1",
            arn: "arn:aws:bedrock:eu-west-1::inference-profile/eu.anthropic.claude-sonnet-4-6",
          },
        ),
        buildBedrockProfile(
          "global.anthropic.claude-sonnet-4-6",
          "Global Anthropic Claude Sonnet 4.6",
          [foundationId],
          {
            arn: "arn:aws:bedrock:us-east-1::inference-profile/global.anthropic.claude-sonnet-4-6",
          },
        ),
        // Inactive profile should be filtered out.
        buildBedrockProfile("ap.anthropic.claude-sonnet-4-6", "AP Claude Sonnet 4.6", [], {
          status: "LEGACY",
        }),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });

    // Foundation model + 3 active inference profiles = 4 models.
    expect(models).toHaveLength(4);

    // Global profiles should be sorted first (recommended for most users).
    expect(models[0]?.id).toBe("global.anthropic.claude-sonnet-4-6");

    const foundationModel = models.find((m) => m.id === "anthropic.claude-sonnet-4-6");
    const usProfile = models.find((m) => m.id === "us.anthropic.claude-sonnet-4-6");
    const euProfile = models.find((m) => m.id === "eu.anthropic.claude-sonnet-4-6");
    const globalProfile = models.find((m) => m.id === "global.anthropic.claude-sonnet-4-6");

    // Foundation model has image input.
    expectModelFields(foundationModel, { input: ["text", "image"] });

    // Inference profiles inherit image input from the foundation model.
    expectModelFields(usProfile, {
      name: "US Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 4096,
      params: { canonicalModelId: "claude-sonnet-4-6" },
    });
    expect(usProfile?.thinkingLevelMap).toBeUndefined();
    expectModelFields(euProfile, { input: ["text", "image"] });
    expectModelFields(globalProfile, { input: ["text", "image"] });

    // Inactive profile should not be present.
    expect(models.find((m) => m.id === "ap.anthropic.claude-sonnet-4-6")).toBeUndefined();
  });

  it.each(["foundation", "profiles", "profile-page"])(
    "rejects failed %s acquisition and retries the complete catalog",
    async (surface) => {
      const failure = Object.assign(new Error("AccessDeniedException"), {
        $metadata: { httpStatusCode: 403 },
      });
      const profile = buildBedrockProfile("us.amazon.nova-micro-v1:0", "US Nova", [
        "amazon.nova-micro-v1:0",
      ]);
      if (surface === "foundation") {
        sendMock.mockRejectedValueOnce(failure).mockResolvedValueOnce({});
      } else {
        sendMock.mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] });
        if (surface === "profile-page") {
          sendMock.mockResolvedValueOnce({
            inferenceProfileSummaries: [profile],
            nextToken: "next-page",
          });
        }
        sendMock.mockRejectedValueOnce(failure);
      }
      const params = {
        region: `failed-${surface}`,
        clientFactory,
        discoveryMode: "strict" as const,
      };
      await expect(discoverBedrockModels(params)).rejects.toMatchObject({ status: 403 });
      expect(destroyMock).toHaveBeenCalledTimes(1);

      mockBedrockDiscovery([baseActiveAnthropicSummary], [profile]);
      const recovered = await discoverBedrockModels(params);
      expect(recovered.map((model) => model.id)).toEqual([
        baseActiveAnthropicSummary.modelId,
        profile.inferenceProfileId,
      ]);
      expect(destroyMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, "strict"] as const)(
    "preserves the %s empty-result contract and caches it",
    async (discoveryMode) => {
      mockBedrockDiscovery([]);
      const params = {
        pluginConfig: { discovery: { enabled: true, region: `successful-empty-${discoveryMode}` } },
        discoveryMode,
        env: {},
        clientFactory,
      };
      const first = await resolveImplicitBedrockProvider(params);
      const second = await resolveImplicitBedrockProvider(params);
      if (discoveryMode === "strict") {
        expect(first).toMatchObject({ models: [] });
        expect(second).toMatchObject({ models: [] });
      } else {
        expect(first).toBeNull();
        expect(second).toBeNull();
      }
      expect(sendMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["foundation", "profiles"])(
    "preserves public %s failure defaults without caching incomplete inventory",
    async (surface) => {
      const failure = new Error("catalog unavailable");
      if (surface === "foundation") {
        sendMock.mockRejectedValueOnce(failure).mockResolvedValueOnce({});
      } else {
        sendMock
          .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
          .mockRejectedValueOnce(failure);
      }
      const params = { region: `advisory-${surface}`, clientFactory };
      const initial = await discoverBedrockModels(params);
      expect(initial.map((model) => model.id)).toEqual(
        surface === "foundation" ? [] : [baseActiveAnthropicSummary.modelId],
      );
      mockBedrockDiscovery(
        [baseActiveAnthropicSummary],
        [buildBedrockProfile("us.amazon.nova-micro-v1:0", "US Nova", ["amazon.nova-micro-v1:0"])],
      );
      expect(await discoverBedrockModels(params)).toHaveLength(2);
      expect(sendMock).toHaveBeenCalledTimes(4);
      expect(destroyMock).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps public implicit-provider failures null", async () => {
    sendMock.mockRejectedValueOnce(new Error("catalog unavailable")).mockResolvedValueOnce({});
    await expect(
      resolveImplicitBedrockProvider({
        env: {},
        pluginConfig: { discovery: { enabled: true, region: "advisory-implicit-failure" } },
        clientFactory,
      }),
    ).resolves.toBeNull();
  });

  it("keeps strict callers out of an advisory in-flight failure", async () => {
    const started = createDeferred<void>();
    const profiles = createDeferred<never>();
    const failure = Object.assign(new Error("AccessDeniedException"), {
      $metadata: { httpStatusCode: 403 },
    });
    sendMock
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockImplementationOnce(() => {
        started.resolve();
        return profiles.promise;
      })
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockRejectedValueOnce(failure);
    const params = { region: "advisory-strict-in-flight", clientFactory };
    const advisory = discoverBedrockModels(params);
    await started.promise;
    await expect(
      discoverBedrockModels({ ...params, discoveryMode: "strict" }),
    ).rejects.toMatchObject({ status: 403 });
    profiles.reject(failure);
    await expect(advisory).resolves.toMatchObject([{ id: baseActiveAnthropicSummary.modelId }]);
    mockBedrockDiscovery([baseActiveAnthropicSummary]);
    await expect(
      discoverBedrockModels({ ...params, discoveryMode: "strict" }),
    ).resolves.toMatchObject([{ id: baseActiveAnthropicSummary.modelId }]);
    expect(sendMock).toHaveBeenCalledTimes(6);
    expect(destroyMock).toHaveBeenCalledTimes(3);
  });

  it.each([false, undefined])(
    "keeps non-attempt discovery null when enabled is %s",
    async (enabled) => {
      await expect(
        resolveImplicitBedrockProvider({
          pluginConfig: { discovery: { enabled } },
          env: {},
          clientFactory,
        }),
      ).resolves.toBeNull();
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it("keeps matching inference profiles when provider filters are enabled", async () => {
    mockBedrockDiscovery(
      [
        buildActiveAnthropicSummary("anthropic.claude-sonnet-4-6", "Claude Sonnet 4.6", [
          "TEXT",
          "IMAGE",
        ]),
      ],
      [
        buildBedrockProfile(
          "global.anthropic.claude-sonnet-4-6",
          "Global Anthropic Claude Sonnet 4.6",
          ["anthropic.claude-sonnet-4-6"],
        ),
      ],
    );

    const models = await discoverFreshBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["anthropic"] },
      clientFactory,
    });

    expect(models.map((model) => model.id)).toEqual([
      "global.anthropic.claude-sonnet-4-6",
      "anthropic.claude-sonnet-4-6",
    ]);
  });

  it("prefers backing model ARNs for application profiles with region-like ids", async () => {
    mockBedrockDiscovery(
      [
        buildActiveAnthropicSummary("anthropic.claude-sonnet-4-6", "Claude Sonnet 4.6", [
          "TEXT",
          "IMAGE",
        ]),
      ],
      [
        buildBedrockProfile(
          "us.my-prod-profile",
          "Prod Claude Profile",
          ["anthropic.claude-sonnet-4-6"],
          { type: "APPLICATION" },
        ),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });
    const profile = models.find((model) => model.id === "us.my-prod-profile");

    expectModelFields(profile, {
      id: "us.my-prod-profile",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 4096,
    });
  });

  it("uses the resolved base model id for application-profile context fallback", async () => {
    mockBedrockDiscovery(
      [],
      [
        buildBedrockProfile(
          "us.my-prod-profile",
          "Prod Claude Profile",
          ["anthropic.claude-opus-4-6-v1"],
          { type: "APPLICATION" },
        ),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "us-east-1", clientFactory });

    expectModelFields(models[0], {
      id: "us.my-prod-profile",
      contextWindow: 1_000_000,
      maxTokens: 4096,
      input: ["text"],
      params: { canonicalModelId: "claude-opus-4-6-v1" },
      thinkingLevelMap: { xhigh: null, max: "max" },
    });
  });

  it("merges implicit Bedrock models into explicit provider overrides", () => {
    expect(
      mergeImplicitBedrockProvider({
        existing: {
          baseUrl: "https://override.example.com",
          headers: { "x-test-header": "1" },
          models: [],
        },
        implicit: {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
          models: [
            {
              id: "amazon.nova-micro-v1:0",
              name: "Nova",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1,
              maxTokens: 1,
            },
          ],
        },
      }).models?.map((model) => model.id),
    ).toEqual(["amazon.nova-micro-v1:0"]);
  });

  it("uses plugin-owned discovery config without runtime legacy fallback", async () => {
    mockSingleActiveSummary();

    const pluginEnabled = await resolveImplicitBedrockProvider({
      pluginConfig: {
        discovery: {
          enabled: true,
          region: "us-east-1",
          refreshInterval: 0,
        },
      },
      env: {} as NodeJS.ProcessEnv,
      clientFactory,
    });

    expect(pluginEnabled?.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    // 2 calls per discovery (ListFoundationModels + ListInferenceProfiles).
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "secondary region when the primary env override is blank",
      env: { AWS_REGION: "   ", AWS_DEFAULT_REGION: "eu-west-1" },
      expectedRegion: "eu-west-1",
    },
    {
      name: "plugin default when both region env overrides are blank",
      env: { AWS_REGION: "", AWS_DEFAULT_REGION: "   " },
      expectedRegion: "us-east-1",
    },
    {
      name: "primary region when both env overrides are nonblank",
      env: { AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "eu-west-1" },
      expectedRegion: "ap-southeast-2",
    },
  ])("uses $name", async ({ env, expectedRegion }) => {
    mockSingleActiveSummary();

    const provider = await resolveImplicitBedrockProvider({
      pluginConfig: { discovery: { enabled: true, refreshInterval: 0 } },
      env,
      clientFactory,
    });

    expect(provider?.baseUrl).toBe(`https://bedrock-runtime.${expectedRegion}.amazonaws.com`);
  });

  // Ported from #65449 by @alickgithub2 — extended to also cover apac. prefix
  it("resolves au. and apac. prefixes for regional inference profiles", async () => {
    mockBedrockDiscovery(
      [
        buildActiveAnthropicSummary("anthropic.claude-sonnet-4-6", "Claude Sonnet 4.6", [
          "TEXT",
          "IMAGE",
        ]),
      ],
      [
        // Empty model ARNs intentionally force the regional prefix fallback.
        buildBedrockProfile(
          "au.anthropic.claude-sonnet-4-6",
          "AU Anthropic Claude Sonnet 4.6",
          [],
          {
            arn: "arn:aws:bedrock:ap-southeast-2::inference-profile/au.anthropic.claude-sonnet-4-6",
          },
        ),
        buildBedrockProfile(
          "apac.anthropic.claude-sonnet-4-6",
          "APAC Anthropic Claude Sonnet 4.6",
          [],
          {
            arn: "arn:aws:bedrock:ap-northeast-1::inference-profile/apac.anthropic.claude-sonnet-4-6",
          },
        ),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "ap-southeast-2", clientFactory });

    // Foundation model + 2 regional inference profiles
    expect(models).toHaveLength(3);

    const auProfile = models.find((m) => m.id === "au.anthropic.claude-sonnet-4-6");
    expectModelFields(auProfile, {
      id: "au.anthropic.claude-sonnet-4-6",
      name: "AU Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
    });

    const apacProfile = models.find((m) => m.id === "apac.anthropic.claude-sonnet-4-6");
    expectModelFields(apacProfile, {
      id: "apac.anthropic.claude-sonnet-4-6",
      name: "APAC Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
    });
  });
});
