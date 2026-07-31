// Fast context runtime tests cover timeout and fast context generation behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveMemorySearchManager: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: mocks.getActiveMemorySearchManager,
}));

import { resolveRealtimeVoiceFastContextConsult } from "./fast-context-runtime.js";

describe("resolveRealtimeVoiceFastContextConsult", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mocks.getActiveMemorySearchManager.mockReset();
  });

  it("caps oversized fast-context timeouts before scheduling Node timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(
      resolveRealtimeVoiceFastContextConsult({
        cfg: {},
        agentId: "main",
        sessionKey: "voice:15550001234",
        config: {
          enabled: true,
          timeoutMs: Number.MAX_SAFE_INTEGER,
          maxResults: 3,
          sources: ["memory", "sessions"],
          fallbackToConsult: true,
        },
        args: { question: "What do you remember?" },
        logger: {},
      }),
    ).resolves.toEqual({ handled: false });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("preserves the fast-context timeout error and clears the timer", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn() };
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        search: vi.fn(() => new Promise<never>(() => {})),
      },
    });

    const result = resolveRealtimeVoiceFastContextConsult({
      cfg: {},
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: {
        enabled: true,
        timeoutMs: 25,
        maxResults: 3,
        sources: ["memory", "sessions"],
        fallbackToConsult: true,
      },
      args: { question: "What do you remember?" },
      logger,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({ handled: false });
    expect(logger.debug).toHaveBeenCalledWith(
      "[talk] fast context lookup failed: fast context lookup timed out after 25ms",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not split a surrogate pair at the fast-context snippet limit", async () => {
    const safePrefix = "x".repeat(698);
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([
          {
            path: "memory/test.md",
            startLine: 1,
            endLine: 1,
            snippet: `${safePrefix}🚀tail`,
            source: "memory",
            score: 1,
          },
        ]),
      },
    });

    const result = await resolveRealtimeVoiceFastContextConsult({
      cfg: {},
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: {
        enabled: true,
        timeoutMs: 1_000,
        maxResults: 1,
        sources: ["memory"],
        fallbackToConsult: true,
      },
      args: { question: "What do you remember?" },
      logger: {},
    });

    expect(result).toEqual({
      handled: true,
      result: {
        text: expect.stringContaining(`1. [memory] memory/test.md:1-1\n${safePrefix}...`),
      },
    });
  });
});
