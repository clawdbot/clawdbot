import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "../../../test/helpers/agents/pi-ai-stream-simple-mock.js";
import { __testing as extraParamsTesting, applyExtraParamsToAgent } from "./extra-params.js";

vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@earendil-works/pi-ai", () => createPiAiStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: () => undefined,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("createStreamFnWithExtraParams sampling overrides", () => {
  it("forwards temperature, top_p, and maxTokens from override into the underlying streamFn options", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", {
      temperature: 0.4,
      topP: 0.7,
      maxTokens: 512,
    });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      { messages: [], tools: [] } as never,
      undefined,
    );

    expect(underlying).toHaveBeenCalledTimes(1);
    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { temperature?: number; topP?: number; maxTokens?: number } | undefined;
    expect(callOptions?.temperature).toBe(0.4);
    expect(callOptions?.topP).toBe(0.7);
    expect(callOptions?.maxTokens).toBe(512);
  });

  it("lets runtime options override the wrapper sampling defaults", () => {
    const underlying = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // empty stream
      }),
    })) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: underlying };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5.4", { temperature: 0.4, topP: 0.7 });

    if (!agent.streamFn) {
      throw new Error("expected extra params to wrap streamFn");
    }

    void agent.streamFn(
      { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never,
      { messages: [], tools: [] } as never,
      { topP: 0.9 } as never,
    );

    const callOptions = (underlying as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as { temperature?: number; topP?: number } | undefined;
    expect(callOptions?.temperature).toBe(0.4);
    expect(callOptions?.topP).toBe(0.9);
  });
});
