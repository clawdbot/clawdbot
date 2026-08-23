import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  createGitBackup: vi.fn(),
  getRuntimeConfig: vi.fn(),
  listRegisteredAgentDatabases: vi.fn(),
  recordBackupRunOutcome: vi.fn(),
  restoreGitBackupRef: vi.fn(),
  verifyGitBackupRef: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, getRuntimeConfig: mocks.getRuntimeConfig };
});

vi.mock("../snapshot/git-backup.js", () => ({
  createGitBackup: mocks.createGitBackup,
  initializeGitBackupRepository: vi.fn(),
  readGitBackupLog: vi.fn(),
  restoreGitBackupRef: mocks.restoreGitBackupRef,
  verifyGitBackupRef: mocks.verifyGitBackupRef,
}));

vi.mock("../state/backup-run-records.js", () => ({
  recordBackupRunOutcome: mocks.recordBackupRunOutcome,
}));

vi.mock("../state/openclaw-agent-db.js", () => ({
  listOpenClawRegisteredAgentDatabases: mocks.listRegisteredAgentDatabases,
}));

import {
  backupGitCreateCommand,
  backupGitRestoreCommand,
  backupGitVerifyCommand,
} from "./backup-git.js";

describe("Git backup command agent selection", () => {
  beforeEach(() => {
    mocks.createGitBackup.mockReset().mockResolvedValue({
      commit: "backup-commit",
      noChanges: false,
      pushed: false,
      repositoryPath: "/tmp/repository",
    });
    mocks.getRuntimeConfig.mockReset().mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "ops-team" }] },
    });
    mocks.listRegisteredAgentDatabases.mockReset().mockReturnValue([]);
    mocks.recordBackupRunOutcome.mockReset();
    mocks.restoreGitBackupRef.mockReset().mockResolvedValue({
      commit: "backup-commit",
      excludedTables: [],
      targetPath: "/tmp/restored.sqlite",
    });
    mocks.verifyGitBackupRef.mockReset().mockResolvedValue({
      commit: "backup-commit",
      tables: [],
    });
    vi.spyOn(fs, "realpath").mockImplementation(async (value) => path.resolve(String(value)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a backup for a configured normalized agent", async () => {
    await backupGitCreateCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      agents: ["Ops Team"],
    });

    expect(mocks.createGitBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        databases: [expect.objectContaining({ identity: { role: "agent", agentId: "ops-team" } })],
      }),
    );
  });

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    ["empty", "", "--agent must not be blank"],
    ["whitespace-only", "   ", "--agent must not be blank"],
  ])("rejects an %s Git create agent", async (_label, agent, message) => {
    await expect(
      backupGitCreateCommand(createTestRuntime(), {
        repository: "/tmp/repository",
        agents: [agent],
      }),
    ).rejects.toThrow(message);

    expect(mocks.createGitBackup).not.toHaveBeenCalled();
  });

  it.each([
    { label: "all", scope: { all: true } },
    { label: "global", scope: { global: true } },
  ])("keeps the $label Git create scope independent of configured agents", async ({ scope }) => {
    await backupGitCreateCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      ...scope,
    });

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.createGitBackup).toHaveBeenCalledOnce();
  });

  it("keeps the --all plus explicit-scope conflict ahead of agent validation", async () => {
    await expect(
      backupGitCreateCommand(createTestRuntime(), {
        repository: "/tmp/repository",
        all: true,
        agents: ["nope-agent"],
      }),
    ).rejects.toThrow("Use --all by itself, or select --global and --agent scopes explicitly.");

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.createGitBackup).not.toHaveBeenCalled();
  });

  it("keeps artifact verify and restore available for an unconfigured agent", async () => {
    await backupGitVerifyCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      agent: "retired-agent",
    });
    await backupGitRestoreCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      agent: "retired-agent",
      target: "/tmp/restored.sqlite",
    });

    expect(mocks.verifyGitBackupRef).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { role: "agent", agentId: "retired-agent" } }),
    );
    expect(mocks.restoreGitBackupRef).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { role: "agent", agentId: "retired-agent" } }),
    );
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
  });
});
