// Doctor state integrity tests cover state directory checks, migration, and repair diagnostics.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionStorePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  captureEnv,
  deleteTestEnvValue,
  setTestEnvValue,
  withEnvAsync,
} from "../test-utils/env.js";
import {
  collectWorkspaceBackupTip,
  detectStateIntegrityHealthIssues,
  noteStateIntegrity as noteStateIntegrityRaw,
  stateIntegrityIssueToHealthFinding,
  stateIntegrityIssueToRepairEffect,
} from "./doctor-state-integrity.js";
import {
  doctorChangesText,
  hasRepairPromptMessage,
  noteMock,
  noteStateIntegrity,
  repairPromptCalls,
  runStateIntegrityText,
  setupSessionState,
  stateIntegrityText,
  withMainAgentRoster,
  writeSessionStore,
} from "./doctor-state-integrity.test-support.js";

const WORKSPACE_BACKUP_TIP =
  "- Tip: back up the agent workspace in a private git repo; keep ~/.openclaw out of git (credentials, sessions). Details: /concepts/agent-workspace#git-backup-recommended";

describe("workspace backup tip", () => {
  it("recognizes direct, deeply nested, and symlinked Git workspaces without duplicate tips", async () => {
    await withTestDir({ prefix: "openclaw-doctor-workspace-git-" }, async (tempDir) => {
      const repoRoot = path.join(tempDir, "repo");
      const nestedWorkspace = path.join(repoRoot, "agents", "direct");
      const deeplyNestedWorkspace = path.join(
        repoRoot,
        ...Array.from({ length: 12 }, (_, index) => `workspace-level-${index}`),
      );
      const linkedWorkspace = path.join(tempDir, "linked-workspace");
      const outsideWorkspace = path.parse(tempDir).root;
      const missingWorkspace = path.join(tempDir, "missing");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      fs.mkdirSync(nestedWorkspace, { recursive: true });
      fs.mkdirSync(deeplyNestedWorkspace, { recursive: true });
      fs.symlinkSync(
        nestedWorkspace,
        linkedWorkspace,
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(collectWorkspaceBackupTip(repoRoot)).toBeNull();
      expect(
        [nestedWorkspace, deeplyNestedWorkspace, linkedWorkspace]
          .map((workspaceDir) => collectWorkspaceBackupTip(workspaceDir))
          .filter((tip) => tip !== null),
      ).toEqual([]);
      expect(collectWorkspaceBackupTip(outsideWorkspace)).toBe(WORKSPACE_BACKUP_TIP);
      expect(collectWorkspaceBackupTip(missingWorkspace)).toBeNull();
    });
  });
});

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));

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

async function runStateIntegrity(cfg: OpenClawConfig) {
  const effectiveConfig = withMainAgentRoster(cfg);
  setupSessionState(effectiveConfig, process.env, process.env.HOME ?? "");
  const confirmRuntimeRepair = vi.fn(async () => false);
  await noteStateIntegrity(effectiveConfig, { confirmRuntimeRepair, note: noteMock });
  return confirmRuntimeRepair;
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
    noteMock.mockClear();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
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

  it("accepts missing session directories on a fresh RPC-onboarded profile", () => {
    const stateDir = path.join(tempHome, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const cfg = withMainAgentRoster({});

    const sessionIssues = detectStateIntegrityHealthIssues(cfg).filter(
      (issue) =>
        "label" in issue && (issue.label === "Sessions dir" || issue.label === "Session store dir"),
    );

    expect(sessionIssues).toEqual([]);
  });

  it("does not warn or prompt for missing session directories", async () => {
    const stateDir = path.join(tempHome, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const confirmRuntimeRepair = vi.fn(async () => false);

    await noteStateIntegrityRaw(withMainAgentRoster({}), {
      confirmRuntimeRepair,
      note: noteMock,
    });

    expect(stateIntegrityText()).not.toMatch(
      /CRITICAL: (?:Sessions dir|Session store dir) missing/,
    );
    expect(repairPromptCalls(confirmRuntimeRepair)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/^Create (?:Sessions dir|Session store dir) at/),
        }),
      ]),
    );
  });

  it("reports an existing session directory that is not writable", () => {
    const stateDir = path.join(tempHome, ".openclaw");
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    const storePath = path.join(stateDir, "custom-store", "sessions.json");
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const accessSync = fs.accessSync;
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
      if (target === sessionsDir) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return accessSync(target, mode);
    });

    let issues: ReturnType<typeof detectStateIntegrityHealthIssues>;
    try {
      issues = detectStateIntegrityHealthIssues(
        withMainAgentRoster({ session: { store: storePath } }),
      );
    } finally {
      accessSpy.mockRestore();
    }

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime-dir-not-writable",
          label: "Sessions dir",
          path: sessionsDir,
        }),
      ]),
    );
  });
});

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
    closeOpenClawAgentDatabasesForTest();
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

  it("protects the shared legacy main auth-store dir for an ops-only roster", async () => {
    createAgentDir("main");

    const text = await runStateIntegrityText({
      agents: {
        entries: { ops: { default: true } },
      },
    });

    expect(text).not.toContain("without a matching agents.list entry");
    expect(text).not.toContain("Examples: main");
  });

  it("reports a removed main directory once shared auth ownership is relocated", async () => {
    createAgentDir("main");
    writeConfigMachineState("auth.sharedStore", { location: "state-db" });

    const text = await runStateIntegrityText({
      agents: {
        entries: { ops: { default: true } },
      },
    });

    expect(text).toContain("without a matching agents.list entry");
    expect(text).toContain("Examples: main");
  });

  it("does not let OPENCLAW_AGENT_DIR hide an unconfigured agent dir", async () => {
    createAgentDir("legacy");
    writeConfigMachineState("auth.sharedStore", { location: "state-db" });
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

    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
      string,
      { abortedLastRun?: boolean; updatedAt?: number }
    >;
    expect(persisted[sessionKey]?.abortedLastRun).toBe(false);
    expect(persisted[sessionKey]?.updatedAt).toBeGreaterThan(0);
    expect(doctorChangesText()).toContain("Cleared aborted restart-recovery flags");
  });

  it("checks case-mismatched agent dirs using native filesystem reachability", async () => {
    createAgentDir("Research");
    const configuredAgentDirExists = fs.existsSync(
      path.join(process.env.OPENCLAW_STATE_DIR ?? "", "agents", "research", "agent"),
    );

    const text = await runStateIntegrityText({
      agents: {
        list: [{ id: "main", default: true }, { id: "research" }],
      },
    });

    expect(text.includes("without a matching agents.list entry")).toBe(!configuredAgentDirExists);
    expect(text.includes("Examples: Research (id research)")).toBe(!configuredAgentDirExists);
  });
});

describe("doctor state directory discovery", () => {
  it.each([
    { homeSource: "HOME", activeDefault: false, defaultExists: true, warns: true },
    { homeSource: "HOME", activeDefault: true, defaultExists: true, warns: false },
    { homeSource: "HOME", activeDefault: false, defaultExists: false, warns: false },
    { homeSource: "USERPROFILE", activeDefault: false, defaultExists: true, warns: true },
    { homeSource: "OPENCLAW_HOME", activeDefault: false, defaultExists: true, warns: true },
    { homeSource: "OPENCLAW_HOME", activeDefault: false, defaultExists: false, warns: false },
  ])(
    "compares only the effective home ($homeSource, activeDefault=$activeDefault, defaultExists=$defaultExists)",
    async ({ homeSource, activeDefault, defaultExists, warns }) => {
      await withTestDir({ prefix: "openclaw-doctor-discovery-" }, async (root) => {
        const osHome = path.join(root, "os-home");
        const effectiveHome =
          homeSource === "OPENCLAW_HOME" ? path.join(root, "relocated") : osHome;
        const defaultState = path.join(effectiveHome, ".openclaw");
        const activeState = activeDefault ? defaultState : path.join(root, "selected-state");
        fs.mkdirSync(activeState, { recursive: true, mode: 0o700 });
        if (defaultExists) {
          fs.mkdirSync(defaultState, { recursive: true, mode: 0o700 });
        }
        if (homeSource === "OPENCLAW_HOME") {
          fs.mkdirSync(path.join(osHome, ".openclaw"), { recursive: true, mode: 0o700 });
        }
        await withEnvAsync(
          {
            HOME: homeSource === "USERPROFILE" ? undefined : osHome,
            USERPROFILE: osHome,
            OPENCLAW_HOME: homeSource === "OPENCLAW_HOME" ? effectiveHome : undefined,
            OPENCLAW_STATE_DIR: activeState,
            OPENCLAW_AGENT_DIR: undefined,
            OPENCLAW_OAUTH_DIR: undefined,
          },
          async () => {
            const attemptedProbes: string[] = [];
            const readdir = fs.readdirSync;
            const exists = fs.existsSync;
            const stat = fs.statSync;
            const isSiblingPath = (target: fs.PathLike) => {
              const targetPath = path.resolve(String(target));
              return (
                /^\/(?:Users|home)(?:\/|$)/u.test(targetPath) &&
                targetPath !== root &&
                !targetPath.startsWith(`${root}${path.sep}`)
              );
            };
            // Fence real account roots, but record every attempt so the old scanner fails.
            const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation((target, options) => {
              if (isSiblingPath(target)) {
                attemptedProbes.push(`readdir ${String(target)}`);
                throw new Error("account-root enumeration is outside Doctor's state scope");
              }
              return readdir(target, options);
            });
            const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((target) => {
              if (isSiblingPath(target)) {
                attemptedProbes.push(`exists ${String(target)}`);
                return false;
              }
              return exists(target);
            });
            const statSpy = vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
              if (isSiblingPath(target)) {
                attemptedProbes.push(`stat ${String(target)}`);
                throw new Error("sibling-account metadata is outside Doctor's state scope");
              }
              return stat(target, options);
            });
            noteMock.mockClear();
            try {
              await noteStateIntegrityRaw(withMainAgentRoster({}), {
                confirmRuntimeRepair: vi.fn(async () => false),
                note: noteMock,
              });
              const text = stateIntegrityText();
              expect(attemptedProbes).toEqual([]);
              expect(text.includes("Multiple state directories detected")).toBe(warns);
              if (warns) {
                expect(text).toContain(
                  homeSource === "OPENCLAW_HOME"
                    ? "  - $OPENCLAW_HOME/.openclaw"
                    : "  - ~/.openclaw",
                );
                expect(text).toContain(`Active state dir: ${activeState}`);
              }
              expect(text).toContain("OAuth dir not present");
            } finally {
              readdirSpy.mockRestore();
              existsSpy.mockRestore();
              statSpy.mockRestore();
              closeOpenClawAgentDatabasesForTest();
              closeOpenClawStateDatabaseForTest();
            }
          },
        );
      });
    },
  );
});
