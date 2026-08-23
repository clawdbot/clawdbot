import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
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
      "./src/embedding-provider.runtime.js",
      "./src/media-understanding-provider.js",
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
    let embeddingImports = 0;
    let mediaImports = 0;
    let memoryImports = 0;
    let nodeInferenceImports = 0;
    let setupImports = 0;
    let streamImports = 0;
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
    vi.doMock("./src/embedding-provider.runtime.js", () => {
      embeddingImports += 1;
      return {
        createOllamaEmbeddingProvider: async () => ({
          provider: { id: "ollama", model: "nomic-embed-text" },
          client: { baseUrl: "http://127.0.0.1:11434" },
        }),
      };
    });
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
    vi.doMock("./src/media-understanding-provider.js", () => {
      mediaImports += 1;
      return {
        ollamaMediaUnderstandingProvider: {
          id: "ollama",
          capabilities: ["image"],
          describeImage: async () => ({ text: "image" }),
          describeImages: async () => ({ text: "images" }),
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
        createConfiguredOllamaStreamFn: () => async () => ({ transport: "ollama" }),
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
    let embeddingAdapter: MemoryEmbeddingProviderAdapter | undefined;
    let mediaProvider: MediaUnderstandingProvider | undefined;
    const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
    const providers: ProviderPlugin[] = [];
    let nodeInferenceTool: AnyAgentTool | undefined;
    let webSearchProvider: WebSearchProviderPlugin | undefined;
    ollamaPlugin.register(
      createTestPluginApi({
        id: "ollama",
        name: "Ollama",
        source: "test",
        config: {},
        runtime: createPluginRuntimeMock(),
        registerMemoryEmbeddingProvider: (adapter) => {
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
      embeddingImports,
      mediaImports,
      memoryImports,
      nodeInferenceImports,
      setupImports,
      streamImports,
      webSearchImports,
      wslImports,
    }).toEqual({
      embeddingImports: 0,
      mediaImports: 0,
      memoryImports: 0,
      nodeInferenceImports: 0,
      setupImports: 0,
      streamImports: 0,
      webSearchImports: 0,
      wslImports: 0,
    });

    await expect(embeddingAdapter?.create({} as never)).resolves.toEqual({ provider: null });
    await expect(mediaProvider?.describeImage?.({} as never)).resolves.toEqual({ text: "image" });
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
      localProvider?.createEmbeddingProvider?.({
        config: {},
        model: "",
        provider: "ollama",
      } as never),
    ).resolves.toMatchObject({
      id: "ollama",
      client: { baseUrl: "http://127.0.0.1:11434" },
    });
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
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      model: {
        api: "ollama",
        id: "qwen3:32b",
        provider: "ollama",
      },
      provider: "ollama",
    } as never);
    await expect(streamFn?.({} as never, {} as never, {})).resolves.toEqual({
      transport: "ollama",
    });

    expect({
      embeddingImports,
      mediaImports,
      memoryImports,
      nodeInferenceImports,
      setupImports,
      streamImports,
      webSearchImports,
      wslImports,
    }).toEqual({
      embeddingImports: 1,
      mediaImports: 1,
      memoryImports: 1,
      nodeInferenceImports: 1,
      setupImports: 1,
      streamImports: 1,
      webSearchImports: 1,
      wslImports: 0,
    });
  });
});
