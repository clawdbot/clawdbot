// Covers Moonshot-specific extra-params thinking payload behavior.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingKeep,
  resolveMoonshotThinkingType,
} from "../llm/providers/stream-wrappers/moonshot-thinking.js";
import { runExtraParamsPayloadCase } from "./embedded-agent-runner-extraparams.test-support.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.js";

beforeEach(() => {
  // Moonshot thinking support lives in its provider wrapper, wired through the
  // generic extra-params provider-runtime seam here.
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
    // A pinned tool choice is stricter than thinking. Disable thinking instead
    // of changing the user's requested tool routing.
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
    // thinking.keep is only supported by kimi-k2.6, so this verifies the
    // positive allowlist before the negative cases below.
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
  it("omits thinking controls and broadens pinned tool choice for kimi-k2.7-code", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.7-code",
      thinkingLevel: "off",
      payload: {
        model: "kimi-k2.7-code",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      },
      cfg: {
        agents: {
          defaults: {
            models: {
              "moonshot/kimi-k2.7-code": {
                params: {
                  thinking: { type: "disabled", keep: "all" },
                  extra_body: {
                    thinking: { type: "disabled", keep: "all" },
                    reasoning_effort: "low",
                    tool_choice: { type: "tool", name: "read" },
                    temperature: 0,
                    top_p: 0.5,
                    n: 2,
                    presence_penalty: 1,
                    frequency_penalty: 1,
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload.tool_choice).toBe("auto");
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
    expect(payload).not.toHaveProperty("n");
    expect(payload).not.toHaveProperty("presence_penalty");
    expect(payload).not.toHaveProperty("frequency_penalty");
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(expectDefined(messages[0], "messages[0] test invariant").reasoning_content).toBe("");
  });

  it("repairs only missing assistant tool-call reasoning_content when thinking is enabled", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "low",
      payload: {
        model: "kimi-k2.6",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          {
            role: "assistant",
            reasoning_content: "native reasoning",
            tool_calls: [
              { id: "call_2", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          { role: "assistant", content: "done" },
          { role: "tool", tool_call_id: "call_1", content: "file contents" },
        ],
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(expectDefined(messages[1], "messages[1] test invariant").reasoning_content).toBe("");
    expect(expectDefined(messages[2], "messages[2] test invariant").reasoning_content).toBe(
      "native reasoning",
    );
    expect(messages[3]).not.toHaveProperty("reasoning_content");
  });

  it("does not backfill reasoning_content when thinking is disabled", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      thinkingLevel: "off",
      payload: {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      },
    });

    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(
      expectDefined(messages[0], "messages[0] test invariant").reasoning_content,
    ).toBeUndefined();
  });
});
