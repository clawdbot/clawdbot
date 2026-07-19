import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveZoomMeetingsConfig } from "./config.js";
import {
  testZoomMeetingListening,
  testZoomMeetingSpeech,
  type ZoomMeetingsProbeContext,
} from "./runtime-probes.js";
import type { ZoomMeetingsSession } from "./transports/types.js";

const URL = "https://zoom.us/j/12345678902?pwd=probe";

afterEach(() => {
  vi.useRealTimers();
});

describe("Zoom meeting runtime probes", () => {
  it("uses the per-request speech verification timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = {
      agentId: "main",
      chrome: { health: { inCall: true, lastOutputBytes: 0 } },
      id: "zoom-1",
      mode: "agent",
      transport: "chrome",
    } as ZoomMeetingsSession;
    const refreshHealth = vi.fn();
    const context = {
      config: resolveZoomMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: true })),
      list: () => [],
      refreshCaptionHealth: async () => {},
      refreshHealth,
      resolveAgentId: () => "main",
    } satisfies ZoomMeetingsProbeContext;

    const pending = testZoomMeetingSpeech(context, {
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

  it("bounds a blocked caption refresh by the per-request listening timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = {
      agentId: "main",
      chrome: {
        browserTab: { openedByPlugin: false, targetId: "manual-zoom-tab" },
        health: { inCall: true },
        launched: false,
      },
      id: "zoom-listen-1",
      mode: "transcribe",
      transport: "chrome",
    } as ZoomMeetingsSession;
    const refreshCaptionHealth = vi.fn(
      (_session: ZoomMeetingsSession, _timeoutMs: number) => new Promise<void>(() => {}),
    );
    const context = {
      config: resolveZoomMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: false })),
      list: () => [],
      refreshCaptionHealth,
      refreshHealth: () => {},
      resolveAgentId: () => "main",
    } satisfies ZoomMeetingsProbeContext;

    const pending = testZoomMeetingListening(context, {
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
      chrome: {
        browserTab: { openedByPlugin: false, targetId: "manual-zoom-tab" },
        health: { inCall: true },
        launched: false,
      },
      id: "zoom-listen-2",
      mode: "transcribe",
      transport: "chrome",
    } as ZoomMeetingsSession;
    const refreshCaptionHealth = vi.fn(
      async (_session: ZoomMeetingsSession, _timeoutMs: number) => {
        session.chrome!.health = {
          ...session.chrome!.health,
          lastCaptionText: "Caption already waiting",
          manualActionRequired: true,
          transcriptLines: 1,
        };
      },
    );
    const context = {
      config: resolveZoomMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: false })),
      list: () => [],
      refreshCaptionHealth,
      refreshHealth: () => {},
      resolveAgentId: () => "main",
    } satisfies ZoomMeetingsProbeContext;

    const result = await testZoomMeetingListening(context, {
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
      chrome: {
        browserTab: { openedByPlugin: true, targetId: "zoom-tab" },
        health: { inCall: true },
        launched: true,
      },
      id: "zoom-listen-late",
      mode: "transcribe",
      transport: "chrome",
    } as ZoomMeetingsSession;
    const context = {
      config: resolveZoomMeetingsConfig({ chrome: { joinTimeoutMs: 30_000 } }),
      hasHealthHandle: () => true,
      isReusable: () => false,
      join: vi.fn(async () => ({ session, spoken: false })),
      list: () => [],
      refreshCaptionHealth: async (_session: ZoomMeetingsSession, timeoutMs: number) => {
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
    } satisfies ZoomMeetingsProbeContext;

    const pending = testZoomMeetingListening(context, {
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
