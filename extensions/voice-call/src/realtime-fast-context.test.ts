import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallRealtimeFastContextConfig } from "./config.js";

const mocks = vi.hoisted(() => ({
  getActiveMemorySearchManager: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: mocks.getActiveMemorySearchManager,
}));

import { resolveRealtimeFastContextConsult } from "./realtime-fast-context.js";

const cfg = {} as OpenClawConfig;

function createFastContextConfig(
  overrides: Partial<VoiceCallRealtimeFastContextConfig> = {},
): VoiceCallRealtimeFastContextConfig {
  return {
    enabled: true,
    timeoutMs: 800,
    maxResults: 3,
    sources: ["memory", "sessions"],
    fallbackToConsult: false,
    ...overrides,
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

describe("resolveRealtimeFastContextConsult", () => {
  beforeEach(() => {
    mocks.getActiveMemorySearchManager.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to the full consult when memory manager setup fails", async () => {
    const logger = createLogger();
    mocks.getActiveMemorySearchManager.mockRejectedValue(new Error("memory misconfigured"));

    await expect(
      resolveRealtimeFastContextConsult({
        cfg,
        agentId: "main",
        sessionKey: "voice:15550001234",
        config: createFastContextConfig({ fallbackToConsult: true }),
        args: { question: "What do you remember?" },
        logger,
      }),
    ).resolves.toEqual({ handled: false });

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("memory misconfigured"));
  });

  it("returns a bounded miss when memory manager setup exceeds the fast context timeout", async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    mocks.getActiveMemorySearchManager.mockReturnValue(new Promise(() => {}));

    const resultPromise = resolveRealtimeFastContextConsult({
      cfg,
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: createFastContextConfig({ fallbackToConsult: false, timeoutMs: 25 }),
      args: { question: "What do you remember?" },
      logger,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({
      handled: true,
      result: {
        text: expect.stringContaining("No relevant OpenClaw memory or session context"),
      },
    });
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("timed out after 25ms"));
  });
});
