// Deferred event buffer tests cover buffered event dispatch with flush/discard.
import { describe, expect, it, vi } from "vitest";
import { createDeferredEventBuffer } from "./deferred-event-buffer.js";

describe("createDeferredEventBuffer", () => {
  it("buffers events on push and delivers on flush", () => {
    const sink = { push: vi.fn() };
    const buffer = createDeferredEventBuffer(sink);
    buffer.push("a");
    buffer.push("b");
    expect(sink.push).not.toHaveBeenCalled();
    buffer.flush();
    expect(sink.push).toHaveBeenCalledTimes(2);
    expect(sink.push).toHaveBeenNthCalledWith(1, "a");
    expect(sink.push).toHaveBeenNthCalledWith(2, "b");
  });

  it("discards buffered events without delivering to sink", () => {
    const sink = { push: vi.fn() };
    const buffer = createDeferredEventBuffer(sink);
    buffer.push("a");
    buffer.discard();
    buffer.flush();
    expect(sink.push).not.toHaveBeenCalled();
  });

  it("calls onBufferedEvent callback on each push", () => {
    const onEvent = vi.fn();
    const buffer = createDeferredEventBuffer({ push() {} }, onEvent);
    buffer.push("a");
    buffer.push("b");
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("does not throw when onBufferedEvent is not provided", () => {
    const buffer = createDeferredEventBuffer({ push() {} });
    expect(() => buffer.push("a")).not.toThrow();
  });

  it("allows push after flush to start a new buffer", () => {
    const sink = { push: vi.fn() };
    const buffer = createDeferredEventBuffer(sink);
    buffer.push("a");
    buffer.flush();
    expect(sink.push).toHaveBeenCalledTimes(1);
    buffer.push("b");
    buffer.flush();
    expect(sink.push).toHaveBeenCalledTimes(2);
  });

  it("allows push after discard to start fresh", () => {
    const sink = { push: vi.fn() };
    const buffer = createDeferredEventBuffer(sink);
    buffer.push("a");
    buffer.discard();
    buffer.push("b");
    buffer.flush();
    expect(sink.push).toHaveBeenCalledTimes(1);
    expect(sink.push).toHaveBeenCalledWith("b");
  });
});
