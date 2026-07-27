// Google Meet tests cover the speech probe deadline the platform adapter delegates back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { testGoogleMeetSpeech, type GoogleMeetRuntimeProbeContext } from "./runtime-probes.js";
import type { GoogleMeetSession } from "./transports/types.js";

afterEach(() => {
  vi.useRealTimers();
});

function neverVerifyingContext(): GoogleMeetRuntimeProbeContext {
  const session = {
    id: "meet_probe",
    url: "https://meet.google.com/abc-defg-hij",
    transport: "chrome",
    mode: "agent",
    agentId: "main",
    chrome: {
      launched: true,
      // Output never advances, so the probe always runs to its deadline.
      health: { inCall: true, lastOutputBytes: 0, outputGeneration: 0 },
    },
  } as unknown as GoogleMeetSession;
  return {
    config: resolveGoogleMeetConfig({}),
    resolveAgentId: () => "main",
    list: () => [],
    join: async () => ({ session, spoken: true }),
    isReusable: () => false,
    hasHealthHandle: () => true,
    refreshHealth: () => {},
    refreshCaptionHealth: async () => {},
  };
}

async function settleAt(
  request: { url: string; timeoutMs?: number },
  checkpoints: number[],
): Promise<{ settledAfterMs: number[]; result: Awaited<ReturnType<typeof testGoogleMeetSpeech>> }> {
  vi.useFakeTimers();
  let settled = false;
  const pending = testGoogleMeetSpeech(neverVerifyingContext(), request).then((value) => {
    settled = true;
    return value;
  });
  const settledAfterMs: number[] = [];
  let elapsed = 0;
  for (const checkpoint of checkpoints) {
    await vi.advanceTimersByTimeAsync(checkpoint - elapsed);
    elapsed = checkpoint;
    if (settled) {
      settledAfterMs.push(checkpoint);
    }
  }
  await vi.advanceTimersByTimeAsync(200_000);
  return { settledAfterMs, result: await pending };
}

describe("google-meet test_speech probe deadline", () => {
  it("keeps the five-second observe-mode default when no timeout is requested", async () => {
    const { settledAfterMs, result } = await settleAt(
      { url: "https://meet.google.com/abc-defg-hij" },
      [4_900, 5_500],
    );

    expect(settledAfterMs).toEqual([5_500]);
    expect(result.speechOutputTimedOut).toBe(true);
    expect(result.speechOutputVerified).toBe(false);
  });

  it("honors an explicit probe timeout instead of the five-second default", async () => {
    const { settledAfterMs, result } = await settleAt(
      { url: "https://meet.google.com/abc-defg-hij", timeoutMs: 30_000 },
      [5_500, 29_900, 30_500],
    );

    // Still waiting well past the default deadline is the whole point: before the
    // request was read, this probe gave up at five seconds.
    expect(settledAfterMs).toEqual([30_500]);
    expect(result.speechOutputTimedOut).toBe(true);
  });

  it("caps an explicit probe timeout at the shared probe ceiling", async () => {
    const { settledAfterMs } = await settleAt(
      { url: "https://meet.google.com/abc-defg-hij", timeoutMs: 600_000 },
      [119_900, 120_500],
    );

    expect(settledAfterMs).toEqual([120_500]);
  });

  it("rejects a non-positive explicit probe timeout", async () => {
    await expect(
      testGoogleMeetSpeech(neverVerifyingContext(), {
        url: "https://meet.google.com/abc-defg-hij",
        timeoutMs: -1,
      }),
    ).rejects.toThrow("timeoutMs must be a positive number");
  });
});
