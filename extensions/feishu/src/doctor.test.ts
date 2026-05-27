import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { isFeishuSessionStoreKey, runFeishuDoctorSequence } from "./doctor.js";

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

function writeStore(entries: Record<string, unknown>, agentId = "main"): string {
  const target = storePath(agentId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(entries, null, 2));
  return target;
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

  it("matches only Feishu channel session keys", () => {
    expect(isFeishuSessionStoreKey("agent:main:feishu:direct:ou_user")).toBe(true);
    expect(isFeishuSessionStoreKey("feishu:direct:ou_user")).toBe(true);
    expect(isFeishuSessionStoreKey("agent:codex:acp:binding:feishu:default:abc123")).toBe(false);
    expect(isFeishuSessionStoreKey("agent:main:discord:direct:user")).toBe(false);
  });

  it("stays quiet for healthy Feishu state and transcripts", async () => {
    const feishuDedupDir = path.join(stateDir(), "feishu", "dedup");
    fs.mkdirSync(feishuDedupDir, { recursive: true });
    fs.writeFileSync(path.join(feishuDedupDir, "default.json"), JSON.stringify({ msg1: 1 }));

    writeTranscript("sess-ok", [sessionHeader("sess-ok"), userMessage("hello")]);
    writeStore({
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
    const transcriptPath = writeTranscript("sess-abs", [
      sessionHeader("sess-abs"),
      userMessage("hello"),
    ]);
    const customStorePath = path.join(stateDir(), "custom-sessions", "sessions.json");
    fs.mkdirSync(path.dirname(customStorePath), { recursive: true });
    fs.writeFileSync(
      customStorePath,
      JSON.stringify({
        "agent:main:feishu:direct:ou_user": {
          sessionId: "sess-abs",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      }),
    );

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

  it("keeps Feishu sessions with separated blank user messages", async () => {
    writeTranscript("sess-separated-blanks", [
      sessionHeader("sess-separated-blanks"),
      userMessage(""),
      userMessage("hello"),
      userMessage(""),
      userMessage("world"),
      userMessage(""),
    ]);
    writeStore({
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
    const targetStorePath = writeStore({
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

    const store = loadSessionStore(targetStorePath, { skipCache: true });
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

    const targetStorePath = writeStore({
      "agent:main:feishu:direct:ou_user": {
        sessionId: "sess-bad",
        sessionFile: "sess-bad.jsonl",
        updatedAt: Date.now(),
      },
      "agent:codex:acp:binding:feishu:default:abc123": {
        sessionId: "sess-acp-bad",
        sessionFile: "sess-acp-bad.jsonl",
        updatedAt: Date.now(),
        route: { channel: "feishu", target: { to: "ou_user", chatType: "direct" } },
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

    const store = loadSessionStore(targetStorePath, { skipCache: true });
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

  it("archives unhealthy default-scope sessions when metadata identifies Feishu", async () => {
    const transcriptPath = writeTranscript("sess-default-feishu-bad", [
      sessionHeader("sess-default-feishu-bad"),
      userMessage(""),
      userMessage(""),
      userMessage(""),
    ]);
    const targetStorePath = writeStore({
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
    const store = loadSessionStore(targetStorePath, { skipCache: true });
    expect(store["agent:main:main"]).toBeUndefined();
    expect(store["agent:main:main-non-feishu"]).toBeDefined();
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });
});
