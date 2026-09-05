import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingPlatformAdapter } from "./platform-adapter.js";
import { createMeetingRuntimeProbes, resolveMeetingProbeTimeoutMs } from "./runtime-probes.js";
import type { MeetingPluginProbeHealth } from "./session-types.js";

type Mode = "agent" | "bidi" | "transcribe";
type Transport = "chrome" | "chrome-node";
type Health = MeetingPluginProbeHealth;
type Session = {
  id: string;
  chrome?: {
    launched: boolean;
    browserTab?: { targetId?: string };
    health?: Health;
  };
};
type Request = {
  url: string;
  mode?: Mode;
  transport?: Transport;
  timeoutMs?: number;
  message?: string;
  agentId?: string;
};
type Config = {
  defaultMode: Mode;
  chrome: { joinTimeoutMs: number };
  chromeNode: { node?: string };
};

type CreateProbeOptions = {
  invalidRequest?: (message: string) => Error;
  shouldWaitForListening?: (session: Session) => boolean;
};

const URL = "https://example.test/meeting";
const config: Config = {
  defaultMode: "agent",
  chrome: { joinTimeoutMs: 30_000 },
  chromeNode: {},
};

function createProbes(options: CreateProbeOptions = {}) {
  return createMeetingRuntimeProbes<Config, Mode, Transport, Health, Session, Request>({
    defaultSpeechMessage: "Say exactly: meeting speech test complete.",
    invalidRequest: options.invalidRequest ?? ((message) => new Error(message)),
    resolveTimeoutMs: resolveMeetingProbeTimeoutMs,
    shouldWaitForListening: options.shouldWaitForListening ?? (() => true),
    talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
  });
}

type ProbeContext = Parameters<ReturnType<typeof createProbes>["testSpeech"]>[0];

function createContext(params: {
  session: Session;
  spoken?: boolean;
  existing?: Session[];
  hasHealthHandle?: boolean;
  refreshHealth?: () => void;
  refreshCaptionHealth?: (session: Session, timeoutMs?: number) => Promise<void>;
}): ProbeContext {
  return {
    config,
    resolveAgentId: () => "main",
    list: () => params.existing ?? [],
    join: vi.fn(async () => ({ session: params.session, spoken: params.spoken })),
    isReusable: () => false,
    hasHealthHandle: () => params.hasHealthHandle ?? false,
    refreshHealth: params.refreshHealth ?? vi.fn(),
    refreshCaptionHealth: params.refreshCaptionHealth ?? vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("meeting runtime probes", () => {
  it("uses the supplied invalid-request factory", async () => {
    const probes = createProbes({
      invalidRequest: (message) =>
        Object.assign(new Error(message), { name: "ProbeInvalidRequest" }),
    });

    await expect(
      probes.testSpeech(createContext({ session: { id: "unused" } }), {
        url: URL,
        mode: "transcribe",
      }),
    ).rejects.toMatchObject({
      name: "ProbeInvalidRequest",
      message: "test_speech requires mode: agent or bidi",
    });
  });

  it.each([false, true])("honors shouldWaitForListening when it returns %s", async (shouldWait) => {
    const session: Session = { id: "listen-policy", chrome: { launched: true, health: {} } };
    const refreshCaptionHealth = vi.fn(async () => {
      session.chrome!.health = {
        ...session.chrome!.health,
        manualAction: { reason: "admission-required", message: "Waiting" },
      };
    });
    const probes = createProbes({ shouldWaitForListening: () => shouldWait });

    await probes.testListening(createContext({ session, refreshCaptionHealth }), {
      url: URL,
      mode: "transcribe",
      timeoutMs: 100,
    });

    if (shouldWait) {
      expect(refreshCaptionHealth).toHaveBeenCalledOnce();
    } else {
      expect(refreshCaptionHealth).not.toHaveBeenCalled();
    }
  });

  it("uses the per-request speech verification timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session: Session = {
      id: "speech-timeout",
      chrome: { launched: true, health: { inCall: true, lastOutputBytes: 0 } },
    };
    const refreshHealth = vi.fn();
    const probes = createProbes();

    const pending = probes.testSpeech(
      createContext({ session, spoken: true, hasHealthHandle: true, refreshHealth }),
      { url: URL, mode: "agent", timeoutMs: 150 },
    );
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toMatchObject({ speechOutputTimedOut: true });
    expect(refreshHealth).toHaveBeenCalled();
  });

  it("requires a fresh verified output generation", async () => {
    const probes = createProbes();
    for (const [verifiedOutputGeneration, expected] of [
      [undefined, false],
      [1, true],
    ] as const) {
      const session: Session = {
        id: `speech-generation-${String(verifiedOutputGeneration)}`,
        chrome: {
          launched: true,
          health: {
            inCall: true,
            lastOutputBytes: 4,
            outputGeneration: 1,
            verifiedOutputGeneration,
          },
        },
      };

      const result = await probes.testSpeech(createContext({ session, spoken: true }), {
        url: URL,
        mode: "agent",
      });

      expect(result.speechOutputVerified).toBe(expected);
    }
  });

  it("bounds a blocked caption refresh by the listening timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session: Session = { id: "listen-blocked", chrome: { launched: true, health: {} } };
    const refreshCaptionHealth = vi.fn(
      (_session: Session, _timeoutMs?: number) => new Promise<void>(() => {}),
    );
    const probes = createProbes();

    const pending = probes.testListening(createContext({ session, refreshCaptionHealth }), {
      url: URL,
      mode: "transcribe",
      timeoutMs: 300,
    });
    await vi.advanceTimersByTimeAsync(350);

    await expect(pending).resolves.toMatchObject({ listenTimedOut: true });
    expect(refreshCaptionHealth).toHaveBeenCalledWith(session, 300);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns caption progress and manual action before the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session: Session = { id: "listen-progress", chrome: { launched: true, health: {} } };
    const refreshCaptionHealth = vi.fn(async () => {
      session.chrome!.health = {
        ...session.chrome!.health,
        lastCaptionText: "Caption already waiting",
        manualAction: { reason: "admission-required", message: "Waiting" },
        transcriptLines: 1,
      };
    });
    const probes = createProbes();

    const result = await probes.testListening(createContext({ session, refreshCaptionHealth }), {
      url: URL,
      mode: "transcribe",
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      listenVerified: true,
      manualAction: { reason: "admission-required", message: "Waiting" },
    });
    expect(refreshCaptionHealth).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects caption progress that arrives after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session: Session = { id: "listen-late", chrome: { launched: true, health: {} } };
    const probes = createProbes();
    const refreshCaptionHealth = async (_session: Session, timeoutMs?: number) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, (timeoutMs ?? 0) + 50);
      });
      session.chrome!.health = {
        ...session.chrome!.health,
        lastCaptionText: "Too late",
        transcriptLines: 1,
      };
    };

    const pending = probes.testListening(createContext({ session, refreshCaptionHealth }), {
      url: URL,
      mode: "transcribe",
      timeoutMs: 300,
    });
    await vi.advanceTimersByTimeAsync(400);

    await expect(pending).resolves.toMatchObject({
      listenTimedOut: true,
      listenVerified: false,
    });
  });
});
