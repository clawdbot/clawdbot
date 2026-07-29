// Memory transcript owners follow filesystem casing without crossing agents.
import fsSync from "node:fs";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { extractAgentIdFromSessionsDir } from "./openclaw-runtime-session.js";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  sessionPathForFile,
} from "./session-files.js";

const invalidWindowsAgentIds = ["bad owner", "!!!", " Main", "Main ", "a".repeat(65)];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let tmpDir = "";
let originalStateDir: string | undefined;
let originalConfigPath: string | undefined;

beforeEach(() => {
  tmpDir = tempDirs.make("session-windows-ownership-");
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  delete process.env.OPENCLAW_CONFIG_PATH;
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
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
});

describe("memory session directory ownership", () => {
  it("preserves the canonical owner for case-variant Windows session directories", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(extractAgentIdFromSessionsDir(path.join(tmpDir, "AGENTS", "Main", "SESSIONS"))).toBe(
        "main",
      );
    } finally {
      platform.mockRestore();
    }
  });

  it("keeps case-variant structural segments unowned on case-sensitive platforms", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(
        extractAgentIdFromSessionsDir(path.join(tmpDir, "AGENTS", "Main", "SESSIONS")),
      ).toBeNull();
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves case-variant Windows ownership in logical transcript paths", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const sessionFile = path.join(tmpDir, "AGENTS", "Main", "SESSIONS", "active.jsonl");
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
        tmpDir,
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
        tmpDir,
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

  it("indexes the canonical SQLite identity from an agent-local custom store", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const customDir = path.join(tmpDir, "agents", "main", "custom");
      const storePath = path.join(customDir, "sessions.json");
      const sessionFile = path.join(customDir, "active.jsonl");
      const sessionKey = "agent:main:chat:custom-transcript";
      const configPath = path.join(tmpDir, "openclaw.json");
      fsSync.mkdirSync(customDir, { recursive: true });
      fsSync.writeFileSync(sessionFile, "");
      fsSync.writeFileSync(
        configPath,
        JSON.stringify({
          session: { store: path.join(tmpDir, "agents", "{agentId}", "custom", "sessions.json") },
        }),
      );
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionFile, sessionId: "active", updatedAt: 1 },
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
    }
  });

  it.each(invalidWindowsAgentIds)(
    "never aliases an invalid Windows session owner into another agent: %s",
    (owner) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        const sessionsDir = path.join(tmpDir, "agents", owner, "sessions");
        const sessionFile = path.join(sessionsDir, "active.jsonl");
        expect(extractAgentIdFromSessionsDir(sessionsDir)).toBeNull();
        expect(sessionPathForFile(sessionFile)).toBe("sessions/active.jsonl");
        expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toBeNull();
      } finally {
        platform.mockRestore();
      }
    },
  );

  it.each(invalidWindowsAgentIds)(
    "never ingests an invalid Windows session owner into the main corpus: %s",
    async (owner) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
        const otherSessionsDir = path.join(tmpDir, "agents", owner, "sessions");
        const otherSessionFile = path.join(otherSessionsDir, "private.jsonl");
        fsSync.mkdirSync(sessionsDir, { recursive: true });
        fsSync.mkdirSync(otherSessionsDir, { recursive: true });
        fsSync.writeFileSync(otherSessionFile, "");
        const sessionKey = "agent:main:chat:malformed-owner";
        await upsertSessionEntry(
          { agentId: "main", sessionKey, storePath: path.join(sessionsDir, "sessions.json") },
          { sessionFile: otherSessionFile, sessionId: "private", updatedAt: 1 },
        );
        const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
        expect(entries).toContainEqual(
          expect.objectContaining({
            agentId: "main",
            sessionFile: sessionKey,
            sessionId: "private",
            transcriptSource: "sqlite",
          }),
        );
        expect(entries).not.toContainEqual(
          expect.objectContaining({ sessionFile: otherSessionFile }),
        );
      } finally {
        platform.mockRestore();
      }
    },
  );

  it("never exposes another agent's custom transcript through the main SQLite corpus", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
      const otherSessionFile = path.join(tmpDir, "agents", "ops", "custom", "private.jsonl");
      const sessionKey = "agent:main:chat:cross-agent-custom";
      fsSync.mkdirSync(sessionsDir, { recursive: true });
      fsSync.mkdirSync(path.dirname(otherSessionFile), { recursive: true });
      fsSync.writeFileSync(otherSessionFile, "");
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath: path.join(sessionsDir, "sessions.json") },
        { sessionFile: otherSessionFile, sessionId: "private", updatedAt: 1 },
      );

      const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
      expect(entries).toContainEqual(
        expect.objectContaining({
          agentId: "main",
          sessionFile: sessionKey,
          sessionId: "private",
          transcriptSource: "sqlite",
        }),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({ sessionFile: otherSessionFile }),
      );
    } finally {
      platform.mockRestore();
    }
  });

  it("never ingests a nested transcript from another agent's sessions directory", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
      const otherSessionsDir = path.join(tmpDir, "agents", "ops", "sessions", "archive");
      const otherSessionFile = path.join(otherSessionsDir, "private.jsonl");
      fsSync.mkdirSync(sessionsDir, { recursive: true });
      fsSync.mkdirSync(otherSessionsDir, { recursive: true });
      fsSync.writeFileSync(otherSessionFile, "");
      const sessionKey = "agent:main:chat:nested-cross-agent";
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath: path.join(sessionsDir, "sessions.json") },
        { sessionFile: otherSessionFile, sessionId: "private", updatedAt: 1 },
      );
      const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
      expect(entries).toContainEqual(
        expect.objectContaining({
          agentId: "main",
          sessionFile: sessionKey,
          sessionId: "private",
          transcriptSource: "sqlite",
        }),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({ sessionFile: otherSessionFile }),
      );
    } finally {
      platform.mockRestore();
    }
  });
});
