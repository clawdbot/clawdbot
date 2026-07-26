// Tests agent runner helper decisions for payload and runtime preparation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hoisted = vi.hoisted(() => {
  const loadSessionEntryMock = vi.fn();
  return { loadSessionEntryMock };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => hoisted.loadSessionEntryMock(...args),
    loadSessionEntryReadOnly: (...args: unknown[]) => hoisted.loadSessionEntryMock(...args),
  };
});

const {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  isAudioPayload,
  signalTypingIfNeeded,
} = await import("./agent-runner-helpers.js");

describe("agent runner helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
    hoisted.loadSessionEntryMock.mockReset();
  });

  it("detects audio payloads from mediaUrl/mediaUrls", () => {
    expect(isAudioPayload({ mediaUrl: "https://example.test/audio.mp3" })).toBe(true);
    expect(isAudioPayload({ mediaUrls: ["https://example.test/video.mp4"] })).toBe(false);
    expect(isAudioPayload({ mediaUrls: ["https://example.test/voice.m4a"] })).toBe(true);
  });

  it("uses fallback verbose level when session context is missing", () => {
    expect(createShouldEmitToolResult({ resolvedVerboseLevel: "off" })()).toBe(false);
    expect(createShouldEmitToolResult({ resolvedVerboseLevel: "on" })()).toBe(true);
    expect(createShouldEmitToolOutput({ resolvedVerboseLevel: "on" })()).toBe(false);
    expect(createShouldEmitToolOutput({ resolvedVerboseLevel: "full" })()).toBe(true);
  });

  it("uses session verbose level when present", () => {
    hoisted.loadSessionEntryMock.mockReturnValue({ verboseLevel: "full" });
    const shouldEmitResult = createShouldEmitToolResult({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });
    const shouldEmitOutput = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });
    expect(shouldEmitResult()).toBe(true);
    expect(shouldEmitOutput()).toBe(true);
    expect(hoisted.loadSessionEntryMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      clone: false,
    });
  });

  it("caches session verbose reads briefly while still refreshing live changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    hoisted.loadSessionEntryMock.mockReturnValue({ verboseLevel: "full" });
    const shouldEmitOutput = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });

    expect(shouldEmitOutput()).toBe(true);
    hoisted.loadSessionEntryMock.mockReturnValue({ verboseLevel: "off" });
    expect(shouldEmitOutput()).toBe(true);
    expect(hoisted.loadSessionEntryMock).toHaveBeenCalledOnce();

    vi.setSystemTime(1_251);
    expect(shouldEmitOutput()).toBe(false);
    expect(hoisted.loadSessionEntryMock).toHaveBeenCalledTimes(2);
  });

  it("falls back when store read fails or session value is invalid", () => {
    hoisted.loadSessionEntryMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const fallbackOn = createShouldEmitToolResult({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "on",
    });
    expect(fallbackOn()).toBe(true);

    hoisted.loadSessionEntryMock.mockClear();
    hoisted.loadSessionEntryMock.mockReturnValue({ verboseLevel: "weird" });
    const fallbackFull = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "full",
    });
    expect(fallbackFull()).toBe(true);
  });

  it("signals typing only when any payload has text or media", async () => {
    const signalRunStart = vi.fn().mockResolvedValue(undefined);
    const typingSignals = { signalRunStart } as unknown as TypingSignaler;
    const emptyPayloads: ReplyPayload[] = [{ text: "   " }, {}];
    await signalTypingIfNeeded(emptyPayloads, typingSignals);
    expect(signalRunStart).not.toHaveBeenCalled();

    await signalTypingIfNeeded([{ mediaUrl: "https://example.test/img.png" }], typingSignals);
    expect(signalRunStart).toHaveBeenCalledOnce();
  });
});
