// Doctor state integrity tests cover state directory checks, migration, and repair diagnostics.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveStorePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
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
  detectStateIntegrityHealthIssues,
  noteStateIntegrity,
  stateIntegrityIssueToHealthFinding,
  stateIntegrityIssueToRepairEffect,
} from "./doctor-state-integrity.js";

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));

const noteMock = vi.fn();

function setupSessionState(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, homeDir: string) {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, () => homeDir);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
}

function stateIntegrityText(): string {
  return noteMock.mock.calls
    .filter((call) => call[1] === "State integrity")
    .map((call) => String(call[0]))
    .join("\n");
}

function doctorChangesText(): string {
  return noteMock.mock.calls
    .filter((call) => call[1] === "Doctor changes")
    .map((call) => String(call[0]))
    .join("\n");
}

function createAgentDir(agentId: string, includeNestedAgentDir = true) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is not set");
  }
  const targetDir = includeNestedAgentDir
    ? path.join(stateDir, "agents", agentId, "agent")
    : path.join(stateDir, "agents", agentId);
  fs.mkdirSync(targetDir, { recursive: true });
}

type RuntimeRepairPrompt = {
  initialValue?: boolean;
  message?: string;
  requiresInteractiveConfirmation?: boolean;
};

function repairPromptCalls(confirmRuntimeRepair: {
  mock: { calls: unknown[][] };
}): RuntimeRepairPrompt[] {
  return confirmRuntimeRepair.mock.calls.map((call) => call[0] as RuntimeRepairPrompt);
}

function hasRepairPromptMessage(
  confirmRuntimeRepair: { mock: { calls: unknown[][] } },
  text: string,
): boolean {
  return repairPromptCalls(confirmRuntimeRepair).some((prompt) => prompt.message?.includes(text));
}

async function runStateIntegrity(cfg: OpenClawConfig) {
  setupSessionState(cfg, process.env, process.env.HOME ?? "");
  const confirmRuntimeRepair = vi.fn(async () => false);
  await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });
  return confirmRuntimeRepair;
}

function writeSessionStore(
  cfg: OpenClawConfig,
  sessions: Record<string, { sessionId: string; updatedAt: number } & Record<string, unknown>>,
) {
  setupSessionState(cfg, process.env, process.env.HOME ?? "");
  const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
  fs.writeFileSync(storePath, JSON.stringify(sessions, null, 2));
}

async function runStateIntegrityText(cfg: OpenClawConfig): Promise<string> {
  await noteStateIntegrity(cfg, { confirmRuntimeRepair: vi.fn(async () => false), note: noteMock });
  return stateIntegrityText();
}

describe("structured state integrity findings", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-state-integrity-"));
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("maps a missing state directory to a structured finding and dry-run effect", () => {
    const issue = detectStateIntegrityHealthIssues({}).find(
      (candidate) => candidate.kind === "missing-state-dir",
    );
    if (!issue) {
      throw new Error("expected missing state directory issue");
    }

    expect(issue).toEqual({
      kind: "missing-state-dir",
      path: path.join(tempHome, ".openclaw"),
    });
    expect(stateIntegrityIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/state-integrity",
      severity: "error",
      path: path.join(tempHome, ".openclaw"),
      fixHint: "Run `openclaw doctor --fix` to create the state directory.",
    });
    expect(stateIntegrityIssueToRepairEffect(issue)).toEqual({
      kind: "state",
      action: "would-create-state-dir",
      target: path.join(tempHome, ".openclaw"),
      dryRunSafe: false,
    });
  });

  it("reports permissive state and config file permissions as structured findings", () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = path.join(tempHome, ".openclaw");
    const configPath = path.join(tempHome, "openclaw.json");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(stateDir, 0o755);
    fs.writeFileSync(configPath, "{}\n", { mode: 0o644 });
    fs.chmodSync(configPath, 0o644);

    const findings = detectStateIntegrityHealthIssues({}, { configPath }).map(
      stateIntegrityIssueToHealthFinding,
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "core/doctor/state-integrity",
          severity: "warning",
          path: stateDir,
          message: "State directory permissions are too open. Recommend chmod 700.",
        }),
        expect.objectContaining({
          checkId: "core/doctor/state-integrity",
          severity: "warning",
          path: configPath,
          message: "Config file is group/world readable. Recommend chmod 600.",
        }),
      ]),
    );
  });

  it("keeps checking config permissions when the state directory is missing", () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = path.join(tempHome, ".openclaw");
    const configPath = path.join(tempHome, "openclaw.json");
    fs.writeFileSync(configPath, "{}\n", { mode: 0o644 });
    fs.chmodSync(configPath, 0o644);

    const findings = detectStateIntegrityHealthIssues({}, { configPath }).map(
      stateIntegrityIssueToHealthFinding,
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "core/doctor/state-integrity",
          severity: "error",
          path: stateDir,
          message:
            "State directory is missing. Sessions, credentials, logs, and config are stored there.",
        }),
        expect.objectContaining({
          checkId: "core/doctor/state-integrity",
          severity: "warning",
          path: configPath,
          message: "Config file is group/world readable. Recommend chmod 600.",
        }),
      ]),
    );
    expect(findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "core/doctor/state-integrity",
          message: expect.stringContaining("runtime directory is missing"),
        }),
      ]),
    );
  });
});

async function runOrphanTranscriptCheckWithQmdSessions(enabled: boolean, homeDir: string) {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {},
    },
    memory: {
      backend: "qmd",
      qmd: {
        sessions: { enabled },
      },

      search: { rememberAcrossConversations: false },
    },
  };
  setupSessionState(cfg, process.env, homeDir);
  const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => homeDir);
  fs.writeFileSync(path.join(sessionsDir, "orphan-session.jsonl"), '{"type":"session"}\n');
  const confirmRuntimeRepair = vi.fn(async () => false);
  await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });
  return confirmRuntimeRepair;
}

describe("doctor state integrity oauth dir checks", () => {
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
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("does not prompt for oauth dir when no whatsapp/pairing config is active", async () => {
    const cfg: OpenClawConfig = {};
    const confirmRuntimeRepair = await runStateIntegrity(cfg);
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Create OAuth dir at")).toBe(false);
    const text = stateIntegrityText();
    expect(text).toContain("OAuth dir not present");
    expect(text).not.toContain("CRITICAL: OAuth dir missing");
  });

  it("does not prompt for oauth dir when whatsapp is configured without persisted auth state", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {},
      },
    };
    const confirmRuntimeRepair = await runStateIntegrity(cfg);
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Create OAuth dir at")).toBe(false);
    expect(stateIntegrityText()).toContain("OAuth dir not present");
    expect(stateIntegrityText()).not.toContain("CRITICAL: OAuth dir missing");
  });

  it("prompts for oauth dir when a channel dmPolicy is pairing", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    };
    const confirmRuntimeRepair = await runStateIntegrity(cfg);
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Create OAuth dir at")).toBe(true);
  });

  it("prompts for oauth dir when OPENCLAW_OAUTH_DIR is explicitly configured", async () => {
    process.env.OPENCLAW_OAUTH_DIR = path.join(tempHome, ".oauth");
    const cfg: OpenClawConfig = {};
    const confirmRuntimeRepair = await runStateIntegrity(cfg);
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Create OAuth dir at")).toBe(true);
    expect(stateIntegrityText()).toContain("CRITICAL: OAuth dir missing");
  });

  it("warns about orphaned on-disk agent directories missing from agents.list", async () => {
    createAgentDir("big-brain");
    createAgentDir("cerebro");

    const text = await runStateIntegrityText({
      agents: {
        list: [{ id: "main", default: true }],
      },
    });

    expect(text).toContain("without a matching agents.list entry");
    expect(text).toContain("Examples: big-brain, cerebro");
    expect(text).toContain("config-driven routing, identity, and model selection will ignore them");
  });

  it("detects orphaned agent dirs even when the on-disk folder casing differs", async () => {
    createAgentDir("Research");

    const text = await runStateIntegrityText({
      agents: {
        list: [{ id: "main", default: true }],
      },
    });

    expect(text).toContain("without a matching agents.list entry");
    expect(text).toContain("Examples: Research (id research)");
  });

  it("ignores configured agent dirs and incomplete agent folders", async () => {
    createAgentDir("main");
    createAgentDir("ops");
    createAgentDir("staging", false);

    const text = await runStateIntegrityText({
      agents: {
        list: [{ id: "main", default: true }, { id: "ops" }],
      },
    });

    expect(text).not.toContain("without a matching agents.list entry");
    expect(text).not.toContain("Examples:");
  });

  it("reports an unconfigured main agent dir after compatibility removal", async () => {
    createAgentDir("main");

    const text = await runStateIntegrityText({
      agents: {
        list: [{ id: "jeremiah", default: true }],
      },
    });

    expect(text).toContain("without a matching agents.list entry");
    expect(text).toContain("Examples: main");
  });

  it("does not let OPENCLAW_AGENT_DIR hide an unconfigured agent dir", async () => {
    createAgentDir("legacy");
    const legacyAgentDir = path.join(
      process.env.OPENCLAW_STATE_DIR ?? "",
      "agents",
      "legacy",
      "agent",
    );
    setTestEnvValue("OPENCLAW_AGENT_DIR", legacyAgentDir);

    const text = await runStateIntegrityText({
      agents: {
        list: [{ id: "main", default: true }],
      },
    });

    expect(text).toContain("without a matching agents.list entry");
    expect(text).toContain("Examples: legacy");
  });

  it("warns about tombstoned subagent restart recovery sessions", async () => {
    const cfg: OpenClawConfig = {};
    writeSessionStore(cfg, {
      "agent:main:subagent:wedged-child": {
        sessionId: "session-wedged-child",
        updatedAt: Date.now(),
        abortedLastRun: true,
        subagentRecovery: {
          automaticAttempts: 2,
          lastAttemptAt: Date.now() - 30_000,
          lastRunId: "run-wedged-child",
          wedgedAt: Date.now() - 20_000,
          wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
        },
      },
    });

    const confirmRuntimeRepair = vi.fn(async () => false);
    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const text = stateIntegrityText();
    expect(text).toContain("automatic restart recovery tombstoned");
    expect(text).toContain("agent:main:subagent:wedged-child");
    expect(text).toContain("openclaw tasks maintenance --apply");
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Clear stale aborted recovery flags")).toBe(
      true,
    );
  });

  it("clears stale aborted recovery flags for tombstoned subagent sessions when approved", async () => {
    const cfg: OpenClawConfig = {};
    const sessionKey = "agent:main:subagent:wedged-child";
    writeSessionStore(cfg, {
      [sessionKey]: {
        sessionId: "session-wedged-child",
        updatedAt: 0,
        abortedLastRun: true,
        subagentRecovery: {
          automaticAttempts: 2,
          lastAttemptAt: Date.now() - 30_000,
          lastRunId: "run-wedged-child",
          wedgedAt: Date.now() - 20_000,
          wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
        },
      },
    });

    const confirmRuntimeRepair = vi.fn(async (params: { message: string }) =>
      params.message.includes("Clear stale aborted recovery flags"),
    );
    await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });

    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
      string,
      { abortedLastRun?: boolean; updatedAt?: number }
    >;
    expect(persisted[sessionKey]?.abortedLastRun).toBe(false);
    expect(persisted[sessionKey]?.updatedAt).toBeGreaterThan(0);
    expect(doctorChangesText()).toContain("Cleared aborted restart-recovery flags");
  });

  it("warns when a case-mismatched agent dir does not resolve to the configured agent path", async () => {
    createAgentDir("Research");

    const realpathNative = fs.realpathSync.native.bind(fs.realpathSync);
    const realpathSpy = vi
      .spyOn(fs.realpathSync, "native")
      .mockImplementation((target, options) => {
        const targetPath = String(target);
        if (targetPath.endsWith(`${path.sep}agents${path.sep}research${path.sep}agent`)) {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        return realpathNative(target, options);
      });

    try {
      const text = await runStateIntegrityText({
        agents: {
          list: [{ id: "main", default: true }, { id: "research" }],
        },
      });

      expect(text).toContain("without a matching agents.list entry");
      expect(text).toContain("Examples: Research (id research)");
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("does not warn when a case-mismatched dir resolves to the configured agent path", async () => {
    createAgentDir("Research");

    const realpathNative = fs.realpathSync.native.bind(fs.realpathSync);
    const resolvedResearchAgentDir = realpathNative(
      path.join(process.env.OPENCLAW_STATE_DIR ?? "", "agents", "Research", "agent"),
    );
    const realpathSpy = vi
      .spyOn(fs.realpathSync, "native")
      .mockImplementation((target, options) => {
        const targetPath = String(target);
        if (targetPath.endsWith(`${path.sep}agents${path.sep}research${path.sep}agent`)) {
          return resolvedResearchAgentDir;
        }
        return realpathNative(target, options);
      });

    try {
      const text = await runStateIntegrityText({
        agents: {
          list: [{ id: "main", default: true }, { id: "research" }],
        },
      });

      expect(text).not.toContain("without a matching agents.list entry");
      expect(text).not.toContain("Examples:");
    } finally {
      realpathSpy.mockRestore();
    }
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

  it("suppresses orphan transcript warnings when QMD sessions are enabled", async () => {
    const confirmRuntimeRepair = await runOrphanTranscriptCheckWithQmdSessions(true, tempHome);

    expect(stateIntegrityText()).not.toContain(
      "These .jsonl files are no longer referenced by sessions.json",
    );
    expect(confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("still detects orphan transcripts when QMD sessions are disabled", async () => {
    const confirmRuntimeRepair = await runOrphanTranscriptCheckWithQmdSessions(false, tempHome);

    expect(stateIntegrityText()).toContain(
      "These .jsonl files are no longer referenced by sessions.json",
    );
    expect(confirmRuntimeRepair).toHaveBeenCalled();
  });

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
    expect(text).toMatch(/openclaw sessions --store ".*sessions\.json"/);
    expect(text).toMatch(
      /openclaw sessions cleanup --store ".*sessions\.json" --dry-run --fix-missing/,
    );
    expect(text).not.toMatch(
      /openclaw sessions cleanup --store ".*sessions\.json" --dry-run(?! --fix-missing)/,
    );
    expect(text).toMatch(
      /openclaw sessions cleanup --store ".*sessions\.json" --enforce --fix-missing/,
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

    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
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

    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
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

    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
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
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
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
