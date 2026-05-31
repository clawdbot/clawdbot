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
});
