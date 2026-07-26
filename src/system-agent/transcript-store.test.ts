import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { appendTranscriptTurn, readTranscriptTail } from "./transcript-store.js";

// Mirrors the store's internal retention bound (kept module-local there).
const SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES = 1_000;

describe("system-agent transcript store", () => {
  afterEach(() => {
    closeOpenClawStateDatabase();
  });

  it("appends turns and returns a bounded tail oldest-first", async () => {
    await withTempDir({ prefix: "openclaw-system-agent-transcript-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      appendTranscriptTurn({ role: "assistant", text: "welcome", at: 1 }, { env });
      appendTranscriptTurn({ role: "user", text: "status", at: 2 }, { env });
      appendTranscriptTurn({ role: "assistant", text: "healthy", at: 2 }, { env });
      closeOpenClawStateDatabase();

      expect(readTranscriptTail(2, { env })).toEqual([
        { role: "user", text: "status", at: 2 },
        { role: "assistant", text: "healthy", at: 2 },
      ]);
      expect(readTranscriptTail(0, { env })).toEqual([]);
    });
  });

  it("prunes the oldest rows beyond the rolling retention limit", async () => {
    await withTempDir({ prefix: "openclaw-system-agent-transcript-prune-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      for (let index = 0; index <= SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES; index += 1) {
        appendTranscriptTurn({ role: "user", text: `turn-${index}`, at: index }, { env });
      }

      const turns = readTranscriptTail(SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES + 1, { env });
      expect(turns).toHaveLength(SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES);
      expect(turns[0]?.text).toBe("turn-1");
      expect(turns.at(-1)?.text).toBe(`turn-${SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES}`);
    });
  });

  it("hides reset markers and seeds only turns after a marker within the tail window", async () => {
    await withTempDir({ prefix: "openclaw-system-agent-transcript-reset-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      appendTranscriptTurn({ role: "user", text: "before reset", at: 1 }, { env });
      appendTranscriptTurn({ role: "assistant", text: "old answer", at: 2 }, { env });
      appendTranscriptTurn({ role: "reset", text: "", at: 3 }, { env });
      appendTranscriptTurn({ role: "user", text: "after reset", at: 4 }, { env });
      appendTranscriptTurn({ role: "assistant", text: "new answer", at: 5 }, { env });
      closeOpenClawStateDatabase();

      expect(readTranscriptTail(10, { env })).toEqual([
        { role: "user", text: "before reset", at: 1 },
        { role: "assistant", text: "old answer", at: 2 },
        { role: "user", text: "after reset", at: 4 },
        { role: "assistant", text: "new answer", at: 5 },
      ]);
      expect(readTranscriptTail(10, { afterLastReset: true, env })).toEqual([
        { role: "user", text: "after reset", at: 4 },
        { role: "assistant", text: "new answer", at: 5 },
      ]);
    });
  });

  it("does not let a reset marker older than the requested tail truncate newer turns", async () => {
    await withTempDir(
      { prefix: "openclaw-system-agent-transcript-old-reset-" },
      async (stateDir) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        appendTranscriptTurn({ role: "user", text: "before reset", at: 1 }, { env });
        appendTranscriptTurn({ role: "reset", text: "", at: 2 }, { env });
        appendTranscriptTurn({ role: "user", text: "newer one", at: 3 }, { env });
        appendTranscriptTurn({ role: "assistant", text: "newer two", at: 4 }, { env });
        appendTranscriptTurn({ role: "user", text: "newer three", at: 5 }, { env });
        closeOpenClawStateDatabase();

        expect(readTranscriptTail(2, { afterLastReset: true, env })).toEqual([
          { role: "assistant", text: "newer two", at: 4 },
          { role: "user", text: "newer three", at: 5 },
        ]);
      },
    );
  });
});
