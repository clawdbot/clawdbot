// LLM Runtime tests cover api registry behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiRegistry,
  createAssistantMessageEventStream,
  createLlmRuntime,
  type Model,
} from "./index.js";
import {
  defaultApiRegistry,
  getApiProvider,
  streamSimple as streamSimpleDefault,
} from "./internal/default-runtime.js";

const TEST_SOURCE_ID = "test:llm-runtime-api-registry";
const emptyStream = () => createAssistantMessageEventStream();

const model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model;

describe("LLM API registry", () => {
  afterEach(() => {
    defaultApiRegistry.unregisterApiProviders(TEST_SOURCE_ID);
  });

  it("rejects mismatched model API calls", () => {
    const registry = createApiRegistry();
    registry.registerApiProvider(
      {
        api: "test-api",
        stream: emptyStream,
        streamSimple: emptyStream,
      },
      TEST_SOURCE_ID,
    );

    const provider = registry.getApiProvider("test-api");
    expect(provider).toBeDefined();
    expect(() => provider?.streamSimple({ ...model, api: "other-api" }, { messages: [] })).toThrow(
      "Mismatched api: other-api expected test-api",
    );
  });

  it("isolates providers between runtime instances", () => {
    const first = createLlmRuntime();
    const second = createLlmRuntime();
    const streamSimple = vi.fn(() => createAssistantMessageEventStream());
    first.registry.registerApiProvider({ api: "test-api", stream: streamSimple, streamSimple });

    first.streamSimple(model, { messages: [] });

    expect(streamSimple).toHaveBeenCalledOnce();
    expect(() => second.streamSimple(model, { messages: [] })).toThrow(
      "No API provider registered for api: test-api",
    );
  });

  it("shares default runtime registrations across duplicated module instances", async () => {
    // File URLs preserve the cache-busting query through Vitest project shards.
    // Computed relative imports can escape into unresolved Vite /@fs paths.
    const duplicateRuntime = (await import(
      /* @vite-ignore */ new URL("./internal/default-runtime.ts?duplicate-runtime", import.meta.url)
        .href
    )) as typeof import("./internal/default-runtime.js");
    const streamSimple = vi.fn(emptyStream);
    duplicateRuntime.defaultApiRegistry.registerApiProvider(
      {
        api: "test-api",
        stream: emptyStream,
        streamSimple,
      },
      TEST_SOURCE_ID,
    );

    expect(getApiProvider("test-api")).toBeDefined();

    streamSimpleDefault(model, { messages: [] });

    expect(streamSimple).toHaveBeenCalledOnce();
  });

  it("unregisters every provider owned by one source", () => {
    const registry = createApiRegistry();
    for (const api of ["test-api", "test-api-2"] as const) {
      registry.registerApiProvider(
        {
          api,
          stream: emptyStream,
          streamSimple: emptyStream,
        },
        TEST_SOURCE_ID,
      );
    }

    registry.unregisterApiProviders(TEST_SOURCE_ID);

    expect(registry.getApiProviders()).toEqual([]);
  });
});
