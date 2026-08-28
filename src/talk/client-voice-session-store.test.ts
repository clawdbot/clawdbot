import { describe, expect, it } from "vitest";
import {
  parseStoredVoiceSessionRecord,
  VOICE_SESSION_RECORD_VERSION,
} from "./client-voice-session-store.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

function storedRecord(transcriptFailureKeys: unknown): string {
  return JSON.stringify({
    version: VOICE_SESSION_RECORD_VERSION,
    voiceSessionId: "voice-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    origin: "client",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    consultRunIds: [],
    effects: [],
    transcriptFailureKeys,
  });
}

describe("client voice session store", () => {
  it("defaults unresolved transcript failures for existing records", () => {
    expect(
      parseStoredVoiceSessionRecord(
        JSON.stringify({
          version: VOICE_SESSION_RECORD_VERSION,
          voiceSessionId: "voice-1",
          agentId: "main",
          sessionKey: "agent:main:main",
          origin: "client",
          status: "open",
          createdAt: 1,
          updatedAt: 1,
          consultRunIds: [],
          effects: [],
        }),
      )?.transcriptFailureKeys,
    ).toEqual([]);
  });

  it("rejects malformed, duplicate, or over-cap unresolved transcript failures", () => {
    const key = "a".repeat(64);
    expect(parseStoredVoiceSessionRecord(storedRecord(["not-a-hash"]))).toBeUndefined();
    expect(parseStoredVoiceSessionRecord(storedRecord([key, key]))).toBeUndefined();
    expect(
      parseStoredVoiceSessionRecord(
        storedRecord(
          Array.from({ length: VOICE_TRANSCRIPT_MAX_UNRESOLVED + 1 }, (_, index) =>
            index.toString(16).padStart(64, "0"),
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it.each([
    { name: "version", patch: { version: 2 } },
    { name: "origin", patch: { origin: "server" } },
    { name: "provider", patch: { provider: "   " } },
    { name: "updated timestamp", patch: { updatedAt: "later" } },
  ])("rejects an invalid $name", ({ patch }) => {
    const value = JSON.parse(storedRecord([])) as Record<string, unknown>;
    expect(parseStoredVoiceSessionRecord(JSON.stringify({ ...value, ...patch }))).toBeUndefined();
  });
});
