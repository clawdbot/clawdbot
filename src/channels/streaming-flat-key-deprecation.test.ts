// Covers the once-per-process deprecation warning for flat streaming key fallbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFlatStreamingKeyDeprecationWarningsForTest } from "./streaming-flat-key-deprecation.js";
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingPreviewChunk,
} from "./streaming.js";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => loggerMocks),
}));

describe("flat streaming key deprecation warning", () => {
  beforeEach(() => {
    resetFlatStreamingKeyDeprecationWarningsForTest();
    loggerMocks.warn.mockClear();
  });

  afterEach(() => {
    resetFlatStreamingKeyDeprecationWarningsForTest();
  });

  it("warns once per key when the flat fallback is actually used", () => {
    expect(resolveChannelStreamingChunkMode({ chunkMode: "newline" })).toBe("newline");
    expect(resolveChannelStreamingChunkMode({ chunkMode: "newline" })).toBe("newline");
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain('"chunkMode"');
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("streaming.chunkMode");

    expect(resolveChannelStreamingBlockEnabled({ blockStreaming: true })).toBe(true);
    expect(resolveChannelStreamingBlockCoalesce({ blockStreamingCoalesce: { idleMs: 5 } })).toEqual(
      { idleMs: 5 },
    );
    expect(resolveChannelStreamingPreviewChunk({ draftChunk: { minChars: 10 } })).toEqual({
      minChars: 10,
    });
    expect(loggerMocks.warn).toHaveBeenCalledTimes(4);
  });

  it("stays silent when nested config wins or no flat key is set", () => {
    expect(
      resolveChannelStreamingChunkMode({
        streaming: { chunkMode: "length" },
        chunkMode: "newline",
      }),
    ).toBe("length");
    expect(resolveChannelStreamingBlockEnabled({ streaming: { block: { enabled: false } } })).toBe(
      false,
    );
    expect(resolveChannelStreamingBlockCoalesce({})).toBeUndefined();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it.each([
    { scalar: "block", expected: "block" },
    { scalar: true, expected: "partial" },
  ])("warns once when the scalar streaming fallback is used", ({ scalar, expected }) => {
    expect(resolveChannelPreviewStreamMode({ streaming: scalar }, "off")).toBe(expected);
    expect(resolveChannelPreviewStreamMode({ streaming: scalar }, "off")).toBe(expected);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain('"streaming"');
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("streaming.mode");
  });
});
