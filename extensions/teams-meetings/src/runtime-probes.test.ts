import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTeamsMeetingsConfig } from "./config.js";
import { testTeamsMeetingSpeech, type TeamsMeetingsProbeContext } from "./runtime-probes.js";
import type { TeamsMeetingsSession } from "./transports/types.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_probe%40thread.v2/0";

afterEach(() => {
  vi.useRealTimers();
});

describe("Microsoft Teams meeting runtime probes", () => {
  it("uses the per-request speech verification timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = {
      agentId: "main",
      chrome: { health: { inCall: true, lastOutputBytes: 0 } },
      id: "teams-1",
      mode: "agent",
      transport: "chrome",
    } as TeamsMeetingsSession;
    const refreshHealth = vi.fn();
    const context = {
      config: resolveTeamsMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: true })),
      list: () => [],
      refreshHealth,
      resolveAgentId: () => "main",
    } satisfies TeamsMeetingsProbeContext;

    const pending = testTeamsMeetingSpeech(context, {
      mode: "agent",
      timeoutMs: 150,
      url: URL,
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(result.speechOutputTimedOut).toBe(true);
    expect(refreshHealth).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(200);
  });
});
