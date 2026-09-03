import type { EmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-providers";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type {
  AnyAgentTool,
  OpenClawPluginNodeHostCommand,
  ProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ollama lazy imports", () => {
  afterEach(() => {
    for (const moduleId of [
      "./src/memory-embedding-adapter.js",
      "./src/node-inference.js",
      "./src/setup.runtime.js",
      "./src/stream.runtime.js",
      "./src/web-search-provider.runtime.js",
      "./src/wsl2-crash-loop-check.js",
      "openclaw/plugin-sdk/runtime-env",
    ]) {
      vi.doUnmock(moduleId);
    }
    vi.resetModules();
  });

  it("loads optional runtime owners only on first use", async () => {
    let memoryImports = 0;
    let nodeInferenceImports = 0;
    let setupImports = 0;
    let streamImports = 0;
    let streamParams: Record<string, unknown> | undefined;
    let webSearchImports = 0;
    let wslImports = 0;
    let wslChecks = 0;

    vi.doMock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
      ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
      isWSL2Sync: () => {
        wslChecks += 1;
        return false;
      },
    }));
    vi.doMock("./src/memory-embedding-adapter.js", () => {
      memoryImports += 1;
      return {
        ollamaMemoryEmbeddingProviderAdapter: {
          id: "ollama",
          defaultModel: "nomic-embed-text",
          transport: "remote",
          authProviderId: "ollama",
          create: async () => ({ provider: null }),
        },
      };
    });
    vi.doMock("./src/node-inference.js", () => {
      nodeInferenceImports += 1;
      return {
        createOllamaNodeHostCommands: () => [
          {
            command: "ollama.models",
            cap: "local-inference",
            handle: async () => JSON.stringify({ provider: "ollama", models: [] }),
          },
          {
            command: "ollama.chat",
            cap: "local-inference",
            handle: async () => JSON.stringify({ provider: "ollama", response: "ok" }),
          },
        ],
        createOllamaNodeInferenceTool: () => ({
          name: "node_inference",
          label: "Node Inference",
          description: "test",
          parameters: { type: "object" },
          execute: async () => ({ content: [] }),
        }),
      };
    });
    vi.doMock("./src/setup.runtime.js", () => {
      setupImports += 1;
      return {
        promptAndConfigureOllama: async () => ({
          credential: "ollama-local",
          config: {},
        }),
      };
    });
    vi.doMock("./src/stream.runtime.js", () => {
      streamImports += 1;
      return {
        createConfiguredOllamaStreamFn: (params: Record<string, unknown>) => {
          streamParams = params;
          return async () => ({ transport: "ollama" });
        },
      };
    });
    vi.doMock("./src/web-search-provider.runtime.js", () => {
      webSearchImports += 1;
      return {
        createOllamaWebSearchProvider: () => ({
          id: "ollama",
          label: "Ollama Web Search",
          runSetup: async ({ config }: { config: unknown }) => config,
          createTool: () => ({
            description: "test",
            parameters: { type: "object" },
            execute: async ({ query }: { query: string }) => ({ query, results: [] }),
          }),
        }),
      };
    });
    vi.doMock("./src/wsl2-crash-loop-check.js", () => {
      wslImports += 1;
      return { checkWsl2CrashLoopRisk: async () => {} };
    });

    const { default: ollamaPlugin } = await import("./index.js");
    let embeddingAdapter: EmbeddingProviderAdapter | undefined;
    let mediaProvider: MediaUnderstandingProvider | undefined;
    const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
    const providers: ProviderPlugin[] = [];
    let nodeInferenceTool: AnyAgentTool | undefined;
    let webSearchProvider: WebSearchProviderPlugin | undefined;
    const runtime = createPluginRuntimeMock();
    ollamaPlugin.register(
      createTestPluginApi({
        id: "ollama",
        name: "Ollama",
        source: "test",
        config: {},
        runtime,
        registerEmbeddingProvider: (adapter) => {
          embeddingAdapter = adapter;
        },
        registerMediaUnderstandingProvider: (provider) => {
          mediaProvider = provider;
        },
        registerNodeHostCommand: (command) => nodeCommands.push(command),
        registerTool: (tool) => {
          if (typeof tool !== "function" && tool.name === "node_inference") {
            nodeInferenceTool = tool;
          }
        },
        registerProvider: (provider) => providers.push(provider),
        registerWebSearchProvider: (provider) => {
          webSearchProvider = provider;
        },
      }),
    );
    await vi.waitFor(() => expect(wslChecks).toBe(1));

    expect({
      memoryImports,
      nodeInferenceImports,
      setupImports,
      streamImports,
      webSearchImports,
      wslImports,
    }).toEqual({
      memoryImports: 0,
      nodeInferenceImports: 0,
      setupImports: 0,
      streamImports: 0,
      webSearchImports: 0,
      wslImports: 0,
    });
    expect(mediaProvider).toMatchObject({ id: "ollama", capabilities: ["image"] });

    await expect(embeddingAdapter?.create({} as never)).resolves.toEqual({ provider: null });
    await expect(nodeCommands[0]?.handle()).resolves.toBe(
      JSON.stringify({ provider: "ollama", models: [] }),
    );
    await expect(nodeInferenceTool?.execute("call-1", {}, undefined)).resolves.toEqual({
      content: [],
    });
    await expect(
      webSearchProvider?.createTool({ config: {} } as never)?.execute({ query: "openclaw" }),
    ).resolves.toEqual({
      query: "openclaw",
      results: [],
    });

    const localProvider = providers.find((provider) => provider.id === "ollama");
    await expect(
      localProvider?.auth[0]?.run({
        config: {},
        prompter: {},
      } as never),
    ).resolves.toMatchObject({
      configPatch: {},
    });
    const streamFn = localProvider?.createStreamFn?.({
      config: {
        models: {
          providers: {
            "ollama-gpu": {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11435",
              models: [],
            },
          },
        },
      },
      model: {
        api: "ollama",
        id: "qwen3:32b",
        provider: "ollama-gpu",
      },
      provider: "ollama-gpu",
    } as never);
    await expect(streamFn?.({} as never, {} as never, {})).resolves.toEqual({
      transport: "ollama",
    });
    expect(streamParams).toMatchObject({
      providerBaseUrl: "http://127.0.0.1:11435",
      localService: {
        providerId: "ollama-gpu",
        acquire: runtime.llm.acquireLocalService,
      },
    });

    expect({
      memoryImports,
      nodeInferenceImports,
      setupImports,
      streamImports,
      webSearchImports,
      wslImports,
    }).toEqual({
      memoryImports: 1,
      nodeInferenceImports: 1,
      setupImports: 1,
      streamImports: 1,
      webSearchImports: 1,
      wslImports: 0,
    });
  });
});
