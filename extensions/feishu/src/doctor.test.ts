// Feishu tests cover doctor plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  formatSqliteSessionFileMarker,
  listSessionEntries,
  normalizeSessionDeliveryState,
  type SessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuDoctor } from "./doctor.js";

const runFeishuDoctorSequence = feishuDoctor.runConfigSequence!;

type EnvSnapshot = {
  HOME?: string;
  OPENCLAW_HOME?: string;
  OPENCLAW_STATE_DIR?: string;
};

function captureEnv(): EnvSnapshot {
  return {
    HOME: process.env.HOME,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const key of Object.keys(snapshot) as Array<keyof EnvSnapshot>) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function feishuConfig(): OpenClawConfig {
  return {
    channels: {
      feishu: {
        appId: "cli_xxx",
        appSecret: "secret_xxx",
      },
    },
  } as OpenClawConfig;
}

function stateDir(): string {
  const dir = process.env.OPENCLAW_STATE_DIR;
  if (!dir) {
    throw new Error("OPENCLAW_STATE_DIR is not set");
  }
  return dir;
}

function sessionsDir(agentId = "main"): string {
  return path.join(stateDir(), "agents", agentId, "sessions");
}

function storePath(agentId = "main"): string {
  return path.join(sessionsDir(agentId), "sessions.json");
}

function sqliteStorePath(agentId = "main"): string {
  return path.join(stateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function corruptTranscriptEventJson(agentId: string, sessionId: string): void {
  const database = new DatabaseSync(sqliteStorePath(agentId));
  try {
    database
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
      .run("{", sessionId);
  } finally {
    database.close();
  }
}

async function writeStore(entries: Record<string, unknown>, agentId = "main"): Promise<string> {
  const target = storePath(agentId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(entries, null, 2));
  for (const [sessionKey, entry] of Object.entries(entries as Record<string, SessionEntry>)) {
    await upsertSessionEntry({ agentId, storePath: target, sessionKey, entry });
  }
  return target;
}

function readStoreEntries(target: string, agentId = "main"): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ agentId, storePath: target }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

function writeTranscript(sessionId: string, lines: unknown[], agentId = "main"): string {
  const target = path.join(sessionsDir(agentId), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return target;
}

function sessionHeader(sessionId: string) {
  return {
    type: "session",
    id: sessionId,
    version: 7,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
}

function userMessage(content: string) {
  return {
    type: "message",
    id: `msg-${content || "blank"}-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content },
  };
}

function listBackupDirs(): string[] {
  const backupsDir = path.join(stateDir(), "backups");
  return fs.existsSync(backupsDir)
    ? fs.readdirSync(backupsDir).filter((name) => name.startsWith("feishu-state-repair-"))
    : [];
}

describe("Feishu doctor state repair", () => {
  let envSnapshot: EnvSnapshot;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-doctor-"));
    process.env.HOME = tempHome;
    process.env.OPENCLAW_HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
    fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("stays quiet for healthy Feishu state and transcripts", async () => {
    const feishuDedupDir = path.join(stateDir(), "feishu", "dedup");
    fs.mkdirSync(feishuDedupDir, { recursive: true });
    fs.writeFileSync(path.join(feishuDedupDir, "default.json"), JSON.stringify({ msg1: 1 }));

    writeTranscript("sess-ok", [sessionHeader("sess-ok"), userMessage("hello")]);
    await writeStore({
      "agent:main:feishu:direct:ou_user": {
        sessionId: "sess-ok",
        sessionFile: "sess-ok.jsonl",
        updatedAt: Date.now(),
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: false,
    });

    expect(result).toEqual({ changeNotes: [], warningNotes: [] });
  });

  it("keeps custom-store sessions with canonical absolute transcripts", async () => {
    const customStorePath = path.join(stateDir(), "custom-sessions", "sessions.json");
    const transcriptPath = writeTranscript("sess-abs", [
      sessionHeader("sess-abs"),
      userMessage("hello"),
    ]);
    await upsertSessionEntry({
      agentId: "main",
      storePath: customStorePath,
      sessionKey: "agent:main:feishu:direct:ou_user",
      entry: {
        sessionId: "sess-abs",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: {
        ...feishuConfig(),
        session: { store: customStorePath },
      } as OpenClawConfig,
      env: process.env,
      shouldRepair: false,
    });

    expect(result).toEqual({ changeNotes: [], warningNotes: [] });
  });

  it("keeps SQLite-backed Feishu session rows without file inspection", async () => {
    await writeStore({
      "agent:main:feishu:direct:ou_user": {
        sessionId: "sess-sqlite",
        sessionFile: `sqlite:main:sess-sqlite:${storePath()}`,
        updatedAt: Date.now(),
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: false,
    });

    expect(result).toEqual({ changeNotes: [], warningNotes: [] });
  });

  it("repairs SQLite-backed Feishu sessions with repeated blank user messages", async () => {
    const targetStorePath = storePath();
    const sessionKey = "agent:main:feishu:direct:ou_sqlite_blank";
    const sessionId = "sess-sqlite-blank";
    await upsertSessionEntry({
      agentId: "main",
      storePath: targetStorePath,
      sessionKey,
      entry: {
        sessionId,
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId,
          storePath: targetStorePath,
        }),
        updatedAt: Date.now(),
      },
    });
    for (const content of ["", "", ""]) {
      await appendSessionTranscriptMessageByIdentity({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: targetStorePath,
        message: { role: "user", content },
      });
    }

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");
    expect(readStoreEntries(targetStorePath)[sessionKey]).toBeUndefined();
    await expect(
      readSessionTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: targetStorePath,
      }),
    ).resolves.toEqual([]);
  });

  it("repairs SQLite-backed Feishu sessions with corrupt transcript rows", async () => {
    const targetStorePath = storePath();
    const sessionKey = "agent:main:feishu:direct:ou_sqlite_corrupt";
    const sessionId = "sess-sqlite-corrupt";
    await upsertSessionEntry({
      agentId: "main",
      storePath: targetStorePath,
      sessionKey,
      entry: {
        sessionId,
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId,
          storePath: targetStorePath,
        }),
        updatedAt: Date.now(),
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: targetStorePath,
      message: { role: "user", content: "bad row follows" },
    });
    corruptTranscriptEventJson("main", sessionId);

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");
    expect(readStoreEntries(targetStorePath)[sessionKey]).toBeUndefined();
  });

  it("keeps Feishu sessions with separated blank user messages", async () => {
    writeTranscript("sess-separated-blanks", [
      sessionHeader("sess-separated-blanks"),
      userMessage(""),
      userMessage("hello"),
      userMessage(""),
      userMessage("world"),
      userMessage(""),
    ]);
    await writeStore({
      "agent:main:feishu:direct:ou_user": {
        sessionId: "sess-separated-blanks",
        sessionFile: "sess-separated-blanks.jsonl",
        updatedAt: Date.now(),
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: false,
    });

    expect(result).toEqual({ changeNotes: [], warningNotes: [] });
  });

  it("warns before repair when Feishu local state is corrupt", async () => {
    const feishuDedupDir = path.join(stateDir(), "feishu", "dedup");
    fs.mkdirSync(feishuDedupDir, { recursive: true });
    fs.writeFileSync(path.join(feishuDedupDir, "default.json"), "{");

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: false,
    });

    expect(result.changeNotes).toEqual([]);
    expect(result.warningNotes.join("\n")).toContain("Feishu local channel state may need repair");
    expect(result.warningNotes.join("\n")).toContain("preserving Feishu App ID/secret config");
    expect(result.warningNotes.join("\n")).toContain("openclaw doctor --fix");
  });

  it("rebuilds corrupt Feishu state without deleting healthy Feishu sessions", async () => {
    const feishuDedupDir = path.join(stateDir(), "feishu", "dedup");
    fs.mkdirSync(feishuDedupDir, { recursive: true });
    fs.writeFileSync(path.join(feishuDedupDir, "default.json"), "{");

    const transcriptPath = writeTranscript("sess-ok", [
      sessionHeader("sess-ok"),
      userMessage("hello"),
    ]);
    const targetStorePath = await writeStore({
      "agent:main:feishu:direct:ou_user": {
        sessionId: "sess-ok",
        sessionFile: "sess-ok.jsonl",
        updatedAt: Date.now(),
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Rebuilt Feishu runtime state: yes");
    expect(result.changeNotes.join("\n")).toContain("Removed 0 Feishu-scoped session entries");

    const store = readStoreEntries(targetStorePath);
    expect(store["agent:main:feishu:direct:ou_user"]).toBeDefined();
    expect(fs.existsSync(transcriptPath)).toBe(true);

    expect(fs.existsSync(path.join(stateDir(), "feishu"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir(), "feishu", "dedup", "default.json"))).toBe(false);

    const backups = listBackupDirs();
    expect(backups).toHaveLength(1);
    const backupDir = path.join(stateDir(), "backups", backups[0] ?? "");
    expect(fs.existsSync(path.join(backupDir, "feishu", "dedup", "default.json"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "session-stores", "main", "sessions.json"))).toBe(
      false,
    );
  });

  it("archives only unhealthy Feishu direct sessions while preserving state, config, and other sessions", async () => {
    const feishuDedupDir = path.join(stateDir(), "feishu", "dedup");
    fs.mkdirSync(feishuDedupDir, { recursive: true });
    fs.writeFileSync(path.join(feishuDedupDir, "default.json"), JSON.stringify({ msg1: 1 }));

    const transcriptPath = writeTranscript("sess-bad", [
      sessionHeader("sess-bad"),
      userMessage(""),
      userMessage(""),
      userMessage(""),
    ]);
    const trajectoryPath = path.join(sessionsDir(), "sess-bad.trajectory.jsonl");
    const trajectoryIndexPath = path.join(sessionsDir(), "sess-bad.trajectory-path.json");
    fs.writeFileSync(trajectoryPath, "{}\n");
    fs.writeFileSync(trajectoryIndexPath, "{}\n");
    const acpTranscriptPath = writeTranscript("sess-acp-bad", [
      sessionHeader("sess-acp-bad"),
      userMessage(""),
      userMessage(""),
      userMessage(""),
    ]);

    const targetStorePath = await writeStore({
      "agent:main:feishu:direct:ou_user": {
        sessionId: "sess-bad",
        sessionFile: "sess-bad.jsonl",
        updatedAt: Date.now(),
      },
      "agent:codex:acp:binding:feishu:default:abc123": {
        sessionId: "sess-acp-bad",
        sessionFile: "sess-acp-bad.jsonl",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          route: { channel: "feishu", target: { to: "ou_user", chatType: "direct" } },
        }),
      },
      "agent:main:discord:direct:user": {
        sessionId: "sess-discord",
        updatedAt: Date.now(),
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Feishu local state repaired");
    expect(result.changeNotes.join("\n")).toContain("Rebuilt Feishu runtime state: not needed");
    expect(result.changeNotes.join("\n")).toContain("Preserved Feishu App ID/secret config");

    expect(fs.existsSync(path.join(stateDir(), "feishu"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir(), "feishu", "dedup", "default.json"))).toBe(true);

    const backups = listBackupDirs();
    expect(backups).toHaveLength(1);
    const backupDir = path.join(stateDir(), "backups", backups[0] ?? "");
    expect(fs.existsSync(path.join(backupDir, "feishu", "dedup", "default.json"))).toBe(false);
    expect(fs.existsSync(path.join(backupDir, "session-stores", "main", "sessions.json"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(backupDir, "session-stores", "main", "openclaw-agent.sqlite")),
    ).toBe(true);

    const store = readStoreEntries(targetStorePath);
    expect(store["agent:main:feishu:direct:ou_user"]).toBeUndefined();
    expect(store["agent:codex:acp:binding:feishu:default:abc123"]).toBeDefined();
    expect(store["agent:main:discord:direct:user"]).toBeDefined();

    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(acpTranscriptPath)).toBe(true);
    expect(fs.existsSync(trajectoryPath)).toBe(false);
    expect(fs.existsSync(trajectoryIndexPath)).toBe(false);
    const archivedNames = fs.readdirSync(sessionsDir());
    expect(archivedNames.some((name) => name.startsWith("sess-bad.jsonl.deleted."))).toBe(true);
    expect(
      archivedNames.some((name) => name.startsWith("sess-bad.trajectory.jsonl.deleted.")),
    ).toBe(true);
    expect(
      archivedNames.some((name) => name.startsWith("sess-bad.trajectory-path.json.deleted.")),
    ).toBe(true);
  });

  it("preserves locked harness sessions while repairing ordinary Feishu sessions", async () => {
    const targetStorePath = storePath();
    await upsertSessionEntry({
      agentId: "main",
      storePath: targetStorePath,
      sessionKey: "agent:main:ordinary-codex-locked",
      entry: {
        sessionId: "sess-codex-locked",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        delivery: normalizeSessionDeliveryState({
          route: { channel: "feishu", target: { to: "ou_user", chatType: "direct" } },
        }),
        updatedAt: 1,
      },
    });
    await upsertSessionEntry({
      agentId: "main",
      storePath: targetStorePath,
      sessionKey: "agent:main:feishu:direct:ou_user",
      entry: {
        sessionId: "sess-feishu-bad",
        updatedAt: 1,
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");
    const store = readStoreEntries(targetStorePath);
    expect(store["agent:main:ordinary-codex-locked"]).toBeDefined();
    expect(store["agent:main:feishu:direct:ou_user"]).toBeUndefined();
  });

  it("backs up SQLite session stores before removing migrated Feishu sessions", async () => {
    const targetStorePath = storePath();
    const sessionKey = "agent:main:feishu:direct:ou_migrated";
    await upsertSessionEntry({
      agentId: "main",
      storePath: targetStorePath,
      sessionKey,
      entry: {
        sessionId: "sess-migrated-bad",
        updatedAt: Date.now(),
      },
    });

    expect(fs.existsSync(targetStorePath)).toBe(false);
    expect(fs.existsSync(sqliteStorePath())).toBe(true);

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");

    const backups = listBackupDirs();
    expect(backups).toHaveLength(1);
    const backupDir = path.join(stateDir(), "backups", backups[0] ?? "");
    expect(fs.existsSync(path.join(backupDir, "session-stores", "main", "sessions.json"))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(backupDir, "session-stores", "main", "openclaw-agent.sqlite")),
    ).toBe(true);

    expect(readStoreEntries(targetStorePath)[sessionKey]).toBeUndefined();
  });

  it("backs up and repairs Feishu sessions in an agent-scoped custom SQLite store", async () => {
    const customStorePath = path.join(stateDir(), "custom-sessions", "sessions.json");
    const customSqlitePath = path.join(
      path.dirname(customStorePath),
      "openclaw-agent.support.sqlite",
    );
    const sessionKey = "agent:support:feishu:direct:ou_migrated";
    await upsertSessionEntry({
      agentId: "support",
      storePath: customStorePath,
      sessionKey,
      entry: {
        sessionId: "sess-support-bad",
        updatedAt: Date.now(),
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "support",
      sessionId: "sess-support-bad",
      sessionKey,
      storePath: customStorePath,
      message: { role: "user", content: "unhealthy migrated Feishu session" },
    });

    expect(fs.existsSync(customStorePath)).toBe(false);
    expect(fs.existsSync(customSqlitePath)).toBe(true);

    const result = await runFeishuDoctorSequence({
      cfg: {
        ...feishuConfig(),
        agents: { list: [{ id: "support", default: true }] },
        session: { store: customStorePath },
      } as OpenClawConfig,
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    expect(result.changeNotes.join("\n")).toContain("Removed 1 Feishu-scoped session entry");

    const backups = listBackupDirs();
    expect(backups).toHaveLength(1);
    const backupDir = path.join(stateDir(), "backups", backups[0] ?? "");
    expect(fs.existsSync(path.join(backupDir, "session-stores", "support", "sessions.json"))).toBe(
      false,
    );
    expect(
      fs.existsSync(
        path.join(backupDir, "session-stores", "support", "openclaw-agent.support.sqlite"),
      ),
    ).toBe(true);

    expect(readStoreEntries(customStorePath, "support")[sessionKey]).toBeUndefined();
    await expect(
      readSessionTranscriptEvents({
        agentId: "support",
        sessionId: "sess-support-bad",
        sessionKey,
        storePath: customStorePath,
      }),
    ).resolves.toEqual([]);
  });

  it("archives unhealthy default-scope sessions when metadata identifies Feishu", async () => {
    const transcriptPath = writeTranscript("sess-default-feishu-bad", [
      sessionHeader("sess-default-feishu-bad"),
      userMessage(""),
      userMessage(""),
      userMessage(""),
    ]);
    const targetStorePath = await writeStore({
      "agent:main:main": {
        sessionId: "sess-default-feishu-bad",
        sessionFile: "sess-default-feishu-bad.jsonl",
        updatedAt: Date.now(),
        origin: { provider: "feishu", from: "feishu:ou_user" },
        route: { channel: "feishu", target: { to: "ou_user", chatType: "direct" } },
      },
      "agent:main:main-non-feishu": {
        sessionId: "sess-other",
        updatedAt: Date.now(),
        origin: { provider: "discord" },
      },
    });

    const result = await runFeishuDoctorSequence({
      cfg: feishuConfig(),
      env: process.env,
      shouldRepair: true,
    });

    expect(result.warningNotes).toEqual([]);
    const store = readStoreEntries(targetStorePath);
    expect(store["agent:main:main"]).toBeUndefined();
    expect(store["agent:main:main-non-feishu"]).toBeDefined();
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });
});
