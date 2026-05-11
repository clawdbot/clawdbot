import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallRealtimeFastContextConfig } from "./config.js";

const mocks = vi.hoisted(() => ({
  resolveRealtimeVoiceFastContextConsult: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  resolveRealtimeVoiceFastContextConsult: mocks.resolveRealtimeVoiceFastContextConsult,
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
    mocks.resolveRealtimeVoiceFastContextConsult.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes voice-call labels into the SDK fast context resolver", async () => {
    const logger = createLogger();
    mocks.resolveRealtimeVoiceFastContextConsult.mockResolvedValue({ handled: false });

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

    expect(mocks.resolveRealtimeVoiceFastContextConsult).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: createFastContextConfig({ fallbackToConsult: true }),
      args: { question: "What do you remember?" },
      logger,
      labels: {
        audienceLabel: "caller",
        contextName: "OpenClaw memory or session context",
      },
    });
  });
});
