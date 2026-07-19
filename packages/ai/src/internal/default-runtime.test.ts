import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiRegistry } from "../api-registry.js";
import { createLlmRuntime } from "../stream.js";

const DEFAULT_RUNTIME_KEY = Symbol.for("openclaw.ai.defaultRuntime");
const globalStore = globalThis as Record<PropertyKey, unknown>;
const originalDefaultRuntime = globalStore[DEFAULT_RUNTIME_KEY];

afterEach(() => {
  if (originalDefaultRuntime === undefined) {
    delete globalStore[DEFAULT_RUNTIME_KEY];
  } else {
    globalStore[DEFAULT_RUNTIME_KEY] = originalDefaultRuntime;
  }
  vi.resetModules();
});

describe("default LLM runtime compatibility state", () => {
  it("keeps opaque legacy registrations out of lifecycle publications", async () => {
    const registry = createApiRegistry();
    const stream = () => ({}) as never;
    registry.registerApiProvider(
      { api: "test-legacy-plugin", stream, streamSimple: stream },
      "plugin:test-legacy",
    );
    globalStore[DEFAULT_RUNTIME_KEY] = {
      registry,
      runtime: createLlmRuntime(registry),
    };
    vi.resetModules();

    const runtime = await import("./default-runtime.js");

    expect(runtime.defaultApiRegistry).toBe(registry);
    expect(runtime.getPublishedApiProviders()).toEqual([]);

    runtime.registerApiProvider(
      { api: "test-current-plugin", stream, streamSimple: stream },
      "plugin:test-current",
    );

    expect(runtime.getApiProvider("test-legacy-plugin")).toBeDefined();
    expect(runtime.getPublishedApiProviders().map((provider) => provider.api)).toEqual([
      "test-current-plugin",
    ]);
  });
});
