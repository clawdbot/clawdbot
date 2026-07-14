import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { resolveMinimaxApiCost } from "./model-definitions.js";
import { wrapMinimaxFastModeStream } from "./stream-wrappers.js";

function drive(params: {
  id: string;
  provider?: string;
  api?: string;
  fastMode?: unknown;
  cost?: Model<"anthropic-messages">["cost"];
  initialServiceTier?: unknown;
}): {
  requestId: string;
  cost: Model<"anthropic-messages">["cost"] | undefined;
  payload: Record<string, unknown>;
} {
  let requestId = "";
  let capturedCost: Model<"anthropic-messages">["cost"] | undefined;
  let capturedPayload: Record<string, unknown> = {};
  const capture: StreamFn = (model, _context, options) => {
    requestId = model.id;
    capturedCost = model.cost;
    const payload: Record<string, unknown> =
      params.initialServiceTier === undefined ? {} : { service_tier: params.initialServiceTier };
    options?.onPayload?.(payload, model);
    capturedPayload = payload;
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = wrapMinimaxFastModeStream({
    streamFn: capture,
    extraParams: params.fastMode === undefined ? {} : { fastMode: params.fastMode },
  } as ProviderWrapStreamFnContext);
  void wrapped(
    {
      api: params.api ?? "anthropic-messages",
      provider: params.provider ?? "minimax",
      id: params.id,
      cost: params.cost ?? { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
    } as Model<"anthropic-messages">,
    { messages: [] } as Context,
    {},
  );
  return { requestId, cost: capturedCost, payload: capturedPayload };
}

describe("wrapMinimaxFastModeStream", () => {
  it("routes MiniMax-M2.7 to the highspeed model and its cost in fast mode", () => {
    const { requestId, cost } = drive({
      id: "MiniMax-M2.7",
      fastMode: true,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    });
    expect(requestId).toBe("MiniMax-M2.7-highspeed");
    expect(cost).toEqual(resolveMinimaxApiCost("MiniMax-M2.7-highspeed"));
  });

  it("opts MiniMax-M3 into the priority tier and 1.5x cost in fast mode", () => {
    const { requestId, cost, payload } = drive({ id: "MiniMax-M3", fastMode: true });
    expect(requestId).toBe("MiniMax-M3");
    expect(payload.service_tier).toBe("priority");
    expect(cost?.input).toBeCloseTo(0.9, 10);
    expect(cost?.output).toBeCloseTo(3.6, 10);
    expect(cost?.cacheRead).toBeCloseTo(0.18, 10);
    expect(cost?.cacheWrite).toBe(0);
  });

  it("preserves a service_tier an earlier wrapper already set on MiniMax-M3", () => {
    const { payload } = drive({
      id: "MiniMax-M3",
      fastMode: true,
      initialServiceTier: "standard",
    });
    expect(payload.service_tier).toBe("standard");
  });

  it("leaves MiniMax-M3 untouched when fast mode is off", () => {
    const { payload, cost } = drive({ id: "MiniMax-M3", fastMode: false });
    expect(payload.service_tier).toBeUndefined();
    expect(cost?.input).toBe(0.6);
  });

  it("resolves the /fast function form and string spellings", () => {
    expect(drive({ id: "MiniMax-M2.7", fastMode: () => true }).requestId).toBe(
      "MiniMax-M2.7-highspeed",
    );
    expect(drive({ id: "MiniMax-M2.7", fastMode: "on" }).requestId).toBe("MiniMax-M2.7-highspeed");
  });

  it("leaves models untouched for an unresolved /fast auto setting", () => {
    const { requestId, payload } = drive({ id: "MiniMax-M3", fastMode: "auto" });
    expect(requestId).toBe("MiniMax-M3");
    expect(payload.service_tier).toBeUndefined();
  });

  it("passes non-MiniMax models through unchanged in fast mode", () => {
    const { requestId, payload } = drive({
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      fastMode: true,
    });
    expect(requestId).toBe("gpt-5.4");
    expect(payload.service_tier).toBeUndefined();
  });
});
