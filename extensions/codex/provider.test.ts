import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(result.provider.models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
    ]);
  });

  it("keeps a static fallback catalog when live discovery is explicitly disabled by env", async () => {
    const listModels = vi.fn();

    const result = await buildCodexProviderCatalog({
      env: { OPENCLAW_CODEX_DISCOVERY_LIVE: "0" },
      listModels,
    });

    expect(listModels).not.toHaveBeenCalled();
    expect(result.provider.models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
    ]);
  });

  it("closes the transient app-server client after live discovery", async () => {
    const client = {
      initialize: vi.fn(async () => undefined),
      request: vi.fn(async () => ({ data: [] })),
      addCloseHandler: vi.fn(() => () => undefined),
      close: vi.fn(),
    } as unknown as CodexAppServerClient;
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(client);

    await buildCodexProviderCatalog({
      env: { OPENCLAW_CODEX_DISCOVERY_LIVE: "1" },
    });

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("does not close an active shared app-server client during live discovery", async () => {
    const activeClient = {
      initialize: vi.fn(async () => undefined),
      request: vi.fn(async () => ({ data: [] })),
      addCloseHandler: vi.fn(() => () => undefined),
      close: vi.fn(),
    } as unknown as CodexAppServerClient;
    const discoveryClient = {
      initialize: vi.fn(async () => undefined),
      request: vi.fn(async () => ({ data: [] })),
      addCloseHandler: vi.fn(() => () => undefined),
      close: vi.fn(),
    } as unknown as CodexAppServerClient;
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
    expect(provider.supportsXHighThinking?.({ provider: "codex", modelId: "o4-mini" })).toBe(true);
  });

  it("declares synthetic auth because the harness owns Codex credentials", () => {
    const provider = buildCodexProvider();

    expect(provider.resolveSyntheticAuth?.({ provider: "codex" })).toEqual({
      apiKey: "codex-app-server",
      source: "codex-app-server",
      mode: "token",
    });
  });
});
