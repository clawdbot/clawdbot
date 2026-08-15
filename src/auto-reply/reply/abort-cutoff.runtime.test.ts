// Covers abort-cutoff clearing against missing persisted rows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { clearAbortCutoffInSessionRuntime } from "./abort-cutoff.runtime.js";

async function withTempStore<T>(run: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-cutoff-"));
  try {
    return await run(path.join(dir, "sessions.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("clearAbortCutoffInSessionRuntime", () => {
  it("recreates a complete persisted row when clearing abort cutoff state", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:explicit:cutoff-missing-row";
      const entry: SessionEntry = {
        sessionId: "cutoff-session",
        updatedAt: 1,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
        abortCutoffMessageSid: "msg-42",
        abortCutoffTimestamp: 123,
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };

      const cleared = await clearAbortCutoffInSessionRuntime({
        sessionEntry: entry,
        sessionStore,
        sessionKey,
        storePath,
      });

      const persisted = loadSessionEntry({ storePath, sessionKey });
      expect(cleared).toBe(true);
      expect(sessionStore[sessionKey]?.sessionId).toBe("cutoff-session");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("anthropic");
      expect(sessionStore[sessionKey]?.abortCutoffMessageSid).toBeUndefined();
      expect(sessionStore[sessionKey]?.abortCutoffTimestamp).toBeUndefined();
      expect(persisted?.sessionId).toBe("cutoff-session");
      expect(persisted?.modelProvider).toBe("anthropic");
      expect(persisted?.model).toBe("claude-opus-4-6");
      expect(persisted?.abortCutoffMessageSid).toBeUndefined();
      expect(persisted?.abortCutoffTimestamp).toBeUndefined();
    });
  });
});
