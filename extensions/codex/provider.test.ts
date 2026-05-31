import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "./prompt-overlay.js";
import { codexProviderDiscovery } from "./provider-discovery.js";
import { buildCodexProvider, buildCodexProviderCatalog } from "./provider.js";
import { CodexAppServerClient } from "./src/app-server/client.js";
import type { listCodexAppServerModels } from "./src/app-server/models.js";
import {
  createIsolatedCodexAppServerClient,
  getSharedCodexAppServerClient,
  resetSharedCodexAppServerClientForTests,
} from "./src/app-server/shared-client.js";

afterEach(() => {
  resetSharedCodexAppServerClientForTests();
  vi.restoreAllMocks();
});

function expectStaticFallbackCatalog(
  result: Awaited<ReturnType<typeof buildCodexProviderCatalog>>,
) {
  expect(result.provider.models.map((model) => model.id)).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
}

function createFakeCodexClient(): CodexAppServerClient {
  return {
    initialize: vi.fn(async () => undefined),
    request: vi.fn(async () => ({ data: [] })),
    setActiveSharedLeaseCountProviderForUnscopedNotifications: vi.fn(),
    addCloseHandler: vi.fn(() => () => undefined),
    close: vi.fn(),
  } as unknown as CodexAppServerClient;
}

const TEST_CODEX_APP_SERVER_CONFIG = {
  appServer: {
    command: "/tmp/openclaw-test-codex",
  },
};

async function listTestCodexAppServerModels(
  options: Parameters<typeof listCodexAppServerModels>[0] = {},
) {
  expect(options.sharedClient).toBe(false);
  const client = await createIsolatedCodexAppServerClient({
    startOptions: options.startOptions,
    timeoutMs: options.timeoutMs,
    authProfileId: null,
  });
  try {
    await client.request(
      "model/list",
      {
        limit: options.limit ?? null,
        cursor: options.cursor ?? null,
        includeHidden: options.includeHidden ?? null,
      },
      { timeoutMs: options.timeoutMs },
    );
    return { models: [] };
  } finally {
    client.close();
  }
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>) {
  if (!value || typeof value !== "object") {
    throw new Error("Expected record");
  }
  const actual = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(actual[key]).toEqual(expectedValue);
  }
  return actual;
}

function mockCallArg(mockFn: { mock: { calls: unknown[][] } }, callIndex: number): unknown {
  return mockFn.mock.calls[callIndex]?.[0];
}

describe("codex provider", () => {
  it("maps Codex app-server models to a Codex provider catalog", async () => {
    const listModels = vi.fn(async () => ({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          hidden: false,
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        },
        {
          id: "hidden-model",
          model: "hidden-model",
          hidden: true,
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    }));

    const result = await buildCodexProviderCatalog({
      env: {},
      listModels,
      pluginConfig: { discovery: { timeoutMs: 1234 } },
    });

    expectRecordFields(mockCallArg(listModels, 0), {
      limit: 100,
      timeoutMs: 1234,
      sharedClient: false,
    });
    expectRecordFields(result.provider, {
      auth: "token",
      api: "openai-chatgpt-responses",
    });
    expect(result.provider.models).toHaveLength(1);
    expectRecordFields(result.provider.models[0], {
      id: "gpt-5.4",
      name: "gpt-5.4",
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsReasoningEffort: true, supportsUsageInStreaming: true },
    });
  });

  it("keeps a static fallback catalog when discovery is disabled", async () => {
    const listModels = vi.fn();

    const result = await buildCodexProviderCatalog({
      env: {},
      listModels,
      pluginConfig: { discovery: { enabled: false } },
    });

    expect(listModels).not.toHaveBeenCalled();
    expectStaticFallbackCatalog(result);
  });

  it("uses live plugin config to re-enable discovery after startup disable", async () => {
    const listModels = vi.fn(async () => ({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          hidden: false,
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        },
      ],
    }));
    const provider = buildCodexProvider({
      pluginConfig: { discovery: { enabled: false } },
      listModels,
    });

    const result = await provider.catalog?.run({
      config: {
        plugins: {
          entries: {
            codex: {
              config: {
                discovery: {
                  enabled: true,
                  timeoutMs: 4321,
                },
              },
            },
          },
        },
      },
      env: {},
    } as never);

    expectRecordFields(mockCallArg(listModels, 0), {
      limit: 100,
      timeoutMs: 4321,
      sharedClient: false,
    });
    const resultProvider = result && "provider" in result ? result.provider : undefined;
    expect(resultProvider?.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
  });

  it("pages through live discovery before building the provider catalog", async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce({
        models: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            hidden: false,
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        models: [
          {
            id: "gpt-5.5",
            model: "gpt-5.5",
            hidden: false,
            inputModalities: ["text"],
            supportedReasoningEfforts: [],
          },
        ],
      });

    const result = await buildCodexProviderCatalog({
      env: {},
      listModels,
    });

    expectRecordFields(mockCallArg(listModels, 0), {
      cursor: undefined,
      limit: 100,
      sharedClient: false,
    });
    expectRecordFields(mockCallArg(listModels, 1), {
      cursor: "page-2",
      limit: 100,
      sharedClient: false,
    });
    expect(result.provider.models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"]);
  });

  it("reports discovery failures before using the fallback catalog", async () => {
    const error = new Error("app-server down");
    const onDiscoveryFailure = vi.fn();
    const listModels = vi.fn(async () => {
      throw error;
    });

    const result = await buildCodexProviderCatalog({
      env: {},
      listModels,
      onDiscoveryFailure,
    });

    expect(onDiscoveryFailure).toHaveBeenCalledWith(error);
    expectStaticFallbackCatalog(result);
  });

  it("keeps a static fallback catalog when live discovery is explicitly disabled by env", async () => {
    const listModels = vi.fn();

    const result = await buildCodexProviderCatalog({
      env: { OPENCLAW_CODEX_DISCOVERY_LIVE: "0" },
      listModels,
    });

    expect(listModels).not.toHaveBeenCalled();
    expectStaticFallbackCatalog(result);
  });

  it("closes the transient app-server client after live discovery", async () => {
    const client = createFakeCodexClient();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(client);

    await buildCodexProviderCatalog({
      env: { OPENCLAW_CODEX_DISCOVERY_LIVE: "1" },
      pluginConfig: TEST_CODEX_APP_SERVER_CONFIG,
      listModels: listTestCodexAppServerModels,
    });

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("does not close an active shared app-server client during live discovery", async () => {
    const activeClient = createFakeCodexClient();
    const discoveryClient = createFakeCodexClient();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(activeClient)
      .mockReturnValueOnce(discoveryClient);

    await getSharedCodexAppServerClient({
      startOptions: {
        transport: "stdio",
        command: "/tmp/openclaw-test-codex",
        commandSource: "config",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
      timeoutMs: 1000,
      authProfileId: null,
    });
    await buildCodexProviderCatalog({
      env: { OPENCLAW_CODEX_DISCOVERY_LIVE: "1" },
      pluginConfig: TEST_CODEX_APP_SERVER_CONFIG,
      listModels: listTestCodexAppServerModels,
    });

    expect(activeClient.close).not.toHaveBeenCalled();
    expect(discoveryClient.close).toHaveBeenCalledTimes(1);
  });

  it("resolves arbitrary Codex app-server model ids as text-only until discovered", () => {
    const provider = buildCodexProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "codex",
      modelId: " custom-model ",
      modelRegistry: { find: () => null },
    } as never);

    expectRecordFields(model, {
      id: "custom-model",
      provider: "codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
    });
  });

  it("keeps fallback Codex app-server models image-capable", () => {
    const provider = buildCodexProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "codex",
      modelId: "gpt-5.5",
      modelRegistry: { find: () => null },
    } as never);

    expectRecordFields(model, {
      id: "gpt-5.5",
      input: ["text", "image"],
    });
  });

  it("treats o4 ids as reasoning-capable Codex models", () => {
    const provider = buildCodexProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "codex",
      modelId: "o4-mini",
      modelRegistry: { find: () => null },
    } as never);

    expectRecordFields(model, {
      id: "o4-mini",
      reasoning: true,
      compat: { supportsReasoningEffort: true, supportsUsageInStreaming: true },
    });
    expect(
      provider
        .resolveThinkingProfile?.({ provider: "codex", modelId: "o4-mini" } as never)
        ?.levels.some((level) => level.id === "xhigh"),
    ).toBe(true);
  });

  it("declares synthetic auth because the harness owns Codex credentials", () => {
    const provider = buildCodexProvider();

    expect(provider.resolveSyntheticAuth?.({ provider: "codex" })).toEqual({
      apiKey: "codex-app-server",
      source: "codex-app-server",
      mode: "token",
    });
  });

  it("exposes a setup auth choice for installing Codex as an external provider", async () => {
    const provider = buildCodexProvider();

    const authChoice = provider.auth[0];
    expectRecordFields(authChoice, {
      id: "app-server",
      kind: "custom",
    });
    expectRecordFields(authChoice?.wizard, {
      choiceId: "codex",
      choiceLabel: "Codex app-server",
      onboardingScopes: ["text-inference"],
    });
    const authResult = await authChoice?.run({} as never);
    expectRecordFields(authResult, {
      profiles: [],
      defaultModel: "codex/gpt-5.5",
    });
  });

  it("exposes a lightweight provider-discovery entry for model list/status", async () => {
    expect(codexProviderDiscovery.id).toBe("codex");
    expect(codexProviderDiscovery.resolveSyntheticAuth?.({ provider: "codex" })).toEqual({
      apiKey: "codex-app-server",
      source: "codex-app-server",
      mode: "token",
    });

    const result = await codexProviderDiscovery.staticCatalog?.run({
      config: {},
      env: {},
      agentDir: "/tmp/openclaw-agent",
    } as never);

    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });

  it("adds the GPT-5 prompt overlay to Codex provider runs", () => {
    const provider = buildCodexProvider();

    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "codex",
      modelId: "gpt-5.4",
    } as never);
    expectRecordFields(contribution, {
      stablePrefix: CODEX_GPT5_BEHAVIOR_CONTRACT,
    });
    const interactionStyle = contribution?.sectionOverrides?.interaction_style;
    expect(interactionStyle).toContain("Live chat tone: short, natural, human.");
    expect(interactionStyle).not.toContain("Use heartbeats to create useful proactive progress");
  });

  it("does not add the GPT-5 prompt overlay to non-GPT-5 Codex provider runs", () => {
    const provider = buildCodexProvider();

    expect(
      provider.resolveSystemPromptContribution?.({
        provider: "codex",
        modelId: "o4-mini",
      } as never),
    ).toBeUndefined();
  });
});
