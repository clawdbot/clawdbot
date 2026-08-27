import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionStorePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  clearTuiLastSessionPointers,
  readTuiLastSessionKey,
  writeTuiLastSessionKey,
} from "../tui/tui-last-session.js";
import {
  getTranscriptRecordMaxChars,
  moveHeartbeatMainSessionEntry,
  resolveHeartbeatMainSessionRepairCandidate,
  summarizeTranscriptHeartbeatMessages,
} from "./doctor-heartbeat-main-session-repair.test-support.js";
import {
  doctorChangesText,
  hasRepairPromptMessage,
  noteMock,
  noteStateIntegrity,
  repairPromptCalls,
  runStateIntegrityText,
  setupSessionState,
  stateIntegrityText,
  writeSessionStore,
} from "./doctor-state-integrity.test-support.js";

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));

describe("doctor transcript and heartbeat session repairs", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_OAUTH_DIR",
      "OPENCLAW_AGENT_DIR",
    ]);
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-state-integrity-"));
    const stateDir = path.join(tempHome, ".openclaw");
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_OAUTH_DIR");
    deleteTestEnvValue("OPENCLAW_AGENT_DIR");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    noteMock.mockClear();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("detects orphan transcripts and offers archival remediation", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    fs.writeFileSync(path.join(sessionsDir, "orphan-session.jsonl"), '{"type":"session"}\n');
    const confirmRuntimeRepair = vi.fn(async (params: { message: string }) =>
      params.message.includes("This only renames them to *.deleted.<timestamp>."),
    );
    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });
    expect(stateIntegrityText()).toContain(
      "These .jsonl files are no longer referenced by sessions.json",
    );
    expect(stateIntegrityText()).toContain("Examples: orphan-session.jsonl");
    const archivePrompt = repairPromptCalls(confirmRuntimeRepair).find((prompt) =>
      prompt.message?.includes("This only renames them to *.deleted.<timestamp>."),
    );
    expect(archivePrompt?.requiresInteractiveConfirmation).toBe(true);
    const files = fs.readdirSync(sessionsDir);
    const archivedOrphanTranscripts = files.filter((name) =>
      name.startsWith("orphan-session.jsonl.deleted."),
    );
    expect(archivedOrphanTranscripts.length).toBeGreaterThan(0);
  });

  it("uses SQLite session rows for transcript integrity without orphan false positives", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    const transcriptPath = path.join(sessionsDir, "sqlite-live-session.jsonl");
    fs.writeFileSync(transcriptPath, '{"type":"session"}\n');
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      {
        sessionFile: transcriptPath,
        sessionId: "sqlite-live-session",
        updatedAt: Date.now(),
      },
    );
    const confirmRuntimeRepair = vi.fn(async () => false);

    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    expect(stateIntegrityText()).not.toContain("orphan transcript file");
    expect(stateIntegrityText()).not.toContain("recent sessions are missing transcripts");
    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(confirmRuntimeRepair).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Archive 1 orphan") }),
    );
  });

  it("does not require JSONL files for canonical SQLite session rows", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      { sessionId: "sqlite-main-session", updatedAt: Date.now() },
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:sqlite-only", storePath },
      { sessionId: "sqlite-only-session", updatedAt: Date.now() },
    );

    await noteStateIntegrity(cfg, {
      confirmRuntimeRepair: vi.fn(async () => false),
      note: noteMock,
    });

    expect(stateIntegrityText()).not.toContain("recent sessions are missing transcripts");
    expect(stateIntegrityText()).not.toContain("Main session transcript missing");
  });

  it("does not auto-archive orphan transcripts from non-interactive repair mode", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    fs.writeFileSync(path.join(sessionsDir, "orphan-session.jsonl"), '{"type":"session"}\n');
    const confirmRuntimeRepair = vi.fn(
      async (params: { initialValue?: boolean; requiresInteractiveConfirmation?: boolean }) =>
        params.requiresInteractiveConfirmation !== true,
    );
    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const archivePrompt = repairPromptCalls(confirmRuntimeRepair).find(
      (prompt) => prompt.requiresInteractiveConfirmation === true,
    );
    expect(archivePrompt?.initialValue).toBe(false);
    const files = fs.readdirSync(sessionsDir);
    expect(files).toContain("orphan-session.jsonl");
    const archivedOrphanTranscripts = files.filter((name) =>
      name.startsWith("orphan-session.jsonl.deleted."),
    );
    expect(archivedOrphanTranscripts).toStrictEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "does not archive referenced transcripts when the state dir path resolves through a symlink",
    async () => {
      const cfg: OpenClawConfig = {};
      const originalHome = tempHome;
      const symlinkHome = path.join(
        path.dirname(originalHome),
        `${path.basename(originalHome)}-link`,
      );
      fs.symlinkSync(originalHome, symlinkHome, "dir");
      try {
        const symlinkStateDir = path.join(symlinkHome, ".openclaw");
        setTestEnvValue("HOME", symlinkHome);
        setTestEnvValue("OPENCLAW_HOME", symlinkHome);
        setTestEnvValue("OPENCLAW_STATE_DIR", symlinkStateDir);

        setupSessionState(cfg, process.env, symlinkHome);
        const sessionsDir = resolveSessionTranscriptsDirForAgent(
          "main",
          process.env,
          () => symlinkHome,
        );
        const transcriptPath = path.join(sessionsDir, "linked-session.jsonl");
        fs.writeFileSync(transcriptPath, '{"type":"session"}\n');
        writeSessionStore(cfg, {
          "agent:main:main": {
            sessionId: "linked-session",
            updatedAt: Date.now(),
          },
        });

        const confirmRuntimeRepair = vi.fn(async (params: { message: string }) =>
          params.message.includes("This only renames them to *.deleted.<timestamp>."),
        );
        await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

        expect(fs.existsSync(transcriptPath)).toBe(true);
        expect(fs.readdirSync(sessionsDir).filter((name) => name.includes(".deleted."))).toEqual(
          [],
        );
        expect(stateIntegrityText()).not.toContain("These .jsonl files are no longer referenced");
      } finally {
        fs.rmSync(symlinkHome, { force: true, recursive: true });
      }
    },
  );

  it("prints openclaw-only verification hints when recent sessions are missing transcripts", async () => {
    const cfg: OpenClawConfig = {};
    writeSessionStore(cfg, {
      "agent:main:main": {
        sessionId: "missing-transcript",
        updatedAt: Date.now(),
      },
    });
    const text = await runStateIntegrityText(cfg);
    expect(text).toContain("recent sessions are missing transcripts");
    expect(text).toMatch(/openclaw sessions --store ".*openclaw-agent\.sqlite"/);
    expect(text).toMatch(
      /openclaw sessions cleanup --store ".*openclaw-agent\.sqlite" --dry-run --fix-missing/,
    );
    expect(text).not.toMatch(
      /openclaw sessions cleanup --store ".*openclaw-agent\.sqlite" --dry-run(?! --fix-missing)/,
    );
    expect(text).toMatch(
      /openclaw sessions cleanup --store ".*openclaw-agent\.sqlite" --enforce --fix-missing/,
    );
    expect(text).not.toContain("--active");
    expect(text).not.toContain(" ls ");
  });

  it("moves a heartbeat-poisoned main session and clears stale TUI restore pointers", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, tempHome);
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    fs.writeFileSync(
      path.join(sessionsDir, "heartbeat-session.jsonl"),
      [
        JSON.stringify({ message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT } }),
        JSON.stringify({ message: { role: "assistant", content: "HEARTBEAT_OK" } }),
        "",
      ].join("\n"),
    );
    writeSessionStore(cfg, {
      "agent:main:main": {
        sessionId: "heartbeat-session",
        updatedAt: Date.now(),
      },
    });
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
    await writeTuiLastSessionKey({
      scopeKey: "default",
      sessionKey: "agent:main:main",
      stateDir,
    });
    await writeTuiLastSessionKey({
      scopeKey: "telegram",
      sessionKey: "agent:main:telegram:thread",
      stateDir,
    });

    const confirmRuntimeRepair = vi.fn(async (params: { message: string }) =>
      params.message.startsWith("Move heartbeat-owned main session"),
    );
    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    const recoveredKey = Object.keys(store).find((key) =>
      key.startsWith("agent:main:heartbeat-recovered-"),
    );
    expect(store["agent:main:main"]).toBeUndefined();
    if (recoveredKey === undefined) {
      throw new Error("expected recovered heartbeat session key");
    }
    expect(store[recoveredKey]?.sessionId).toBe("heartbeat-session");

    await expect(readTuiLastSessionKey({ scopeKey: "default", stateDir })).resolves.toBeNull();
    await expect(readTuiLastSessionKey({ scopeKey: "telegram", stateDir })).resolves.toBe(
      "agent:main:telegram:thread",
    );
    expect(doctorChangesText()).toContain("Moved heartbeat-owned main session agent:main:main");
    expect(doctorChangesText()).toContain("Cleared 1 stale TUI last-session pointer");
  });

  it("does not move a mixed main transcript that has real user activity", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, tempHome);
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    fs.writeFileSync(
      path.join(sessionsDir, "mixed-session.jsonl"),
      [
        JSON.stringify({ message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT } }),
        JSON.stringify({ message: { role: "assistant", content: "HEARTBEAT_OK" } }),
        JSON.stringify({ message: { role: "user", content: "hello from telegram" } }),
        "",
      ].join("\n"),
    );
    writeSessionStore(cfg, {
      "agent:main:main": {
        sessionId: "mixed-session",
        updatedAt: Date.now(),
      },
    });

    const confirmRuntimeRepair = vi.fn(async () => true);
    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(store["agent:main:main"]?.sessionId).toBe("mixed-session");
    expect(Object.keys(store).filter((key) => key.includes("heartbeat-recovered"))).toEqual([]);
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Move heartbeat-owned main session")).toBe(
      false,
    );
  });

  it("repairs a multi-chunk heartbeat transcript without loading it via readFileSync", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, tempHome);
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    const transcriptPath = path.join(sessionsDir, "large-heartbeat-session.jsonl");
    const heartbeatLine = `${JSON.stringify({
      message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
    })}\n${JSON.stringify({ message: { role: "assistant", content: "HEARTBEAT_OK" } })}\n`;
    // >64 KiB so the sync scanner must read more than one chunk.
    const repeats = Math.ceil((80 * 1024) / heartbeatLine.length);
    fs.writeFileSync(transcriptPath, heartbeatLine.repeat(repeats));
    expect(fs.statSync(transcriptPath).size).toBeGreaterThan(64 * 1024);

    writeSessionStore(cfg, {
      "agent:main:main": {
        sessionId: "large-heartbeat-session",
        updatedAt: Date.now(),
      },
    });

    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    const confirmRuntimeRepair = vi.fn(async (params: { message: string }) =>
      params.message.startsWith("Move heartbeat-owned main session"),
    );
    try {
      await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });
    } finally {
      const transcriptReads = readFileSyncSpy.mock.calls.filter((call) => {
        const target = call[0];
        return typeof target === "string" && path.resolve(target) === path.resolve(transcriptPath);
      });
      readFileSyncSpy.mockRestore();
      expect(transcriptReads).toEqual([]);
    }

    const summary = summarizeTranscriptHeartbeatMessages(transcriptPath);
    expect(summary?.heartbeatUserMessages).toBe(repeats);
    expect(summary?.nonHeartbeatUserMessages).toBe(0);
    expect(summary?.userMessages).toBe(repeats);

    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(store["agent:main:main"]).toBeUndefined();
    const recoveredKey = Object.keys(store).find((key) =>
      key.startsWith("agent:main:heartbeat-recovered-"),
    );
    expect(recoveredKey).toBeDefined();
    expect(store[recoveredKey!]?.sessionId).toBe("large-heartbeat-session");
    expect(doctorChangesText()).toContain("Moved heartbeat-owned main session agent:main:main");
  });

  it("declines repair when a single JSONL record exceeds the scanner record cap", async () => {
    const cfg: OpenClawConfig = {};
    setupSessionState(cfg, process.env, tempHome);
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    const transcriptPath = path.join(sessionsDir, "oversized-record-session.jsonl");
    const maxChars = getTranscriptRecordMaxChars();
    const oversizedRecord = `${"x".repeat(maxChars + 1)}\n`;
    const heartbeatLine = `${JSON.stringify({
      message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
    })}\n`;
    fs.writeFileSync(transcriptPath, `${oversizedRecord}${heartbeatLine}`);

    writeSessionStore(cfg, {
      "agent:main:main": {
        sessionId: "oversized-record-session",
        updatedAt: Date.now(),
      },
    });

    const confirmRuntimeRepair = vi.fn(async (params: { message: string }) =>
      params.message.startsWith("Move heartbeat-owned main session"),
    );
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    try {
      await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });
    } finally {
      const transcriptReads = readFileSyncSpy.mock.calls.filter((call) => {
        const target = call[0];
        return typeof target === "string" && path.resolve(target) === path.resolve(transcriptPath);
      });
      readFileSyncSpy.mockRestore();
      expect(transcriptReads).toEqual([]);
    }

    expect(summarizeTranscriptHeartbeatMessages(transcriptPath)).toBeNull();
    expect(stateIntegrityText()).toContain(
      "Skipped heartbeat main-session recovery for agent:main:main: the transcript contains a JSONL record larger than",
    );
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Move heartbeat-owned main session")).toBe(
      false,
    );
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(store["agent:main:main"]?.sessionId).toBe("oversized-record-session");
    expect(Object.keys(store).filter((key) => key.includes("heartbeat-recovered"))).toEqual([]);
  });

  it("does not treat heartbeat-labeled routing metadata as heartbeat ownership", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      delivery: { kind: "internal" },
    };
    expect(resolveHeartbeatMainSessionRepairCandidate({ entry })).toBeNull();
  });

  it("keeps synthetic heartbeat ownership metadata as direct repair proof", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      heartbeatIsolatedBaseSessionKey: "agent:main:main",
    };
    expect(resolveHeartbeatMainSessionRepairCandidate({ entry })?.reason).toBe("metadata");
  });

  it("does not move synthetic heartbeat-owned sessions after recorded human interaction", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      heartbeatIsolatedBaseSessionKey: "agent:main:main",
      lastInteractionAt: 2,
    };
    expect(resolveHeartbeatMainSessionRepairCandidate({ entry })).toBeNull();
  });

  it("does not let synthetic heartbeat metadata override mixed transcript history", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-main-mixed-"));
    try {
      const transcriptPath = path.join(tempDir, "session.jsonl");
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT } }),
          JSON.stringify({ message: { role: "user", content: "real follow-up" } }),
          "",
        ].join("\n"),
      );
      const entry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
      };
      expect(resolveHeartbeatMainSessionRepairCandidate({ entry, transcriptPath })).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let heartbeat-looking routing metadata skip mixed transcript checks", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-main-route-"));
    try {
      const transcriptPath = path.join(tempDir, "session.jsonl");
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT } }),
          JSON.stringify({ message: { role: "user", content: "real follow-up" } }),
          "",
        ].join("\n"),
      );
      const entry = {
        sessionId: "session",
        updatedAt: 1,
        lastProvider: "heartbeat",
        source: "heartbeat",
        origin: { provider: "heartbeat" },
      } as SessionEntry & Record<string, unknown>;
      expect(resolveHeartbeatMainSessionRepairCandidate({ entry, transcriptPath })).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not classify transcripts with real user activity after 400 heartbeat messages", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-main-cap-"));
    try {
      const transcriptPath = path.join(tempDir, "session.jsonl");
      const heartbeatMessages = Array.from({ length: 400 }, () =>
        JSON.stringify({ message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT } }),
      );
      fs.writeFileSync(
        transcriptPath,
        [
          ...heartbeatMessages,
          JSON.stringify({ message: { role: "user", content: "real follow-up" } }),
          "",
        ].join("\n"),
      );
      const entry: SessionEntry = { sessionId: "session", updatedAt: 1 };
      expect(resolveHeartbeatMainSessionRepairCandidate({ entry, transcriptPath })).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the heartbeat main-session helper conservative", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-main-helper-"));
    try {
      const transcriptPath = path.join(tempDir, "session.jsonl");
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ message: { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT } }),
          JSON.stringify({ message: { role: "assistant", content: "HEARTBEAT_OK" } }),
          "",
        ].join("\n"),
      );
      const entry: SessionEntry = { sessionId: "session", updatedAt: 1 };
      expect(resolveHeartbeatMainSessionRepairCandidate({ entry, transcriptPath })?.reason).toBe(
        "transcript",
      );
      entry.lastInteractionAt = 2;
      expect(resolveHeartbeatMainSessionRepairCandidate({ entry, transcriptPath })).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("moves store entries and clears matching TUI pointers without touching others", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": { sessionId: "main-session", updatedAt: 1 },
    };
    expect(
      moveHeartbeatMainSessionEntry({
        store,
        mainKey: "agent:main:main",
        recoveredKey: "agent:main:heartbeat-recovered-2026-05-04t00-00-00.000z",
      }),
    ).toBe(true);
    expect(store["agent:main:main"]).toBeUndefined();
    expect(store["agent:main:heartbeat-recovered-2026-05-04t00-00-00.000z"]?.sessionId).toBe(
      "main-session",
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tui-pointer-clear-"));
    try {
      await writeTuiLastSessionKey({
        scopeKey: "terminal",
        sessionKey: "agent:main:main",
        stateDir: tempDir,
      });
      await writeTuiLastSessionKey({
        scopeKey: "telegram",
        sessionKey: "agent:main:telegram:thread",
        stateDir: tempDir,
      });
      expect(
        clearTuiLastSessionPointers({
          stateDir: tempDir,
          sessionKeys: new Set(["agent:main:main"]),
        }),
      ).toBe(1);
      await expect(
        readTuiLastSessionKey({ scopeKey: "terminal", stateDir: tempDir }),
      ).resolves.toBeNull();
      await expect(
        readTuiLastSessionKey({ scopeKey: "telegram", stateDir: tempDir }),
      ).resolves.toBe("agent:main:telegram:thread");
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores slash-routing sessions for recent missing transcript warnings", async () => {
    const cfg: OpenClawConfig = {};
    writeSessionStore(cfg, {
      "agent:main:telegram:slash:6790081233": {
        sessionId: "missing-slash-transcript",
        updatedAt: Date.now(),
      },
    });
    const text = await runStateIntegrityText(cfg);
    expect(text).not.toContain("recent sessions are missing transcripts");
  });
});
