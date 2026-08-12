// Memory transcript owners follow filesystem casing without crossing agents.
import fsSync from "node:fs";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  extractAgentIdFromSessionsDir,
  resolveSessionTranscriptsDirForAgent,
} from "./openclaw-runtime-session.js";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  sessionPathForFile,
} from "./session-files.js";

const invalidWindowsAgentIds = ["bad owner", "!!!", " Main", "Main ", "a".repeat(65)];

function resolveFixtureStateDir(): string {
  return path.resolve(resolveSessionTranscriptsDirForAgent("main"), "../../..");
}

describe("memory session directory ownership", () => {
  it("preserves the canonical owner for case-variant Windows session directories", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(
        extractAgentIdFromSessionsDir(
          path.join(resolveFixtureStateDir(), "AGENTS", "Main", "SESSIONS"),
        ),
      ).toBe("main");
    } finally {
      platform.mockRestore();
    }
  });

  it("keeps case-variant structural segments unowned on case-sensitive platforms", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(
        extractAgentIdFromSessionsDir(
          path.join(resolveFixtureStateDir(), "AGENTS", "Main", "SESSIONS"),
        ),
      ).toBeNull();
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves case-variant Windows ownership in logical transcript paths", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const sessionFile = path.join(
        resolveFixtureStateDir(),
        "AGENTS",
        "Main",
        "SESSIONS",
        "active.jsonl",
      );
      expect(sessionPathForFile(sessionFile)).toBe("sessions/main/active.jsonl");
      expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toEqual({
        agentId: "main",
        sessionId: "active",
      });
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves case-variant Windows ownership for nested session transcripts", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const sessionFile = path.join(
        resolveFixtureStateDir(),
        "AGENTS",
        "OPS",
        "SESSIONS",
        "archive",
        "private.jsonl",
      );
      expect(sessionPathForFile(sessionFile)).toBe("sessions/ops/private.jsonl");
    } finally {
      platform.mockRestore();
    }
  });

  it("finds the canonical owner past a nested case-variant sessions directory", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const sessionFile = path.join(
        resolveFixtureStateDir(),
        "agents",
        "main",
        "sessions",
        "archive",
        "SESSIONS",
        "active.jsonl",
      );
      expect(sessionPathForFile(sessionFile)).toBe("sessions/main/active.jsonl");
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves canonical SQLite session identity on Windows", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDirs = createTempDirTracker();
    const tmpDir = tempDirs.make("session-windows-ownership-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    try {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      delete process.env.OPENCLAW_CONFIG_PATH;
      clearRuntimeConfigSnapshot();
      clearConfigCache();

      const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:chat:windows-transcript";
      fsSync.mkdirSync(sessionsDir, { recursive: true });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "active", updatedAt: 1 },
      );

      await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
        expect.objectContaining({
          agentId: "main",
          sessionFile: sessionKey,
          sessionId: "active",
          transcriptSource: "sqlite",
        }),
      );
    } finally {
      platform.mockRestore();
      // Agent close releases leases through shared state; close agent handles first while the
      // fixture env is active, then close shared state before removing the Windows-owned directory.
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      if (originalConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      }
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      tempDirs.cleanup();
    }
  });

  it.each(invalidWindowsAgentIds)(
    "never aliases an invalid Windows session owner into another agent: %s",
    (owner) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        const sessionsDir = path.join(resolveFixtureStateDir(), "agents", owner, "sessions");
        const sessionFile = path.join(sessionsDir, "active.jsonl");
        expect(extractAgentIdFromSessionsDir(sessionsDir)).toBeNull();
        expect(sessionPathForFile(sessionFile)).toBe("sessions/active.jsonl");
        expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toBeNull();
      } finally {
        platform.mockRestore();
      }
    },
  );
});
