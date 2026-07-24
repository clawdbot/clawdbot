import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const runtimeMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  enabled: vi.fn(),
}));

vi.mock("../ai-intelligence-runtime.js", () => ({
  executeAiIntelligenceGatewayRequest: runtimeMocks.execute,
  isAiIntelligenceGatewayEnabled: runtimeMocks.enabled,
}));

const { aiIntelligenceHandlers } = await import("./ai-intelligence.js");

function invoke(params: Record<string, unknown>) {
  const respond = vi.fn();
  const warn = vi.fn();
  const handler = aiIntelligenceHandlers["ai.execute"];
  if (!handler) {
    throw new Error("ai.execute handler is missing");
  }
  return {
    respond,
    warn,
    run: () =>
      handler({
        params,
        respond,
        context: { logGateway: { warn } },
      } as unknown as GatewayRequestHandlerOptions),
  };
}

describe("ai.execute gateway method", () => {
  beforeEach(() => {
    runtimeMocks.execute.mockReset();
    runtimeMocks.enabled.mockReset();
    runtimeMocks.enabled.mockReturnValue(true);
  });

  it("fails closed when gateway execution is disabled", async () => {
    runtimeMocks.enabled.mockReturnValue(false);
    const request = invoke({
      componentId: "telegram_ranch_bot",
      prompt: "hello",
    });

    await request.run();

    expect(runtimeMocks.execute).not.toHaveBeenCalled();
    expect(request.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("disabled") }),
    );
  });

  it("rejects invalid requests before launching the bridge", async () => {
    const request = invoke({ componentId: "", prompt: "hello" });

    await request.run();

    expect(runtimeMocks.execute).not.toHaveBeenCalled();
    expect(request.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid ai.execute params" }),
    );
  });

  it("returns a validated execution result", async () => {
    const result = {
      requestId: "gateway-test",
      componentId: "telegram_ranch_bot",
      status: "success",
      content: "hello",
      selectedModelId: "ollama-gemma3-12b",
      attempts: [
        {
          providerName: "ollama",
          modelId: "ollama-gemma3-12b",
          status: "success",
          startedAt: "2026-07-24T00:00:00+00:00",
          finishedAt: "2026-07-24T00:00:01+00:00",
          durationMs: 1,
          errorType: null,
          errorMessage: null,
        },
      ],
    };
    runtimeMocks.execute.mockResolvedValue(result);
    const request = invoke({
      componentId: "telegram_ranch_bot",
      prompt: "hello",
      requestId: "gateway-test",
    });

    await request.run();

    expect(runtimeMocks.execute).toHaveBeenCalledWith({
      componentId: "telegram_ranch_bot",
      prompt: "hello",
      requestId: "gateway-test",
    });
    expect(request.respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it("normalizes bridge failures as unavailable", async () => {
    runtimeMocks.execute.mockRejectedValue(new Error("bridge failed"));
    const request = invoke({
      componentId: "telegram_ranch_bot",
      prompt: "hello",
    });

    await request.run();

    expect(request.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "AI Intelligence execution failed" }),
    );
    expect(request.warn).toHaveBeenCalledWith(expect.stringContaining("bridge failed"));
  });
});
