import { describe, expect, it } from "vitest";
import { resolveMaxRunRetryIterations } from "./helpers.js";
import { handleRetryLimitExhaustion } from "./retry-limit.js";

function handleRetryLimit(replayInvalid = false) {
  return handleRetryLimitExhaustion({
    message: "Exceeded retry limit after 32 attempts (max=32).",
    decision: { action: "return_error_payload" },
    provider: "anthropic",
    model: "test-model",
    durationMs: 1,
    agentMeta: {
      sessionId: "session-1",
      provider: "anthropic",
      model: "test-model",
    },
    replayInvalid: replayInvalid || undefined,
    livenessState: "blocked",
  });
}

describe("embedded run retry limit", () => {
  it("keeps the zero-profile retry budget bounded at 32 attempts", () => {
    expect(resolveMaxRunRetryIterations(0)).toBe(32);
  });

  it("returns a visible blocked retry-limit payload", () => {
    const result = handleRetryLimit();

    expect(result.payloads).toEqual([
      {
        text: expect.stringContaining("repeated internal retries"),
        isError: true,
      },
    ]);
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.livenessState).toBe("blocked");
  });

  it("preserves replay invalidation when retry exhaustion follows side effects", () => {
    const result = handleRetryLimit(true);

    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.livenessState).toBe("blocked");
  });
});
