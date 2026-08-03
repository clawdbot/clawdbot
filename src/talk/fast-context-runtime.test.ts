// Fast context runtime tests cover timeout and fast context generation behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeActiveMemorySearchHits: vi.fn(),
  getActiveMemorySearchManager: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  authorizeActiveMemorySearchHits: mocks.authorizeActiveMemorySearchHits,
  getActiveMemorySearchManager: mocks.getActiveMemorySearchManager,
}));

import { resolveRealtimeVoiceFastContextConsult } from "./fast-context-runtime.js";

describe("resolveRealtimeVoiceFastContextConsult", () => {
  beforeEach(() => {
    mocks.authorizeActiveMemorySearchHits.mockReset().mockImplementation(async ({ hits }) => hits);
    mocks.getActiveMemorySearchManager.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("removes unauthorized session hits before building caller context", async () => {
    const cfg = {};
    const hits = [
      {
        path: "memory/allowed.md",
        startLine: 1,
        endLine: 1,
        snippet: "Visible memory",
        source: "memory" as const,
        score: 1,
      },
      {
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        snippet: "Private session secret",
        source: "sessions" as const,
        score: 1,
      },
    ];
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: { search: vi.fn().mockResolvedValue(hits) },
    });
    mocks.authorizeActiveMemorySearchHits.mockResolvedValue([hits[0]]);

    const result = await resolveRealtimeVoiceFastContextConsult({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:voice:15550001234",
      config: {
        enabled: true,
        timeoutMs: 1_000,
        maxResults: 2,
        sources: ["memory", "sessions"],
        fallbackToConsult: false,
      },
      args: { question: "What do you remember?" },
      logger: {},
    });

    expect(mocks.authorizeActiveMemorySearchHits).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      requesterSessionKey: "agent:main:voice:15550001234",
      sandboxed: false,
      hits,
    });
    expect(result).toEqual({
      handled: true,
      result: { text: expect.stringContaining("Visible memory") },
    });
    expect(result.handled && result.result.text).not.toContain("Private session secret");
  });
});
