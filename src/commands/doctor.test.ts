// Doctor command tests cover probe orchestration, fix mode, and runtime command output.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSessionSqliteGithubIssue: vi.fn(),
  runPostUpgradeProbes: vi.fn(),
  runDoctorStateSqliteCompact: vi.fn(),
  runDoctorSessionSqlite: vi.fn(),
  resolveInstalledPluginIndexStorePath: vi.fn(() => "/tmp/openclaw-installed-plugins.json"),
}));

vi.mock("./doctor-post-upgrade.js", () => ({
  runPostUpgradeProbes: mocks.runPostUpgradeProbes,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  runDoctorSessionSqlite: mocks.runDoctorSessionSqlite,
}));

vi.mock("./doctor-state-sqlite-compact.js", () => ({
  runDoctorStateSqliteCompact: mocks.runDoctorStateSqliteCompact,
}));

vi.mock("./doctor-session-sqlite-github-issue.js", () => ({
  createSessionSqliteGithubIssue: mocks.createSessionSqliteGithubIssue,
}));

vi.mock("../plugins/installed-plugin-index-store-path.js", () => ({
  resolveInstalledPluginIndexStorePath: mocks.resolveInstalledPluginIndexStorePath,
}));

const { doctorCommand } = await import("./doctor.js");

describe("doctorCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes post-upgrade JSON through the runtime before exiting with findings", async () => {
    const report = {
      probesRun: ["plugin.index_unavailable"],
      findings: [
        {
          level: "error",
          code: "plugin.index_unavailable",
          message: "missing index",
        },
      ],
    };
    mocks.runPostUpgradeProbes.mockResolvedValueOnce(report);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await expect(doctorCommand(runtime, { postUpgrade: true, json: true })).rejects.toThrow(
      "exit:1",
    );

    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("writes session sqlite JSON through the runtime before exiting cleanly", async () => {
    const report = {
      mode: "inspect",
      targets: [],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 0,
        targets: 0,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    };
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await expect(
      doctorCommand(runtime, {
        json: true,
        sessionSqlite: "inspect",
        sessionSqliteAgent: "main",
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.runDoctorSessionSqlite).toHaveBeenCalledWith({
      agent: "main",
      mode: "inspect",
    });
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("writes shared-state sqlite compaction JSON through the runtime", async () => {
    const report = {
      after: {
        autoVacuum: 2,
        dbSizeBytes: 8_192,
        freelistPages: 0,
        pageSizeBytes: 4_096,
        walSizeBytes: 0,
      },
      before: {
        autoVacuum: 0,
        dbSizeBytes: 16_384,
        freelistPages: 2,
        pageSizeBytes: 4_096,
        walSizeBytes: 4_096,
      },
      integrityCheck: "ok",
      mode: "compact",
      path: "/tmp/openclaw/state/openclaw.sqlite",
      quickCheck: "ok",
      reclaimedBytes: 12_288,
      skipped: false,
    };
    mocks.runDoctorStateSqliteCompact.mockReturnValueOnce(report);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await expect(
      doctorCommand(runtime, {
        json: true,
        stateSqlite: "compact",
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.runDoctorStateSqliteCompact).toHaveBeenCalledWith();
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("creates a GitHub issue for approved session sqlite recovery reports", async () => {
    const supportIssue = {
      body: "sanitized body",
      bodyPath: "/tmp/session.failure.md",
      title: "Session SQLite migration recovery report (run-1)",
      url: "https://github.com/openclaw/openclaw/issues/new?title=run-1",
    };
    const report = {
      mode: "recover",
      supportIssue,
      targets: [],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 0,
        targets: 0,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    };
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
    mocks.createSessionSqliteGithubIssue.mockReturnValueOnce({
      ok: true,
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await expect(
      doctorCommand(runtime, {
        sessionSqlite: "recover",
        sessionSqliteGithubIssue: true,
        yes: true,
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.createSessionSqliteGithubIssue).toHaveBeenCalledWith(supportIssue);
    expect(runtime.log).toHaveBeenCalledWith(
      "session-sqlite recover: created GitHub issue https://github.com/openclaw/openclaw/issues/123",
    );
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("keeps session sqlite recovery GitHub status inside JSON output", async () => {
    const report = {
      mode: "recover",
      supportIssue: {
        body: "sanitized body",
        title: "Session SQLite migration recovery report (run-1)",
        url: "https://github.com/openclaw/openclaw/issues/new?title=run-1",
      },
      targets: [],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 0,
        targets: 0,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    };
    mocks.runDoctorSessionSqlite.mockResolvedValueOnce(report);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await expect(
      doctorCommand(runtime, {
        json: true,
        sessionSqlite: "recover",
        sessionSqliteGithubIssue: true,
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.createSessionSqliteGithubIssue).not.toHaveBeenCalled();
    expect((report.supportIssue as { github?: unknown }).github).toEqual({ status: "skipped" });
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
  });
});
