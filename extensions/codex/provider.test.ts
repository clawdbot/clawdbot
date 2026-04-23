import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "./prompt-overlay.js";
import { codexProviderDiscovery } from "./provider-discovery.js";
import { buildCodexProvider, buildCodexProviderCatalog } from "./provider.js";
import { CodexAppServerClient } from "./src/app-server/client.js";
import {
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
  expect(result.provider.models.map((model) => model.id)).toEqual([
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.2",
  ]);
}

function createFakeCodexClient(): CodexAppServerClient {
  return {
    initialize: vi.fn(async () => undefined),
    request: vi.fn(async () => ({ data: [] })),
    addCloseHandler: vi.fn(() => () => undefined),
    close: vi.fn(),
  } as unknown as CodexAppServerClient;
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

    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, timeoutMs: 1234, sharedClient: false }),
    );
    expect(result.provider).toMatchObject({
      auth: "token",
      api: "openai-codex-responses",
      models: [
        {
          id: "gpt-5.4",
          name: "gpt-5.4",
          reasoning: true,
          input: ["text", "image"],
          compat: { supportsReasoningEffort: true },
        },
      ],
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

    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, timeoutMs: 4321, sharedClient: false }),
    );
    expect(result).toMatchObject({
      provider: {
        models: [{ id: "gpt-5.4" }],
      },
    });
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
    });

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("does not close an active shared app-server client during live discovery", async () => {
    const activeClient = createFakeCodexClient();
    const discoveryClient = createFakeCodexClient();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(activeClient)
      .mockReturnValueOnce(discoveryClient);

    await getSharedCodexAppServerClient({ timeoutMs: 1000 });
    await buildCodexProviderCatalog({
      env: { OPENCLAW_CODEX_DISCOVERY_LIVE: "1" },
    });

    expect(activeClient.close).not.toHaveBeenCalled();
    expect(discoveryClient.close).toHaveBeenCalledTimes(1);
  });

  it("resolves arbitrary Codex app-server model ids through the codex provider", () => {
    const provider = buildCodexProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "codex",
      modelId: " custom-model ",
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toMatchObject({
      id: "custom-model",
      provider: "codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
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

    expect(model).toMatchObject({
      id: "o4-mini",
      reasoning: true,
      compat: { supportsReasoningEffort: true },
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
    ).toEqual(["gpt-5.5", "gpt-5.4-mini", "gpt-5.2"]);
  });

  it("adds the GPT-5 prompt overlay to Codex provider runs", () => {
    const provider = buildCodexProvider();

    expect(
      provider.resolveSystemPromptContribution?.({
        provider: "codex",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      stablePrefix: CODEX_GPT5_BEHAVIOR_CONTRACT,
      sectionOverrides: {
        interaction_style: expect.stringContaining(
          "Quiet monitoring does not satisfy an explicit ongoing-work instruction.",
        ),
      },
    });
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
