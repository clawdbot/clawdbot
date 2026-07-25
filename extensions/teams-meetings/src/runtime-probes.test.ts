import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTeamsMeetingsConfig } from "./config.js";
import {
  testTeamsMeetingListening,
  testTeamsMeetingSpeech,
  type TeamsMeetingsProbeContext,
} from "./runtime-probes.js";
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
      refreshCaptionHealth: async () => {},
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

  it("requires fresh non-silent loopback capture as well as output bytes", async () => {
    for (const [outputLoopbackSignalBytes, expected] of [
      [0, false],
      [4, true],
    ] as const) {
      const session = {
        agentId: "main",
        chrome: {
          health: {
            inCall: true,
            lastOutputBytes: 4,
            outputGeneration: 1,
            outputLoopbackSignalBytes,
            verifiedOutputGeneration: expected ? 1 : undefined,
          },
        },
        id: `teams-speech-${outputLoopbackSignalBytes}`,
        mode: "agent",
        transport: "chrome",
      } as TeamsMeetingsSession;
      const context = {
        config: resolveTeamsMeetingsConfig({}),
        hasHealthHandle: () => false,
        isReusable: () => false,
        join: vi.fn(async () => ({ session, spoken: true })),
        list: () => [],
        refreshCaptionHealth: async () => {},
        refreshHealth: () => {},
        resolveAgentId: () => "main",
      } satisfies TeamsMeetingsProbeContext;

      const result = await testTeamsMeetingSpeech(context, { mode: "agent", url: URL });

      expect(result.speechOutputVerified).toBe(expected);
    }
  });

  it("bounds a blocked caption refresh by the per-request listening timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = {
      agentId: "main",
      chrome: { health: { inCall: true }, launched: true },
      id: "teams-listen-1",
      mode: "transcribe",
      transport: "chrome",
    } as TeamsMeetingsSession;
    const refreshCaptionHealth = vi.fn(
      (_session: TeamsMeetingsSession, _timeoutMs: number) => new Promise<void>(() => {}),
    );
    const context = {
      config: resolveTeamsMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: false })),
      list: () => [],
      refreshCaptionHealth,
      refreshHealth: () => {},
      resolveAgentId: () => "main",
    } satisfies TeamsMeetingsProbeContext;

    const pending = testTeamsMeetingListening(context, {
      mode: "transcribe",
      timeoutMs: 300,
      url: URL,
    });
    await vi.advanceTimersByTimeAsync(350);
    const result = await pending;

    expect(result.listenTimedOut).toBe(true);
    expect(refreshCaptionHealth).toHaveBeenCalledWith(session, 300);
    expect(Date.now()).toBe(350);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes captions before a short listening timeout expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = {
      agentId: "main",
      chrome: { health: { inCall: true }, launched: true },
      id: "teams-listen-2",
      mode: "transcribe",
      transport: "chrome",
    } as TeamsMeetingsSession;
    const refreshCaptionHealth = vi.fn(
      async (_session: TeamsMeetingsSession, _timeoutMs: number) => {
        session.chrome!.health = {
          ...session.chrome!.health,
          lastCaptionText: "Caption already waiting",
          manualActionRequired: true,
          transcriptLines: 1,
        };
      },
    );
    const context = {
      config: resolveTeamsMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: false })),
      list: () => [],
      refreshCaptionHealth,
      refreshHealth: () => {},
      resolveAgentId: () => "main",
    } satisfies TeamsMeetingsProbeContext;

    const result = await testTeamsMeetingListening(context, {
      mode: "transcribe",
      timeoutMs: 100,
      url: URL,
    });

    expect(result.listenVerified).toBe(true);
    expect(result.manualActionRequired).toBe(true);
    expect(refreshCaptionHealth).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept caption progress that arrives after the listening deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = {
      agentId: "main",
      chrome: { health: { inCall: true }, launched: true },
      id: "teams-listen-late",
      mode: "transcribe",
      transport: "chrome",
    } as TeamsMeetingsSession;
    const context = {
      config: resolveTeamsMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: false })),
      list: () => [],
      refreshCaptionHealth: async (_session: TeamsMeetingsSession, timeoutMs: number) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs + 50);
        });
        session.chrome!.health = {
          ...session.chrome!.health,
          lastCaptionText: "Too late",
          transcriptLines: 1,
        };
      },
      refreshHealth: () => {},
      resolveAgentId: () => "main",
    } satisfies TeamsMeetingsProbeContext;

    const pending = testTeamsMeetingListening(context, {
      mode: "transcribe",
      timeoutMs: 300,
      url: URL,
    });
    await vi.advanceTimersByTimeAsync(400);

    await expect(pending).resolves.toMatchObject({
      listenTimedOut: true,
      listenVerified: false,
    });
  });
});
