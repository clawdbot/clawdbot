// Persisted transcripts that need repair or migration are rejected at load with
// an actionable error; runtime never rebuilds legacy or headerless history in place.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SessionManager persisted transcript repair gate", () => {
  it("rejects persisted legacy transcripts until doctor or import migrates them", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "legacy-persisted-session";
    const sessionKey = "agent:main:legacy-persisted-session";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(scope, [
      {
        type: "session",
        version: 1,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "message",
        message: { role: "user", content: "legacy message" },
      },
    ]);

    expect(() => SessionManager.open(scope, dir)).toThrow(
      "require doctor/import migration before runtime use",
    );
    const existingManager = SessionManager.inMemory("/original-workspace");
    expect(() => existingManager.setSessionTarget(scope)).toThrow(
      "require doctor/import migration before runtime use",
    );
    expect(existingManager.getCwd()).toBe("/original-workspace");

    const currentScope = {
      agentId: "main",
      sessionId: "current-persisted-session",
      sessionKey: "agent:main:current-persisted-session",
      storePath,
    };
    await upsertSessionEntryCore(currentScope, { sessionId: currentScope.sessionId, updatedAt: 2 });
    const currentManager = SessionManager.open(currentScope, dir);
    expect(() => currentManager.setSessionTarget(scope)).toThrow(
      "require doctor/import migration before runtime use",
    );
    currentManager.appendModelChange("test-provider", "test-model");
    await expect(loadTranscriptEvents(currentScope)).resolves.toEqual([
      expect.objectContaining({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: currentScope.sessionId,
      }),
      expect.objectContaining({ type: "model_change" }),
    ]);
  });

  it("rejects headerless persisted transcripts with a doctor repair hint", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "headerless-persisted-session";
    const sessionKey = "agent:main:headerless-persisted-session";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(scope, [
      {
        type: "reset",
        id: "orphan-reset",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        reason: "new",
      },
    ]);

    expect(() => SessionManager.open(scope, dir)).toThrow(
      'no session header row; run "openclaw doctor --fix"',
    );
  });
});
