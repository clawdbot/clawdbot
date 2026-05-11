import {
  clearApiProviders,
  createAssistantMessageEventStream,
  getApiProvider,
  registerBuiltInApiProviders,
  unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCustomApiRegistered, getCustomApiRegistrySourceId } from "./custom-api-registry.js";

function getRegisteredTestProvider() {
  const provider = getApiProvider("test-custom-api");
  if (!provider) {
    throw new Error("expected test-custom-api provider to be registered");
  }
  return provider;
}

describe("ensureCustomApiRegistered", () => {
  afterEach(() => {
    unregisterApiProviders(getCustomApiRegistrySourceId("test-custom-api"));
    clearApiProviders();
    registerBuiltInApiProviders();
  });

  it("registers a custom api provider once", () => {
    const streamFn = vi.fn(() => createAssistantMessageEventStream());

    expect(ensureCustomApiRegistered("test-custom-api", streamFn)).toBe(true);
    expect(ensureCustomApiRegistered("test-custom-api", streamFn)).toBe(false);

    const provider = getRegisteredTestProvider();
    expect(typeof provider.stream).toBe("function");
    expect(typeof provider.streamSimple).toBe("function");
  });

  it("delegates both stream entrypoints to the provided stream function", () => {
    const stream = createAssistantMessageEventStream();
    const streamFn = vi.fn(() => stream);
    ensureCustomApiRegistered("test-custom-api", streamFn);

    const provider = getRegisteredTestProvider();

    const model = { api: "test-custom-api", provider: "custom", id: "m" };
    const context = { messages: [] };
    const options = { maxTokens: 32 };

    expect(provider.stream(model as never, context as never, options as never)).toBe(stream);
    expect(provider.streamSimple(model as never, context as never, options as never)).toBe(stream);
    expect(streamFn).toHaveBeenCalledTimes(2);
  });
});
