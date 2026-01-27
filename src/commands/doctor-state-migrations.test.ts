import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";

let tempRoot: string | null = null;

async function makeTempRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-doctor-"));
  tempRoot = root;
  return root;
}

afterEach(async () => {
  resetAutoMigrateLegacyStateForTest();
  if (!tempRoot) return;
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function writeJson5(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("doctor legacy state migrations", () => {
  it("migrates legacy sessions into agents/<id>/sessions", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};
    const legacySessionsDir = path.join(root, "sessions");
    fs.mkdirSync(legacySessionsDir, { recursive: true });

    writeJson5(path.join(legacySessionsDir, "sessions.json"), {
      "+1555": { sessionId: "a", updatedAt: 10 },
      "+1666": { sessionId: "b", updatedAt: 20 },
      "slack:channel:C123": { sessionId: "c", updatedAt: 30 },
      "group:abc": { sessionId: "d", updatedAt: 40 },
      "subagent:xyz": { sessionId: "e", updatedAt: 50 },
    });
    fs.writeFileSync(path.join(legacySessionsDir, "a.jsonl"), "a", "utf-8");
    fs.writeFileSync(path.join(legacySessionsDir, "b.jsonl"), "b", "utf-8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });

    expect(result.warnings).toEqual([]);
    const targetDir = path.join(root, "agents", "main", "sessions");
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "b.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(false);

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(store["agent:main:main"]?.sessionId).toBe("b");
    expect(store["agent:main:+1555"]?.sessionId).toBe("a");
    expect(store["agent:main:+1666"]?.sessionId).toBe("b");
    expect(store["+1555"]).toBeUndefined();
    expect(store["+1666"]).toBeUndefined();
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("c");
    expect(store["agent:main:unknown:group:abc"]?.sessionId).toBe("d");
    expect(store["agent:main:subagent:xyz"]?.sessionId).toBe("e");
  });

  it("migrates legacy agent dir with conflict fallback", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};

    const legacyAgentDir = path.join(root, "agent");
    fs.mkdirSync(legacyAgentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyAgentDir, "foo.txt"), "legacy", "utf-8");
    fs.writeFileSync(path.join(legacyAgentDir, "baz.txt"), "legacy2", "utf-8");

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "foo.txt"), "new", "utf-8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    expect(fs.readFileSync(path.join(targetAgentDir, "baz.txt"), "utf-8")).toBe("legacy2");
    const backupDir = path.join(root, "agents", "main", "agent.legacy-123");
    expect(fs.existsSync(path.join(backupDir, "foo.txt"))).toBe(true);
  });

  it("auto-migrates legacy agent dir on startup", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};

    const legacyAgentDir = path.join(root, "agent");
    fs.mkdirSync(legacyAgentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyAgentDir, "auth.json"), "{}", "utf-8");

    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await autoMigrateLegacyState({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
      log,
    });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    expect(fs.existsSync(path.join(targetAgentDir, "auth.json"))).toBe(true);
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
  });

  it("auto-migrates legacy sessions on startup", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};

    const legacySessionsDir = path.join(root, "sessions");
    fs.mkdirSync(legacySessionsDir, { recursive: true });
    writeJson5(path.join(legacySessionsDir, "sessions.json"), {
      "+1555": { sessionId: "a", updatedAt: 10 },
    });
    fs.writeFileSync(path.join(legacySessionsDir, "a.jsonl"), "a", "utf-8");

    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await autoMigrateLegacyState({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
      log,
      now: () => 123,
    });

    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();

    const targetDir = path.join(root, "agents", "main", "sessions");
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "sessions.json"))).toBe(true);
  });

  it("migrates legacy WhatsApp auth files without touching oauth.json", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};

    const oauthDir = path.join(root, "credentials");
    fs.mkdirSync(oauthDir, { recursive: true });
    fs.writeFileSync(path.join(oauthDir, "oauth.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "creds.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "session-abc.json"), "{}", "utf-8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    const target = path.join(oauthDir, "whatsapp", "default");
    expect(fs.existsSync(path.join(target, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "session-abc.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "creds.json"))).toBe(false);
  });

  it("no-ops when nothing detected", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });
    expect(result.changes).toEqual([]);
  });

  it("routes legacy state to the default agent entry", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {
      agents: { list: [{ id: "alpha", default: true }] },
    };
    const legacySessionsDir = path.join(root, "sessions");
    fs.mkdirSync(legacySessionsDir, { recursive: true });
    writeJson5(path.join(legacySessionsDir, "sessions.json"), {
      "+1555": { sessionId: "a", updatedAt: 10 },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    const targetDir = path.join(root, "agents", "alpha", "sessions");
    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(store["agent:alpha:main"]?.sessionId).toBe("a");
  });

  it("honors session.mainKey when seeding the direct-chat bucket", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = { session: { mainKey: "work" } };
    const legacySessionsDir = path.join(root, "sessions");
    fs.mkdirSync(legacySessionsDir, { recursive: true });
    writeJson5(path.join(legacySessionsDir, "sessions.json"), {
      "+1555": { sessionId: "a", updatedAt: 10 },
      "+1666": { sessionId: "b", updatedAt: 20 },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    const targetDir = path.join(root, "agents", "main", "sessions");
    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(store["agent:main:work"]?.sessionId).toBe("b");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("canonicalizes legacy main keys inside the target sessions store", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
      "agent:main:main": { sessionId: "fresh", updatedAt: 20 },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("fresh");
  });

  it("prefers the newest entry when collapsing main aliases", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = { session: { mainKey: "work" } };
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": { sessionId: "legacy", updatedAt: 50 },
      "agent:main:work": { sessionId: "canonical", updatedAt: 10 },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(store["agent:main:work"]?.sessionId).toBe("legacy");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("lowercases agent session keys during canonicalization", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:slack:channel:C123": { sessionId: "legacy", updatedAt: 10 },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("legacy");
    expect(store["agent:main:slack:channel:C123"]).toBeUndefined();
  });

  it("auto-migrates when only target sessions contain legacy keys", async () => {
    const root = await makeTempRoot();
    const cfg: MoltbotConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
    });

    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await autoMigrateLegacyState({
      cfg,
      env: { CLAWDBOT_STATE_DIR: root } as NodeJS.ProcessEnv,
      log,
    });

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("legacy");
  });
});
