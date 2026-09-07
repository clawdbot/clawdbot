// Canonical Responses terminal mapping is shared by the package processor and the agent transport.
import { describe, expect, it } from "vitest";
import {
  mapResponsesTerminalUsage,
  readResponsesReasoningTokens,
  resolveResponsesTerminalStopReason,
} from "./openai-responses-terminal-usage.js";

describe("mapResponsesTerminalUsage", () => {
  it("returns undefined when the terminal event carries no usage", () => {
    expect(mapResponsesTerminalUsage(undefined)).toBeUndefined();
  });

  it("splits cache reads and writes out of the billable input bucket", () => {
    expect(
      mapResponsesTerminalUsage({
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
      }),
    ).toEqual({
      input: 50,
      output: 10,
      cacheRead: 20,
      cacheWrite: 30,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 110 },
      totalTokens: 110,
    });
  });

  it("derives totalTokens from the buckets when the payload omits it", () => {
    expect(mapResponsesTerminalUsage({ input_tokens: 30, output_tokens: 12 })).toEqual({
      input: 30,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      contextUsage: { state: "available", promptTokens: 30, totalTokens: 42 },
      totalTokens: 42,
    });
  });

  it("keeps totalTokens at the bucket sum when clamping outgrows the reported total", () => {
    // cached_tokens exceeding input_tokens clamps input to 0, so the reported total understates it.
    expect(
      mapResponsesTerminalUsage({
        input_tokens: 2,
        output_tokens: 5,
        total_tokens: 7,
        input_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({
      input: 0,
      output: 5,
      cacheRead: 4,
      cacheWrite: 0,
      contextUsage: { state: "unavailable" },
      totalTokens: 9,
    });
  });

  it.each([0, 29])("rejects an output-absent context snapshot whose total is %i", (totalTokens) => {
    expect(
      mapResponsesTerminalUsage({ input_tokens: 30, total_tokens: totalTokens })?.contextUsage,
    ).toEqual({ state: "unavailable" });
  });

  it("accepts an output-absent context snapshot whose total covers its input", () => {
    expect(mapResponsesTerminalUsage({ input_tokens: 30, total_tokens: 30 })?.contextUsage).toEqual(
      { state: "available", promptTokens: 30, totalTokens: 30 },
    );
  });
});

describe("readResponsesReasoningTokens", () => {
  it("reads a zero reasoning count as reported rather than missing", () => {
    expect(readResponsesReasoningTokens({ output_tokens_details: { reasoning_tokens: 0 } })).toBe(
      0,
    );
  });

  it("returns undefined when the provider omits reasoning details", () => {
    expect(readResponsesReasoningTokens({ output_tokens: 3 })).toBeUndefined();
  });
});

describe("resolveResponsesTerminalStopReason", () => {
  it("maps an incomplete turn to a length stop", () => {
    expect(
      resolveResponsesTerminalStopReason({ status: "incomplete", hasToolCall: false }),
    ).toEqual({ stopReason: "length" });
  });

  it("uses the terminal incomplete event when a compatible response omits its status", () => {
    expect(
      resolveResponsesTerminalStopReason({
        status: undefined,
        terminalEventType: "response.incomplete",
        hasToolCall: false,
      }),
    ).toEqual({ stopReason: "length" });
  });

  it("keeps an explicit response status authoritative over the terminal event", () => {
    expect(
      resolveResponsesTerminalStopReason({
        status: "completed",
        terminalEventType: "response.incomplete",
        hasToolCall: false,
      }),
    ).toEqual({ stopReason: "stop" });
  });

  it("reports a content-filtered turn as a provider error", () => {
    expect(
      resolveResponsesTerminalStopReason({
        status: "incomplete",
        incompleteReason: "content_filter",
        hasToolCall: false,
      }),
    ).toEqual({
      stopReason: "error",
      errorMessage: "Provider incomplete_reason: content_filter",
    });
  });

  it("does not expose filtered output when an incomplete response omits its status", () => {
    expect(
      resolveResponsesTerminalStopReason({
        status: undefined,
        terminalEventType: "response.incomplete",
        incompleteReason: "content_filter",
        hasToolCall: false,
      }),
    ).toEqual({
      stopReason: "error",
      errorMessage: "Provider incomplete_reason: content_filter",
    });
  });

  it("upgrades a completed turn carrying tool calls to toolUse", () => {
    expect(resolveResponsesTerminalStopReason({ status: "completed", hasToolCall: true })).toEqual({
      stopReason: "toolUse",
    });
  });

  it("leaves a truncated tool-calling turn as a length stop", () => {
    expect(resolveResponsesTerminalStopReason({ status: "incomplete", hasToolCall: true })).toEqual(
      {
        stopReason: "length",
      },
    );
  });
});
