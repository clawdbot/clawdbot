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
import {
  listSessionEntryKeysReadOnly,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
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

const routeStateOwnerState = vi.hoisted(() => ({ owners: [] as Array<Record<string, unknown>> }));

vi.mock("../plugins/doctor-contract-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/doctor-contract-registry.js")>(
    "../plugins/doctor-contract-registry.js",
  );
  return {
    ...actual,
    listPluginDoctorSessionRouteStateOwners: vi.fn(() => routeStateOwnerState.owners),
  };
});

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
    routeStateOwnerState.owners = [];
    noteMock.mockClear();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("leaves legacy transcript diagnostics to the SQLite migration owner", async () => {
    const cfg: OpenClawConfig = {};
    writeSessionStore(cfg, {
      "agent:main:main:heartbeat": {
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
        sessionId: "latest-heartbeat-wake",
        updatedAt: Date.now(),
      },
    });
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    const displacedTranscript = path.join(sessionsDir, "displaced-heartbeat-wake.jsonl");
    fs.writeFileSync(displacedTranscript, '{"type":"session"}\n');
    const confirmRuntimeRepair = vi.fn(async () => false);

    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    expect(stateIntegrityText()).not.toContain("recent sessions are missing transcripts");
    expect(stateIntegrityText()).not.toContain("orphan transcript file");
    expect(fs.existsSync(displacedTranscript)).toBe(true);
    expect(confirmRuntimeRepair).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Archive 1 orphan") }),
    );
  });

  it.each(["default", "explicit"] as const)(
    "does not require JSONL files for %s SQLite session stores",
    async (location) => {
      const cfg: OpenClawConfig =
        location === "explicit"
          ? { session: { store: path.join(fs.realpathSync(tempHome), "sessions.sqlite") } }
          : {};
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

      const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
      try {
        await noteStateIntegrity(cfg, {
          confirmRuntimeRepair: vi.fn(async () => false),
          note: noteMock,
        });
        expect(readFileSyncSpy.mock.calls.map(([file]) => file)).not.toContain(storePath);
      } finally {
        readFileSyncSpy.mockRestore();
      }

      expect(stateIntegrityText()).not.toContain("recent sessions are missing transcripts");
      expect(stateIntegrityText()).not.toContain("Main session transcript missing");
    },
  );

  it("moves a non-default SQLite heartbeat main session without recreating sessions.json", async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, ops: {} } } };
    setupSessionState(cfg, process.env, tempHome, "ops");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    const mainKey = "agent:ops:main";
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: mainKey, storePath },
      {
        heartbeatIsolatedBaseSessionKey: mainKey,
        sessionId: "sqlite-heartbeat-ops",
        updatedAt: Date.now(),
      },
    );
    const confirmRuntimeRepair = vi.fn(async (params: { message: string }) =>
      params.message.startsWith("Move heartbeat-owned main session"),
    );

    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const keys = listSessionEntryKeysReadOnly({ agentId: "ops", storePath });
    const recoveredKey = keys.find((key) => key.startsWith("agent:ops:heartbeat-recovered-"));
    expect(keys).not.toContain(mainKey);
    if (!recoveredKey) {
      throw new Error("expected recovered SQLite heartbeat session key");
    }
    expect(
      loadSessionEntryReadOnly({ agentId: "ops", sessionKey: recoveredKey, storePath })?.sessionId,
    ).toBe("sqlite-heartbeat-ops");
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("does not create a recovery row when the SQLite main entry changes during confirmation", async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, ops: {} } } };
    setupSessionState(cfg, process.env, tempHome, "ops");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    const mainKey = "agent:ops:main";
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: mainKey, storePath },
      {
        heartbeatIsolatedBaseSessionKey: mainKey,
        sessionId: "sqlite-heartbeat-race-ops",
        updatedAt: 1,
      },
    );
    const confirmRuntimeRepair = vi.fn(async (params: { message: string }) => {
      if (!params.message.startsWith("Move heartbeat-owned main session")) {
        return false;
      }
      await upsertSessionEntryCore(
        { agentId: "ops", sessionKey: mainKey, storePath },
        { lastInteractionAt: 2, updatedAt: 2 },
      );
      return true;
    });

    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const keys = listSessionEntryKeysReadOnly({ agentId: "ops", storePath });
    expect(keys).toEqual([mainKey]);
    expect(keys.filter((key) => key.startsWith("agent:ops:heartbeat-recovered-"))).toStrictEqual(
      [],
    );
    expect(
      loadSessionEntryReadOnly({ agentId: "ops", sessionKey: mainKey, storePath })
        ?.lastInteractionAt,
    ).toBe(2);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("moves a plugin-repaired SQLite heartbeat row without restoring stale state", async () => {
    routeStateOwnerState.owners = [
      {
        authProfilePrefixes: ["openai-codex:"],
        cliSessionKeys: ["codex-cli"],
        id: "codex",
        label: "Codex",
        providerIds: ["openai-codex"],
        runtimeIds: ["codex-cli"],
      },
    ];
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "github-copilot/gpt-5.4-mini" } },
        entries: { main: {}, ops: {} },
      },
    };
    setupSessionState(cfg, process.env, tempHome, "ops");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    const mainKey = "agent:ops:main";
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: mainKey, storePath },
      {
        heartbeatIsolatedBaseSessionKey: mainKey,
        model: "gpt-5.4",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "auto",
        modelProvider: "openai-codex",
        providerOverride: "openai-codex",
        sessionId: "sqlite-combined-ops",
        updatedAt: Date.now(),
      },
    );
    const confirmRuntimeRepair = vi.fn(
      async (params: { message: string }) =>
        params.message.startsWith("Clear stale Codex") ||
        params.message.startsWith("Move heartbeat-owned main session"),
    );

    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const keys = listSessionEntryKeysReadOnly({ agentId: "ops", storePath });
    const recoveredKeys = keys.filter((key) => key.startsWith("agent:ops:heartbeat-recovered-"));
    expect(keys).not.toContain(mainKey);
    expect(recoveredKeys).toHaveLength(1);
    const recoveredKey = recoveredKeys[0];
    if (!recoveredKey) {
      throw new Error("expected one recovered combined-repair session key");
    }
    const recovered = loadSessionEntryReadOnly({
      agentId: "ops",
      sessionKey: recoveredKey,
      storePath,
    });
    expect(recovered?.sessionId).toBe("sqlite-combined-ops");
    expect(recovered?.providerOverride).toBeUndefined();
    expect(recovered?.modelOverride).toBeUndefined();
    expect(recovered?.modelProvider).toBeUndefined();
    expect(fs.existsSync(storePath)).toBe(false);
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
});
