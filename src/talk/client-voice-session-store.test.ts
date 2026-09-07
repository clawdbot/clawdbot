import { describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import {
  parseStoredVoiceSessionRecord,
  readVoiceSessionRecordInTransaction,
  VOICE_SESSION_RECORD_VERSION,
  writeVoiceSessionRecordInTransaction,
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
  it("preserves cache custody columns across rejected updates and a successful retry", async () => {
    const home = await createTempHomeEnv("openclaw-voice-store-");
    const scope = "talk-client-voice-sessions";
    try {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const original = parseStoredVoiceSessionRecord(storedRecord([]));
      if (!original) {
        throw new Error("expected a valid voice record");
      }
      const write = (updatedAt: number) =>
        runOpenClawAgentWriteTransaction(
          (owner) => writeVoiceSessionRecordInTransaction(owner, { ...original, updatedAt }),
          { agentId: "main" },
        );
      write(1);
      database.db
        .prepare("UPDATE cache_entries SET blob = ?, expires_at = ? WHERE scope = ? AND key = ?")
        .run(Buffer.from([0, 255, 4]), 123, scope, original.voiceSessionId);
      const read = () =>
        database.db
          .prepare(
            "SELECT value_json, hex(blob) AS blob, expires_at FROM cache_entries WHERE scope = ? AND key = ?",
          )
          .get(scope, original.voiceSessionId);
      const before = read();
      database.db.exec(`CREATE TEMP TRIGGER reject_voice_update BEFORE UPDATE ON main.cache_entries
        WHEN NEW.scope = 'talk-client-voice-sessions' AND NEW.updated_at = 2
        BEGIN SELECT RAISE(ABORT, 'synthetic voice update failure'); END`);
      expect(() => write(2)).toThrow("synthetic voice update failure");
      expect(database.db.isTransaction).toBe(false);
      expect(read()).toEqual(before);
      database.db.exec("DROP TRIGGER reject_voice_update");
      write(3);
      expect(read()).toEqual({
        value_json: JSON.stringify({ ...original, updatedAt: 3 }),
        blob: "00FF04",
        expires_at: 123,
      });
      expect(readVoiceSessionRecordInTransaction(database, original.voiceSessionId)).toEqual({
        ...original,
        updatedAt: 3,
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await home.restore();
    }
  });

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
