import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../talk/voice-transcript.js";
import type { RelaySession } from "./talk-realtime-relay-state.js";
import {
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
} from "./talk-realtime-relay-voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
}));

vi.mock("../talk/client-voice-session.js", () => voiceSessionMocks);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function createRelaySession(): {
  session: RelaySession;
  failSession: ReturnType<typeof vi.fn>;
} {
  const failSession = vi.fn(() => {
    void closeRelayVoiceSession(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionKey: "agent:main:main",
    agentId: "main",
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
    pendingVoiceTranscripts: [],
  } as unknown as RelaySession;
  return { session, failSession };
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset();
  });

  it("bounds stalled finals, drains the accepted prefix, and closes once", async () => {
    const firstAppend = deferred();
    voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
      async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") {
          await firstAppend.promise;
        }
      },
    );
    const { session, failSession } = createRelaySession();
    let accepted = enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `) ? 1 : 0;

    for (let index = 0; index < 10_000; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
    }

    for (let index = 1; index < 10_000; index += 1) {
      if (
        enqueueRelayVoiceTranscript(
          session,
          index % 2 === 0 ? "user" : "assistant",
          `  ${"x".repeat(9_000)}  `,
        )
      ) {
        accepted += 1;
      }
    }

    expect(accepted).toBe(41);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
    expect(failSession).toHaveBeenCalledOnce();
    const close = session.voiceSessionClose;
    expect(close).toBeDefined();
    expect(closeRelayVoiceSession(session)).toBe(close);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();

    firstAppend.resolve();
    await close;

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(41);
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { entryId: string }).entryId,
      ),
    ).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.every(
        ([params]) => (params as { text: string }).text.length === 8_000,
      ),
    ).toBe(true);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
    expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
  });

  it("terminally closes the durable record after bounded transcript retries fail", async () => {
    vi.useFakeTimers();
    try {
      voiceSessionMocks.appendRelayVoiceTranscript.mockRejectedValue(
        new Error("transcript write failed"),
      );
      const { session } = createRelaySession();

      expect(enqueueRelayVoiceTranscript(session, "user", "persist me")).toBe(true);
      const close = closeRelayVoiceSession(session);
      await vi.runAllTimersAsync();
      await close;

      expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(3);
      expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
      expect(session.context.logGateway?.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("realtime relay transcript append failed"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes the bounded pre-bind transcript buffer", () => {
    const { session } = createRelaySession();
    session.sessionKey = undefined;
    session.agentId = undefined;

    for (let index = 0; index < 100; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
    }
    expect(session.pendingVoiceTranscripts).toHaveLength(0);

    for (let index = 0; index < 100; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `)).toBe(true);
    }

    expect(session.pendingVoiceTranscripts).toHaveLength(40);
    expect(session.pendingVoiceTranscripts.every((entry) => entry.text.length === 8_000)).toBe(
      true,
    );
  });
});
