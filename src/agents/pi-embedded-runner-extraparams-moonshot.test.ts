import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExtraParamsPayloadCase } from "./pi-embedded-runner-extraparams.test-support.js";
import { __testing as extraParamsTesting } from "./pi-embedded-runner/extra-params.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingKeep,
  resolveMoonshotThinkingType,
} from "./pi-embedded-runner/moonshot-stream-wrappers.js";

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => {
      if (params.provider === "moonshot") {
        const thinkingType = resolveMoonshotThinkingType({
          configuredThinking: params.context.extraParams?.thinking,
          thinkingLevel: params.context.thinkingLevel,
        });
        const thinkingKeep = resolveMoonshotThinkingKeep({
          configuredThinking: params.context.extraParams?.thinking,
        });
        return createMoonshotThinkingWrapper(params.context.streamFn, thinkingType, thinkingKeep);
      }
      return params.context.streamFn;
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent Moonshot", () => {
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

  it("forwards thinking.keep=all to kimi-k2.6 requests", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "low",
      payload: { model: "kimi-k2.6" },
      cfg: {
        agents: {
          defaults: {
            models: {
              "moonshot/kimi-k2.6": {
                params: {
                  thinking: { type: "enabled", keep: "all" },
                },
              },
            },
          },
        },
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled", keep: "all" });
  });

  it("omits thinking.keep on kimi-k2.6 when not configured", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "low",
      payload: { model: "kimi-k2.6" },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
  });

  it("strips thinking.keep for non-k2.6 models even when configured", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      thinkingLevel: "low",
      payload: { model: "kimi-k2.5" },
      cfg: {
        agents: {
          defaults: {
            models: {
              "moonshot/kimi-k2.5": {
                params: {
                  thinking: { type: "enabled", keep: "all" },
                },
              },
            },
          },
        },
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
  });

  it("drops thinking.keep on kimi-k2.6 when thinking is forced off by pinned tool_choice", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "low",
      payload: { model: "kimi-k2.6", tool_choice: { type: "tool", name: "read" } },
      cfg: {
        agents: {
          defaults: {
            models: {
              "moonshot/kimi-k2.6": {
                params: {
                  thinking: { type: "enabled", keep: "all" },
                },
              },
            },
          },
        },
      },
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});
