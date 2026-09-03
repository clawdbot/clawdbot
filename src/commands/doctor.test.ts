// Doctor command tests cover probe orchestration, fix mode, and runtime command output.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  promptYesNo: vi.fn(),
  runPostUpgradeProbes: vi.fn(),
  runDoctorStateSqliteCompact: vi.fn(),
  runDoctorSessionSqlite: vi.fn(),
  submitGithubIssue: vi.fn(),
  withDoctorSqliteMaintenanceLock: vi.fn(),
  resolveInstalledPluginIndexStorePath: vi.fn(() => "/tmp/openclaw-installed-plugins.json"),
}));

vi.mock("./doctor-post-upgrade.js", () => ({
  runPostUpgradeProbes: mocks.runPostUpgradeProbes,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  runDoctorSessionSqlite: mocks.runDoctorSessionSqlite,
  reconcileDoctorSessionSqlitePublication: vi.fn(),
}));

vi.mock("./doctor-state-sqlite-compact.js", () => ({
  runDoctorStateSqliteCompact: mocks.runDoctorStateSqliteCompact,
}));

vi.mock("./doctor-sqlite-maintenance-lock.js", () => ({
  isDestructiveDoctorSessionSqliteMode: (mode: string) =>
    mode === "import" || mode === "compact" || mode === "restore" || mode === "recover",
  withDoctorSqliteMaintenanceLock: mocks.withDoctorSqliteMaintenanceLock,
}));

vi.mock("../infra/github-issue.js", () => ({
  prepareGithubIssue: (input: { body: string; title: string }) => ({
    ...input,
    browserFallback: {
      status: "available",
      url: "https://github.com/openclaw/openclaw/issues/new?title=run-1",
    },
    marker: `openclaw-report:${"a".repeat(64)}`,
  }),
  submitGithubIssue: mocks.submitGithubIssue,
}));

vi.mock("../infra/browser-open.js", () => ({
  openUrl: mocks.openUrl,
}));

vi.mock("../cli/prompt.js", () => ({
  promptYesNo: mocks.promptYesNo,
}));

vi.mock("../plugins/installed-plugin-index-store-path.js", () => ({
  resolveInstalledPluginIndexStorePath: mocks.resolveInstalledPluginIndexStorePath,
}));

const { doctorCommand } = await import("./doctor.js");

describe("doctorCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDoctorSqliteMaintenanceLock.mockImplementation(
      async (params: { run: (authority: { assertCurrent(): void }) => unknown }) =>
        await params.run({ assertCurrent() {} }),
    );
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
    expect(mocks.withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("holds exclusive state ownership for destructive session sqlite modes", async () => {
    const report = {
      mode: "restore",
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
        sessionSqlite: "restore",
        sessionSqliteAllAgents: true,
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.withDoctorSqliteMaintenanceLock).toHaveBeenCalledWith({
      env: process.env,
      operation: "session SQLite restore",
      reconcileHardlink: expect.any(Function),
      run: expect.any(Function),
    });
    expect(mocks.runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      mode: "restore",
    });
  });

  it("binds explicit destructive session stores to the maintenance lock", async () => {
    const report = {
      mode: "compact",
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
    const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR ?? ".openclaw");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sqlitePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");

    await expect(
      doctorCommand(runtime, {
        sessionSqlite: "compact",
        sessionSqliteStore: storePath,
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.withDoctorSqliteMaintenanceLock).toHaveBeenCalledWith({
      env: process.env,
      operation: "session SQLite compact",
      protectedPaths: [
        storePath,
        sqlitePath,
        `${sqlitePath}-wal`,
        `${sqlitePath}-shm`,
        `${sqlitePath}-journal`,
      ],
      run: expect.any(Function),
    });
  });

  it("rejects an explicit store combined with all agents before taking maintenance ownership", async () => {
    await expect(
      doctorCommand(undefined, {
        sessionSqlite: "compact",
        sessionSqliteAllAgents: true,
        sessionSqliteStore: path.resolve("stores", "{agentId}", "sessions.json"),
      }),
    ).rejects.toThrow("--store cannot be combined with --all-agents");

    expect(mocks.withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
    expect(mocks.runDoctorSessionSqlite).not.toHaveBeenCalled();
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
      reclaimedBytes: 12_288,
      skipped: false,
    };
    mocks.runDoctorStateSqliteCompact.mockResolvedValueOnce(report);
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
    mocks.submitGithubIssue.mockResolvedValueOnce({
      status: "created",
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

    expect(mocks.submitGithubIssue).toHaveBeenCalledWith({
      body: supportIssue.body,
      browserFallback: {
        status: "available",
        url: "https://github.com/openclaw/openclaw/issues/new?title=run-1",
      },
      marker: `openclaw-report:${"a".repeat(64)}`,
      title: supportIssue.title,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "session-sqlite recover: created GitHub issue https://github.com/openclaw/openclaw/issues/123",
    );
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("opens a sanitized fallback without logging its body or query URL", async () => {
    const fallbackUrl =
      "https://github.com/openclaw/openclaw/issues/new?title=run-1&body=private-report-text";
    const supportIssue = {
      body: "private-report-text",
      title: "Session SQLite migration recovery report (run-1)",
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
    mocks.submitGithubIssue.mockResolvedValueOnce({
      reason: "authentication-unavailable",
      status: "browser-fallback",
      url: fallbackUrl,
    });
    mocks.openUrl.mockResolvedValueOnce(true);
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

    expect(mocks.openUrl).toHaveBeenCalledWith(fallbackUrl);
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("opened the sanitized fallback in your browser");
    expect(output).not.toContain("private-report-text");
    expect(output).not.toContain("issues/new?");
    expect((supportIssue as { github?: unknown }).github).toEqual({
      message: "GitHub authentication is unavailable.",
      status: "failed",
    });
  });

  it("keeps a failed browser handoff URL out of JSON output", async () => {
    const fallbackUrl =
      "https://github.com/openclaw/openclaw/issues/new?title=run-1&body=private-report-text";
    const supportIssue = {
      body: "private-report-text",
      title: "Session SQLite migration recovery report (run-1)",
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
    mocks.submitGithubIssue.mockResolvedValueOnce({
      reason: "transport-unavailable",
      status: "browser-fallback",
      url: fallbackUrl,
    });
    mocks.openUrl.mockResolvedValueOnce(false);
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
        yes: true,
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.openUrl).toHaveBeenCalledWith(fallbackUrl);
    expect(runtime.log).not.toHaveBeenCalled();
    expect((supportIssue as { github?: unknown }).github).toEqual({
      message: "GitHub issue creation is unavailable.",
      status: "failed",
    });
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    const jsonOutput = JSON.stringify(runtime.writeJson.mock.calls);
    expect(jsonOutput).toContain("private-report-text");
    expect(jsonOutput).not.toContain("issues/new?");
    expect(jsonOutput).not.toContain(fallbackUrl);
  });

  it("keeps an oversized fallback in the recovery result without opening a browser", async () => {
    const supportIssue = {
      body: "private-report-text".repeat(1_000),
      title: "Session SQLite migration recovery report (run-1)",
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
    mocks.submitGithubIssue.mockResolvedValueOnce({
      cause: "authentication-unavailable",
      reason: "fallback-url-too-long",
      status: "fallback-unavailable",
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

    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(supportIssue.body).toContain("private-report-text");
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("too large for a safe browser fallback");
    expect(output).not.toContain("private-report-text");
    expect(output).not.toContain("openclaw ");
    expect((supportIssue as { github?: unknown }).github).toEqual({
      message:
        "GitHub issue creation is unavailable, and this report is too large for a safe browser fallback.",
      status: "failed",
    });
  });

  it("keeps session sqlite recovery GitHub status inside JSON output", async () => {
    const report = {
      mode: "recover",
      supportIssue: {
        body: "sanitized body",
        title: "Session SQLite migration recovery report (run-1)",
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

    expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
    expect((report.supportIssue as { github?: unknown }).github).toEqual({ status: "skipped" });
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(report, 2);
    expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain("issues/new?");
  });

  it("does not start issue transport when the operator declines", async () => {
    const supportIssue = {
      body: "sanitized body",
      title: "Session SQLite migration recovery report (run-1)",
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
    mocks.promptYesNo.mockResolvedValueOnce(false);
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
      }),
    ).rejects.toThrow("exit:0");

    expect(mocks.promptYesNo).toHaveBeenCalledWith(
      "Create a GitHub issue in openclaw/openclaw with the sanitized recovery report?",
      false,
    );
    expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect((supportIssue as { github?: unknown }).github).toEqual({ status: "skipped" });
  });
});
