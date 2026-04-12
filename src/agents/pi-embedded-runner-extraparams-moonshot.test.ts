import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExtraParamsPayloadCase } from "./pi-embedded-runner-extraparams.test-support.js";
import { __testing as extraParamsTesting } from "./pi-embedded-runner/extra-params.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "./pi-embedded-runner/moonshot-stream-wrappers.js";

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    wrapProviderStreamFn: (params) => {
      if (params.provider === "moonshot") {
        const thinkingType = resolveMoonshotThinkingType({
          configuredThinking: params.context.extraParams?.thinking,
          thinkingLevel: params.context.thinkingLevel,
        });
        return createMoonshotThinkingWrapper(params.context.streamFn, thinkingType);
      }
      if (params.provider === "ollama") {
        const modelId = params.context.model?.id ?? params.context.modelId;
        if (typeof modelId === "string" && /^kimi-k2\.5(?::|$)/i.test(modelId)) {
          const thinkingType = resolveMoonshotThinkingType({
            configuredThinking: params.context.extraParams?.thinking,
            thinkingLevel: params.context.thinkingLevel,
          });
          return createMoonshotThinkingWrapper(params.context.streamFn, thinkingType);
        }
        return params.context.streamFn;
      }
      return params.context.streamFn;
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent Moonshot and Ollama Kimi", () => {
  it("maps thinkingLevel=off to Moonshot thinking.type=disabled", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      thinkingLevel: "off",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("maps non-off thinking levels to Moonshot thinking.type=enabled and normalizes tool_choice", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      thinkingLevel: "low",
      payload: { tool_choice: "required" },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.tool_choice).toBe("auto");
  });

  it("disables thinking instead of broadening pinned Moonshot tool_choice", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      thinkingLevel: "low",
      payload: { tool_choice: { type: "tool", name: "read" } },
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.tool_choice).toEqual({ type: "tool", name: "read" });
  });

  it("respects explicit Moonshot thinking param from model config", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      thinkingLevel: "high",
      cfg: {
        agents: {
          defaults: {
            models: {
              "moonshot/kimi-k2.5": {
                params: {
                  thinking: { type: "disabled" },
                },
              },
            },
          },
        },
      },
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("applies Moonshot payload compatibility to Ollama Kimi cloud models", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "ollama",
      modelId: "kimi-k2.5:cloud",
      thinkingLevel: "low",
      payload: { tool_choice: "required" },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.tool_choice).toBe("auto");
  });

  it("maps thinkingLevel=off for Ollama Kimi cloud models through Moonshot compatibility", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "ollama",
      modelId: "kimi-k2.5:cloud",
      thinkingLevel: "off",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("disables thinking instead of broadening pinned Ollama Kimi cloud tool_choice", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "ollama",
      modelId: "kimi-k2.5:cloud",
      thinkingLevel: "low",
      payload: { tool_choice: { type: "function", function: { name: "read" } } },
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "read" },
    });
  });
});
