import { describe, expect, it, vi } from "vitest";

import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler, resolveTypingMode } from "./typing-mode.js";

describe("resolveTypingMode", () => {
  it("defaults to instant for direct chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("defaults to message for group chats without mentions", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("defaults to instant for mentioned group chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("honors configured mode across contexts", () => {
    expect(
      resolveTypingMode({
        configured: "thinking",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("thinking");
    expect(
      resolveTypingMode({
        configured: "message",
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("forces never for heartbeat runs", () => {
    expect(
      resolveTypingMode({
        configured: "instant",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: true,
      }),
    ).toBe("never");
  });
});

describe("createTypingSignaler", () => {
  it("signals immediately for instant mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "instant",
      isHeartbeat: false,
    });

    await signaler.signalRunStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("signals on text for message mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hello");

    expect(typing.startTypingOnText).toHaveBeenCalledWith("hello");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("signals on message start for message mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalMessageStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("signals on reasoning for thinking mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "thinking",
      isHeartbeat: false,
    });

    await signaler.signalReasoningDelta();

    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("refreshes ttl on text for thinking mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "thinking",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hi");

    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing on tool start when inactive", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalToolStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.refreshTypingTtl).toHaveBeenCalled();
  });

  it("refreshes ttl on tool start when active", async () => {
    const typing = createMockTypingController({
      isActive: vi.fn(() => true),
    });
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalToolStart();

    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("suppresses typing when disabled", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "instant",
      isHeartbeat: true,
    });

    await signaler.signalRunStart();
    await signaler.signalTextDelta("hi");
    await signaler.signalReasoningDelta();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
});
