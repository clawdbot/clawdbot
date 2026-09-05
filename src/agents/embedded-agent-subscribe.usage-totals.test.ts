import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

describe("subscribeEmbeddedAgentSession run usage totals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports cumulative usage totals at each usage commit", () => {
    const onRunUsageTotals = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-usage-totals",
      onRunUsageTotals,
    });

    const assistant = (text: string, inputTokens: number, outputTokens: number) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      provider: "test-provider",
      model: "test-model",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });

    emit({ type: "message_end", message: assistant("first", 100, 20) });
    emit({ type: "message_start", message: assistant("second", 0, 0) });
    emit({ type: "message_end", message: assistant("second", 50, 30) });

    expect(onRunUsageTotals).toHaveBeenCalledTimes(2);
    const totals = onRunUsageTotals.mock.calls.map(([usage]) => usage);
    expect(totals[0]).toMatchObject({ input: 100, output: 20, total: 120 });
    expect(totals[1]).toMatchObject({ input: 150, output: 50, total: 200 });
  });

  it("is not invoked when the caller passes no usage-totals callback", () => {
    const { emit } = createSubscribedSessionHarness({ runId: "run-usage-quiet" });
    expect(() =>
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          stopReason: "stop",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ).not.toThrow();
  });
});
