import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { createMinimaxFastModeWrapper, createMinimaxThinkingDisabledWrapper } from "./minimax.js";

function captureThinkingPayload(params: {
  provider: string;
  api: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): unknown {
  let capturedThinking: unknown = undefined;
  const baseStreamFn: StreamFn = (model, context, options) => {
    const payload: Record<string, unknown> = {};
    options?.onPayload?.(payload, model);
    capturedThinking = payload.thinking;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, params.thinkingLevel);
  void wrapped(
    {
      api: params.api,
      provider: params.provider,
      id: params.modelId,
    } as Model<"anthropic-messages">,
    { messages: [] } as Context,
    {},
  );

  return capturedThinking;
}

describe("createMinimaxThinkingDisabledWrapper", () => {
  it("disables thinking for minimax anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("disables thinking for minimax-portal anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax-portal",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("does not affect non-minimax providers", () => {
    expect(
      captureThinkingPayload({
        provider: "anthropic",
        api: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });

  it("does not affect minimax with non-anthropic-messages api", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "openai-completions",
        modelId: "MiniMax-M2.7",
      }),
    ).toBeUndefined();
  });

  it("does NOT disable thinking for MiniMax-M3 on anthropic-messages", () => {
    // M3 emits Anthropic-shape thinking blocks and returns empty content
    // when thinking is disabled; see isMinimaxModelRequiringThinking.
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "anthropic-messages",
        modelId: "MiniMax-M3",
      }),
    ).toBeUndefined();
  });

  it("does NOT disable thinking for MiniMax-M3 on minimax-portal", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax-portal",
        api: "anthropic-messages",
        modelId: "MiniMax-M3",
      }),
    ).toBeUndefined();
  });

  it("removes implicit disabled thinking for MiniMax-M3", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "disabled" },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toBeUndefined();
  });

  it("preserves explicit off thinking for MiniMax-M3", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "disabled" },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, "off");
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "disabled" });
  });

  it("rewrites MiniMax-M3 default budget thinking to adaptive", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, "adaptive");
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "adaptive" });
  });

  it("restores explicit MiniMax-M3 maxTokens when rewriting budget thinking", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        max_tokens: 8692,
        thinking: { type: "enabled", budget_tokens: 8192 },
      };
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, "adaptive");
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      { maxTokens: 500 },
    );

    expect(capturedPayload).toMatchObject({
      max_tokens: 500,
      thinking: { type: "adaptive" },
    });
  });

  it("preserves explicit enabled thinking for MiniMax-M3", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "disabled" },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {
        onPayload: (payload) => {
          (payload as Record<string, unknown>).thinking = {
            type: "enabled",
            budget_tokens: 1024,
          };
        },
      },
    );

    expect(capturedThinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("preserves an already-set thinking value", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
});

describe("createMinimaxFastModeWrapper", () => {
  it("rewrites MiniMax-M2.7 to highspeed variant in fast mode", () => {
    let capturedId = "";
    const baseStreamFn: StreamFn = (model) => {
      capturedId = model.id;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, true);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedId).toBe("MiniMax-M2.7-highspeed");
  });
});
