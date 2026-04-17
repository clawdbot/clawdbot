import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resetSessionStoreLockRuntimeForTests,
  setSessionWriteLockAcquirerForTests,
} from "../config/sessions/store.js";
import {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";

let tempRoot: string | null = null;

vi.mock("../channels/plugins/bundled.js", () => {
  function fileExists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  function resolveTelegramAccountId(cfg: OpenClawConfig): string {
    const defaultAgentId = cfg.agents?.list?.find((agent) => agent.default)?.id ?? "main";
    const boundAccountId = cfg.bindings?.find(
      (binding) =>
        binding.agentId === defaultAgentId &&
        binding.match?.channel === "telegram" &&
        typeof binding.match.accountId === "string",
    )?.match.accountId;
    return boundAccountId ?? cfg.channels?.telegram?.defaultAccount ?? "default";
  }

  function detectTelegramAllowFromMigration(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
  }) {
    const root = params.env.OPENCLAW_STATE_DIR;
    if (!root) {
      return [];
    }
    const legacyPath = path.join(root, "credentials", "telegram-allowFrom.json");
    if (!fileExists(legacyPath)) {
      return [];
    }
    const targetPath = path.join(
      root,
      "credentials",
      `telegram-${resolveTelegramAccountId(params.cfg)}-allowFrom.json`,
    );
    return fileExists(targetPath)
      ? []
      : [
          {
            kind: "copy" as const,
            label: "Telegram pairing allowFrom",
            sourcePath: legacyPath,
            targetPath,
          },
        ];
  }

  function detectWhatsAppLegacyStateMigrations(params: { oauthDir: string }) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(params.oauthDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const isLegacyAuthFile =
        entry.name === "creds.json" ||
        entry.name === "creds.json.bak" ||
        (/^(app-state-sync|session|sender-key|pre-key)-/.test(entry.name) &&
          entry.name.endsWith(".json"));
      if (!entry.isFile() || entry.name === "oauth.json" || !isLegacyAuthFile) {
        return [];
      }
      const sourcePath = path.join(params.oauthDir, entry.name);
      const targetPath = path.join(params.oauthDir, "whatsapp", "default", entry.name);
      return fileExists(targetPath)
        ? []
        : [{ kind: "move" as const, label: `WhatsApp auth ${entry.name}`, sourcePath, targetPath }];
    });
  }

  return {
    listBundledChannelSetupPluginsByFeature: vi.fn((feature: string) => {
      if (feature === "legacySessionSurfaces") {
        return [
          {
            id: "whatsapp",
            messaging: {
              isLegacyGroupSessionKey: (key: string) => /^group:.+@g\.us$/i.test(key.trim()),
              canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) =>
                /^group:.+@g\.us$/i.test(key.trim())
                  ? `agent:${agentId}:whatsapp:${key.trim().toLowerCase()}`
                  : null,
            },
          },
        ];
      }
      if (feature === "legacyStateMigrations") {
        return [
          {
            id: "whatsapp",
            lifecycle: {
              detectLegacyStateMigrations: ({ oauthDir }: { oauthDir: string }) =>
                detectWhatsAppLegacyStateMigrations({ oauthDir }),
            },
          },
          {
            id: "telegram",
            lifecycle: {
              detectLegacyStateMigrations: ({
                cfg,
                env,
              }: {
                cfg: OpenClawConfig;
                env: NodeJS.ProcessEnv;
              }) => detectTelegramAllowFromMigration({ cfg, env }),
            },
          },
        ];
      }
      return [];
    }),
  };
});

vi.mock("../infra/json-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/json-files.js")>("../infra/json-files.js");
  return {
    ...actual,
    writeTextAtomic: async (
      filePath: string,
      content: string,
      options?: { mode?: number; ensureDirMode?: number; appendTrailingNewline?: boolean },
    ) => {
      const payload =
        options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
        ...(typeof options?.ensureDirMode === "number" ? { mode: options.ensureDirMode } : {}),
      });
      await fs.promises.writeFile(filePath, payload, {
        encoding: "utf8",
        mode: options?.mode ?? 0o600,
      });
    },
  };
});

async function makeTempRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-"));
  tempRoot = root;
  return root;
}

async function makeRootWithEmptyCfg() {
  const root = await makeTempRoot();
  const cfg: OpenClawConfig = {};
  return { root, cfg };
}

function writeLegacyTelegramAllowFromStore(oauthDir: string) {
  fs.writeFileSync(
    path.join(oauthDir, "telegram-allowFrom.json"),
    JSON.stringify(
      {
        version: 1,
        allowFrom: ["123456"],
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

async function runTelegramAllowFromMigration(params: { root: string; cfg: OpenClawConfig }) {
  const oauthDir = ensureCredentialsDir(params.root);
  writeLegacyTelegramAllowFromStore(oauthDir);
  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
  });
  const result = await runLegacyStateMigrations({ detected, now: () => 123 });
  return { oauthDir, detected, result };
}

beforeEach(() => {
  setSessionWriteLockAcquirerForTests(async () => ({
    release: async () => undefined,
  }));
});

afterEach(async () => {
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  resetSessionStoreLockRuntimeForTests();
  if (!tempRoot) {
    return;
  }
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function writeJson5(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeLegacySessionsFixture(params: {
  root: string;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
  transcripts?: Record<string, string>;
}) {
  const legacySessionsDir = path.join(params.root, "sessions");
  fs.mkdirSync(legacySessionsDir, { recursive: true });
  writeJson5(path.join(legacySessionsDir, "sessions.json"), params.sessions);
  for (const [fileName, content] of Object.entries(params.transcripts ?? {})) {
    fs.writeFileSync(path.join(legacySessionsDir, fileName), content, "utf-8");
  }
  return legacySessionsDir;
}

async function detectAndRunMigrations(params: {
  root: string;
  cfg: OpenClawConfig;
  now?: () => number;
}) {
  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
  });
  await runLegacyStateMigrations({ detected, now: params.now });
}

function readSessionsStore(targetDir: string) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8")) as Record<
    string,
    { sessionId: string }
  >;
}

async function runAndReadSessionsStore(params: {
  root: string;
  cfg: OpenClawConfig;
  targetDir: string;
  now?: () => number;
}) {
  await detectAndRunMigrations({
    root: params.root,
    cfg: params.cfg,
    now: params.now,
  });
  return readSessionsStore(params.targetDir);
}

type StateDirMigrationResult = Awaited<ReturnType<typeof autoMigrateLegacyStateDir>>;

const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function getStateDirMigrationPaths(root: string) {
  return {
    targetDir: path.join(root, ".openclaw"),
    legacyDir: path.join(root, ".clawdbot"),
  };
}

function ensureLegacyAndTargetStateDirs(root: string) {
  const paths = getStateDirMigrationPaths(root);
  fs.mkdirSync(paths.targetDir, { recursive: true });
  fs.mkdirSync(paths.legacyDir, { recursive: true });
  return paths;
}

async function runStateDirMigration(root: string, env = {} as NodeJS.ProcessEnv) {
  return autoMigrateLegacyStateDir({
    env,
    homedir: () => root,
  });
}

async function runAutoMigrateLegacyStateWithLog(params: {
  root: string;
  cfg: OpenClawConfig;
  now?: () => number;
}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const result = await autoMigrateLegacyState({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
    log,
    now: params.now,
  });
  return { result, log };
}

function expectTargetAlreadyExistsWarning(result: StateDirMigrationResult, targetDir: string) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toEqual([
    `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
  ]);
}

function expectUnmigratedWithoutWarnings(result: StateDirMigrationResult) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toEqual([]);
}

function writeLegacyAgentFiles(root: string, files: Record<string, string>) {
  const legacyAgentDir = path.join(root, "agent");
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(legacyAgentDir, fileName), content, "utf-8");
  }
  return legacyAgentDir;
}

function ensureCredentialsDir(root: string) {
  const oauthDir = path.join(root, "credentials");
  fs.mkdirSync(oauthDir, { recursive: true });
  return oauthDir;
}

describe("doctor legacy state migrations", () => {
  it("migrates legacy sessions into agents/<id>/sessions", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
        "+1666": { sessionId: "b", updatedAt: 20 },
        "slack:channel:C123": { sessionId: "c", updatedAt: 30 },
        "group:abc": { sessionId: "d", updatedAt: 40 },
        "subagent:xyz": { sessionId: "e", updatedAt: 50 },
      },
      transcripts: {
        "a.jsonl": "a",
        "b.jsonl": "b",
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
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

  it("keeps shipped WhatsApp legacy group keys channel-qualified during migration", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");

    writeLegacySessionsFixture({
      root,
      sessions: {
        "group:123@g.us": { sessionId: "wa", updatedAt: 10 },
        "group:abc": { sessionId: "generic", updatedAt: 9 },
      },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });

    expect(store["agent:main:whatsapp:group:123@g.us"]?.sessionId).toBe("wa");
    expect(store["agent:main:unknown:group:abc"]?.sessionId).toBe("generic");
  });

  it("migrates legacy agent dir with conflict fallback", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    writeLegacyAgentFiles(root, {
      "foo.txt": "legacy",
      "baz.txt": "legacy2",
    });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "foo.txt"), "new", "utf-8");

    await detectAndRunMigrations({ root, cfg, now: () => 123 });

    expect(fs.readFileSync(path.join(targetAgentDir, "baz.txt"), "utf-8")).toBe("legacy2");
    const backupDir = path.join(root, "agents", "main", "agent.legacy-123");
    expect(fs.existsSync(path.join(backupDir, "foo.txt"))).toBe(true);
  });

  it("auto-migrates legacy agent dir on startup", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    writeLegacyAgentFiles(root, { "auth.json": "{}" });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    expect(fs.existsSync(path.join(targetAgentDir, "auth.json"))).toBe(true);
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
  });

  it("auto-migrates legacy sessions on startup", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
      transcripts: {
        "a.jsonl": "a",
      },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({
      root,
      cfg,
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
    const { root, cfg } = await makeRootWithEmptyCfg();
    const oauthDir = ensureCredentialsDir(root);
    fs.writeFileSync(path.join(oauthDir, "oauth.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "creds.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "session-abc.json"), "{}", "utf-8");

    await detectAndRunMigrations({ root, cfg, now: () => 123 });

    const target = path.join(oauthDir, "whatsapp", "default");
    expect(fs.existsSync(path.join(target, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "session-abc.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "creds.json"))).toBe(false);
  });

  it("migrates legacy Telegram pairing allowFrom store to account-scoped default file", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const { oauthDir, detected, result } = await runTelegramAllowFromMigration({ root, cfg });
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => path.basename(plan.targetPath))).toEqual([
      "telegram-default-allowFrom.json",
    ]);
    expect(result.warnings).toEqual([]);

    const target = path.join(oauthDir, "telegram-default-allowFrom.json");
    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      version: 1,
      allowFrom: ["123456"],
    });
  });

  it("does not fan out legacy Telegram pairing allowFrom store to configured named accounts", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "bot2",
          accounts: {
            bot1: {},
            bot2: {},
          },
        },
      },
    };
    const { oauthDir, detected, result } = await runTelegramAllowFromMigration({ root, cfg });
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => path.basename(plan.targetPath))).toEqual([
      "telegram-bot2-allowFrom.json",
    ]);
    expect(result.warnings).toEqual([]);

    const bot1Target = path.join(oauthDir, "telegram-bot1-allowFrom.json");
    const bot2Target = path.join(oauthDir, "telegram-bot2-allowFrom.json");
    const defaultTarget = path.join(oauthDir, "telegram-default-allowFrom.json");
    expect(fs.existsSync(bot1Target)).toBe(false);
    expect(fs.existsSync(bot2Target)).toBe(true);
    expect(fs.existsSync(defaultTarget)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bot2Target, "utf-8"))).toEqual({
      version: 1,
      allowFrom: ["123456"],
    });
  });

  it("migrates legacy Telegram pairing allowFrom store to the default agent bound account", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "ops", default: true }],
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "alerts" } }],
      channels: {
        telegram: {
          accounts: {
            alerts: {},
            backup: {},
          },
        },
      },
    };

    const { oauthDir, detected, result } = await runTelegramAllowFromMigration({ root, cfg });
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => path.basename(plan.targetPath))).toEqual([
      "telegram-alerts-allowFrom.json",
    ]);
    expect(result.warnings).toEqual([]);

    const alertsTarget = path.join(oauthDir, "telegram-alerts-allowFrom.json");
    const backupTarget = path.join(oauthDir, "telegram-backup-allowFrom.json");
    const defaultTarget = path.join(oauthDir, "telegram-default-allowFrom.json");
    expect(fs.existsSync(alertsTarget)).toBe(true);
    expect(fs.existsSync(backupTarget)).toBe(false);
    expect(fs.existsSync(defaultTarget)).toBe(false);
    expect(JSON.parse(fs.readFileSync(alertsTarget, "utf-8"))).toEqual({
      version: 1,
      allowFrom: ["123456"],
    });
  });

  it("no-ops when nothing detected", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });
    expect(result.changes).toEqual([]);
  });

  it("routes legacy state to the default agent entry", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "alpha", default: true }] },
    };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
    });

    const targetDir = path.join(root, "agents", "alpha", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:alpha:main"]?.sessionId).toBe("a");
  });

  it("honors session.mainKey when seeding the direct-chat bucket", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = { session: { mainKey: "work" } };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
        "+1666": { sessionId: "b", updatedAt: 20 },
      },
    });

    const targetDir = path.join(root, "agents", "main", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("b");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("canonicalizes legacy main keys inside the target sessions store", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
      "agent:main:main": { sessionId: "fresh", updatedAt: 20 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("fresh");
  });

  it("prefers the newest entry when collapsing main aliases", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = { session: { mainKey: "work" } };
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": { sessionId: "legacy", updatedAt: 50 },
      "agent:main:work": { sessionId: "canonical", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("legacy");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("lowercases agent session keys during canonicalization", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:slack:channel:C123": { sessionId: "legacy", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("legacy");
    expect(store["agent:main:slack:channel:C123"]).toBeUndefined();
  });

  it("auto-migrates when only target sessions contain legacy keys", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("legacy");
  });

  it("does nothing when no legacy state dir exists", async () => {
    const root = await makeTempRoot();
    const result = await runStateDirMigration(root);

    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("skips state dir migration when env override is set", async () => {
    const root = await makeTempRoot();
    const { legacyDir } = getStateDirMigrationPaths(root);
    fs.mkdirSync(legacyDir, { recursive: true });

    const result = await runStateDirMigration(root, {
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv);

    expect(result.skipped).toBe(true);
    expect(result.migrated).toBe(false);
  });

  it("does not warn when legacy state dir is an already-migrated symlink mirror", async () => {
    const root = await makeTempRoot();
    const { targetDir, legacyDir } = ensureLegacyAndTargetStateDirs(root);
    fs.mkdirSync(path.join(targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(targetDir, "agent"), { recursive: true });

    fs.symlinkSync(
      path.join(targetDir, "sessions"),
      path.join(legacyDir, "sessions"),
      DIR_LINK_TYPE,
    );
    fs.symlinkSync(path.join(targetDir, "agent"), path.join(legacyDir, "agent"), DIR_LINK_TYPE);

    const result = await runStateDirMigration(root);
    expectUnmigratedWithoutWarnings(result);
  });

  it("warns when legacy state dir is empty and target already exists", async () => {
    const root = await makeTempRoot();
    const { targetDir } = ensureLegacyAndTargetStateDirs(root);

    const result = await runStateDirMigration(root);
    expectTargetAlreadyExistsWarning(result, targetDir);
  });

  it("warns when legacy state dir contains non-symlink entries and target already exists", async () => {
    const root = await makeTempRoot();
    const { targetDir, legacyDir } = ensureLegacyAndTargetStateDirs(root);
    fs.writeFileSync(path.join(legacyDir, "sessions.json"), "{}", "utf-8");

    const result = await runStateDirMigration(root);
    expectTargetAlreadyExistsWarning(result, targetDir);
  });

  it("does not warn when legacy state dir contains nested symlink mirrors", async () => {
    const root = await makeTempRoot();
    const { targetDir, legacyDir } = ensureLegacyAndTargetStateDirs(root);
    fs.mkdirSync(path.join(targetDir, "agents", "main"), { recursive: true });
    fs.mkdirSync(path.join(legacyDir, "agents"), { recursive: true });

    fs.symlinkSync(
      path.join(targetDir, "agents", "main"),
      path.join(legacyDir, "agents", "main"),
      DIR_LINK_TYPE,
    );

    const result = await runStateDirMigration(root);
    expectUnmigratedWithoutWarnings(result);
  });

  it("warns when legacy state dir symlink points outside the target tree", async () => {
    const root = await makeTempRoot();
    const { targetDir, legacyDir } = ensureLegacyAndTargetStateDirs(root);
    const outsideDir = path.join(root, ".outside-state");
    fs.mkdirSync(path.join(targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    fs.symlinkSync(path.join(outsideDir), path.join(legacyDir, "sessions"), DIR_LINK_TYPE);

    const result = await runStateDirMigration(root);
    expectTargetAlreadyExistsWarning(result, targetDir);
  });

  it("warns when legacy state dir contains a broken symlink target", async () => {
    const root = await makeTempRoot();
    const { targetDir, legacyDir } = ensureLegacyAndTargetStateDirs(root);
    fs.mkdirSync(path.join(targetDir, "sessions"), { recursive: true });

    const targetSessionDir = path.join(targetDir, "sessions");
    fs.symlinkSync(targetSessionDir, path.join(legacyDir, "sessions"), DIR_LINK_TYPE);
    fs.rmSync(targetSessionDir, { recursive: true, force: true });

    const result = await runStateDirMigration(root);
    expectTargetAlreadyExistsWarning(result, targetDir);
  });

  it("warns when legacy symlink escapes target tree through second-hop symlink", async () => {
    const root = await makeTempRoot();
    const { targetDir, legacyDir } = ensureLegacyAndTargetStateDirs(root);
    const outsideDir = path.join(root, ".outside-state");
    fs.mkdirSync(outsideDir, { recursive: true });

    const targetHop = path.join(targetDir, "hop");
    fs.symlinkSync(outsideDir, targetHop, DIR_LINK_TYPE);
    fs.symlinkSync(targetHop, path.join(legacyDir, "sessions"), DIR_LINK_TYPE);

    const result = await runStateDirMigration(root);
    expectTargetAlreadyExistsWarning(result, targetDir);
  });
});
