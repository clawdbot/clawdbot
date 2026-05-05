import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveStorePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import { noteStateIntegrity } from "./doctor-state-integrity.js";

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));

const noteMock = vi.fn();

type EnvSnapshot = {
  HOME?: string;
  OPENCLAW_HOME?: string;
  OPENCLAW_STATE_DIR?: string;
  OPENCLAW_OAUTH_DIR?: string;
};

function captureEnv(): EnvSnapshot {
  return {
    HOME: process.env.HOME,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_OAUTH_DIR: process.env.OPENCLAW_OAUTH_DIR,
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

const OAUTH_PROMPT_MATCHER = expect.objectContaining({
  message: expect.stringContaining("Create OAuth dir at"),
});

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

async function runOrphanTranscriptCheckWithQmdSessions(enabled: boolean, homeDir: string) {
  const cfg: OpenClawConfig = {
    memory: {
      backend: "qmd",
      qmd: {
        sessions: { enabled },
      },
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
  let envSnapshot: EnvSnapshot;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-state-integrity-"));
    process.env.HOME = tempHome;
    process.env.OPENCLAW_HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
    delete process.env.OPENCLAW_OAUTH_DIR;
    fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
    noteMock.mockClear();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("does not prompt for oauth dir when no whatsapp/pairing config is active", async () => {
    const cfg: OpenClawConfig = {};
    const confirmRuntimeRepair = await runStateIntegrity(cfg);
    expect(confirmRuntimeRepair).not.toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
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
    expect(confirmRuntimeRepair).not.toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
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
    expect(confirmRuntimeRepair).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
  });

  it("prompts for oauth dir when OPENCLAW_OAUTH_DIR is explicitly configured", async () => {
    process.env.OPENCLAW_OAUTH_DIR = path.join(tempHome, ".oauth");
    const cfg: OpenClawConfig = {};
    const confirmRuntimeRepair = await runStateIntegrity(cfg);
    expect(confirmRuntimeRepair).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
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
    expect(confirmRuntimeRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Clear stale aborted recovery flags"),
      }),
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
    expect(confirmRuntimeRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("This only renames them to *.deleted.<timestamp>."),
        requiresInteractiveConfirmation: true,
      }),
    );
    const files = fs.readdirSync(sessionsDir);
    expect(files.some((name) => name.startsWith("orphan-session.jsonl.deleted."))).toBe(true);
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

    expect(confirmRuntimeRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: false,
        requiresInteractiveConfirmation: true,
      }),
    );
    const files = fs.readdirSync(sessionsDir);
    expect(files).toContain("orphan-session.jsonl");
    expect(files.some((name) => name.startsWith("orphan-session.jsonl.deleted."))).toBe(false);
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
        process.env.HOME = symlinkHome;
        process.env.OPENCLAW_HOME = symlinkHome;
        process.env.OPENCLAW_STATE_DIR = path.join(symlinkHome, ".openclaw");

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
        expect(fs.readdirSync(sessionsDir).some((name) => name.includes(".deleted."))).toBe(false);
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
    expect(text).toMatch(/openclaw sessions cleanup --store ".*sessions\.json" --dry-run/);
    expect(text).toMatch(
      /openclaw sessions cleanup --store ".*sessions\.json" --enforce --fix-missing/,
    );
    expect(text).not.toContain("--active");
    expect(text).not.toContain(" ls ");
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
