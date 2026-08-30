// Doctor session transcript tests cover transcript inspection and repair guidance.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFileBackedSessionManagerForTest } from "../../test/helpers/session-manager-file-fixture.js";

const note = vi.hoisted(() => vi.fn());
const repairReservedIncognitoSessionKeys = vi.hoisted(() => vi.fn());
const repairCanonicalSessionDeliveryStates = vi.hoisted(() => vi.fn());
const repairCanonicalSessionResolvedSkills = vi.hoisted(() => vi.fn());
const repairCanonicalSessionKeys = vi.hoisted(() => vi.fn());
const migrateLegacyMainSessionKeys = vi.hoisted(() => vi.fn());
const runDoctorSessionSqlite = vi.hoisted(() => vi.fn());
const withDoctorSqliteMaintenanceLock = vi.hoisted(() => vi.fn());
const runPostSessionPluginDoctorStateRepairs = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  runDoctorSessionSqlite,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  runPostSessionPluginDoctorStateRepairs,
}));

vi.mock("./doctor-session-incognito-key-repair.js", () => ({
  repairReservedIncognitoSessionKeys,
}));

vi.mock("./doctor-session-delivery-state.js", () => ({
  repairCanonicalSessionDeliveryStates,
  repairCanonicalSessionResolvedSkills,
}));

vi.mock("./doctor-session-exec-policy.js", () => ({
  repairLegacySessionExecPolicy: vi.fn(),
}));

vi.mock("./doctor-session-canonical-keys.js", () => ({
  repairCanonicalSessionKeys,
}));

vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys,
}));

vi.mock("./doctor-sqlite-maintenance-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-sqlite-maintenance-lock.js")>();
  return {
    ...actual,
    withDoctorSqliteMaintenanceLock,
  };
});

import { GatewayLockError } from "../infra/gateway-lock.js";
import { shortenHomePath } from "../utils.js";
import {
  detectSessionTranscriptHealthIssues,
  noteSessionTranscriptHealth,
  sessionTranscriptIssueToHealthFinding,
  sessionTranscriptIssueToRepairEffect,
} from "./doctor-session-transcripts.js";
import { DoctorSqliteMaintenanceLockUnavailableError } from "./doctor-sqlite-maintenance-lock.js";

async function repairBrokenSessionTranscriptFile(params: {
  filePath: string;
  shouldRepair: boolean;
}) {
  const [issue] = await detectSessionTranscriptHealthIssues({
    sessionDirs: [path.dirname(params.filePath)],
  });
  if (!issue) {
    return {
      filePath: params.filePath,
      broken: false,
      repaired: false,
      originalEntries: 0,
      activeEntries: 0,
      legacyOpenAICodexEntries: 0,
    };
  }
  if (!params.shouldRepair) {
    return issue;
  }

  const noteCount = note.mock.calls.length;
  await noteSessionTranscriptHealth({
    sessionDirs: [path.dirname(params.filePath)],
    shouldRepair: true,
  });
  const backupPrefix = `${path.basename(params.filePath)}.pre-doctor-`;
  const backupName = (await fs.readdir(path.dirname(params.filePath))).find(
    (entry) => entry.startsWith(backupPrefix) && entry.endsWith(".bak"),
  );
  return {
    ...issue,
    repaired: note.mock.calls
      .slice(noteCount)
      .some(([message]) =>
        String(message).includes(`${shortenHomePath(params.filePath)} repaired entries=`),
      ),
    ...(backupName ? { backupPath: path.join(path.dirname(params.filePath), backupName) } : {}),
  };
}

function countNonEmptyLines(value: string): number {
  let count = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line) {
      count += 1;
    }
  }
  return count;
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("doctor session transcript repair", () => {
  let root: string;

  beforeEach(async () => {
    note.mockClear();
    repairReservedIncognitoSessionKeys.mockReset().mockReturnValue({ found: 0, repaired: 0 });
    repairCanonicalSessionDeliveryStates
      .mockReset()
      .mockReturnValue({ found: 0, repaired: 0, scannedStores: 0 });
    repairCanonicalSessionResolvedSkills
      .mockReset()
      .mockReturnValue({ found: 0, repaired: 0, scannedStores: 0 });
    repairCanonicalSessionKeys.mockReset().mockResolvedValue({
      archivedTranscriptDirectories: [],
      foundGroups: 0,
      repairBatches: 0,
      removedRows: 0,
      repairedGroups: 0,
      scannedStores: 0,
    });
    migrateLegacyMainSessionKeys.mockReset().mockResolvedValue({
      armed: false,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [{ kind: "not-armed" }],
      warnings: [],
    });
    runDoctorSessionSqlite.mockReset();
    runPostSessionPluginDoctorStateRepairs
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    withDoctorSqliteMaintenanceLock
      .mockReset()
      .mockImplementation(
        async (params: { run: (authority: { assertCurrent(): void }) => unknown }) =>
          await params.run({ assertCurrent() {} }),
      );
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-")),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeTranscript(entries: unknown[]): Promise<string> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return filePath;
  }

  it("rewrites affected prompt-rewrite branches to the active branch", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content: [
            "visible ask",
            "",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "secret",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "plain-assistant",
        parentId: "plain-user",
        message: { role: "assistant", content: "answer" },
      },
    ]);

    if (process.platform !== "win32") {
      await fs.chmod(filePath, 0o640);
      await fs.chmod(path.dirname(filePath), 0o750);
    }
    const originalBytes = await fs.readFile(filePath);
    const originalMode = (await fs.stat(filePath)).mode;
    const directoryMode = (await fs.stat(path.dirname(filePath))).mode;

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.broken).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.originalEntries).toBe(6);
    expect(result.activeEntries).toBe(3);
    if (!("backupPath" in result) || result.backupPath === undefined) {
      throw new Error("expected transcript backup path");
    }
    await expect(fs.access(result.backupPath)).resolves.toBeUndefined();
    expect(await fs.readFile(result.backupPath)).toEqual(originalBytes);
    expect((await fs.stat(filePath)).mode).toBe(originalMode);
    expect((await fs.stat(path.dirname(filePath))).mode).toBe(directoryMode);
    const lines = (await fs.readFile(filePath, "utf-8")).trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(
      lines
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type !== "session")
        .map((entry) => entry.id),
    ).toEqual(["parent", "plain-user", "plain-assistant"]);
  });

  it.each(
    ["branch", "metadata"].flatMap((variant) =>
      ["write", "backup", "rename"].map((fault) => ({ variant, fault })),
    ),
  )(
    "preserves $variant transcript bytes and reports a $fault failure",
    async ({ variant, fault }) => {
      const filePath = await writeTranscript([
        { type: "session", version: 3, id: "session", timestamp: "2026-08-27T00:00:00Z" },
        ...(variant === "branch"
          ? [
              {
                type: "message",
                id: "runtime-user",
                parentId: null,
                message: {
                  role: "user",
                  content:
                    "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\ncontext\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
                },
              },
              {
                type: "message",
                id: "plain-user",
                parentId: null,
                message: { role: "user", content: "visible ask" },
              },
            ]
          : [
              {
                type: "message",
                message: { role: "assistant", provider: "openai-codex", content: "legacy" },
              },
            ]),
      ]);
      const originalBytes = await fs.readFile(filePath);
      const writeFile = fs.writeFile;
      const error = Object.assign(new Error(`simulated ${fault} failure`), {
        code: fault === "rename" ? "EPERM" : "ENOSPC",
      });
      const writeSpy = vi.spyOn(fs, "writeFile");
      const copySpy = vi.spyOn(fs, "copyFile");
      const renameSpy = vi.spyOn(fs, "rename");
      if (fault === "write") {
        writeSpy.mockImplementationOnce(async (file) => {
          await writeFile(file, "partial");
          throw error;
        });
      } else if (fault === "backup") {
        copySpy.mockRejectedValueOnce(error);
      } else {
        renameSpy.mockRejectedValueOnce(error);
      }
      try {
        await noteSessionTranscriptHealth({
          shouldRepair: true,
          sessionDirs: [path.dirname(filePath)],
        });
      } finally {
        writeSpy.mockRestore();
        copySpy.mockRestore();
        renameSpy.mockRestore();
      }

      expect(await fs.readFile(filePath)).toEqual(originalBytes);
      const message = note.mock.calls.map(([text]) => String(text)).join("\n");
      expect(message).toContain("repair failed");
      expect(message).toContain(error.message);
      expect(message).not.toContain("Repaired 1 transcript file");
      const files = await fs.readdir(path.dirname(filePath));
      expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
      const backups = files.filter((file) => file.endsWith(".bak"));
      expect(backups).toHaveLength(fault === "backup" ? 0 : 1);
      if (fault !== "backup") {
        const backup = expectDefined(backups[0], "repair backup");
        expect(await fs.readFile(path.join(path.dirname(filePath), backup))).toEqual(originalBytes);
        expect(message).toContain(backup);
      } else {
        expect(message).not.toContain("backup=");
      }
    },
  );

  it.each(["ENOENT", "EACCES"])(
    "does not label an unreadable file as broken after %s",
    async (code) => {
      const filePath = await writeTranscript([{ type: "session", id: "uninspected" }]);
      const readSpy = vi
        .spyOn(fs, "readFile")
        .mockRejectedValueOnce(Object.assign(new Error("unavailable transcript"), { code }));
      try {
        await noteSessionTranscriptHealth({
          shouldRepair: true,
          sessionDirs: [path.dirname(filePath)],
        });
      } finally {
        readSpy.mockRestore();
      }
      const message = note.mock.calls.map(([text]) => String(text)).join("\n");
      expect(message).not.toContain("legacy state");
      expect(message).not.toContain("repair failed");
    },
  );

  it("reports affected transcripts without rewriting outside repair mode", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        parentId: null,
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: null,
        message: { role: "user", content: "visible ask" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: false, sessionDirs: [sessionsDir] });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = requireFirstMockCall(note, "doctor note") as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("legacy state");
    expect(message).toContain('Run "openclaw doctor --fix"');
    expect(countNonEmptyLines(await fs.readFile(filePath, "utf-8"))).toBe(3);
  });

  it("maps affected transcripts to structured findings and dry-run effects", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "openai-codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    const [issue] = await detectSessionTranscriptHealthIssues({ sessionDirs: [sessionsDir] });

    if (!issue) {
      throw new Error("expected session transcript health issue");
    }
    expect(issue?.filePath).toBe(filePath);
    expect(sessionTranscriptIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/session-transcripts",
      severity: "info",
      path: filePath,
      fixHint: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(sessionTranscriptIssueToRepairEffect(issue)).toEqual({
      kind: "file",
      action: "would-rewrite-session-transcript",
      target: filePath,
      dryRunSafe: false,
    });
    expect(await fs.readFile(filePath, "utf-8")).toContain("openai-codex");
  });

  it("runs session SQLite import through the public doctor repair path", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedTranscriptEvents: 2,
        issues: 0,
        legacyEntries: 1,
        sqliteEntries: 1,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const cfg = {};

    await noteSessionTranscriptHealth({
      cfg,
      env,
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: true,
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({
      cfg,
      env,
      mode: "doctor-fix",
    });
    expect(repairReservedIncognitoSessionKeys).toHaveBeenCalledWith({ apply: true, cfg, env });
    expect(repairCanonicalSessionResolvedSkills).toHaveBeenCalledWith({ apply: true, cfg, env });
    expect(
      expectDefined(runDoctorSessionSqlite.mock.invocationCallOrder[0], "SQLite import call order"),
    ).toBeLessThan(
      expectDefined(
        migrateLegacyMainSessionKeys.mock.invocationCallOrder[0],
        "legacy-main session migration call order",
      ),
    );
    expect(
      expectDefined(
        migrateLegacyMainSessionKeys.mock.invocationCallOrder[0],
        "legacy-main session migration call order",
      ),
    ).toBeLessThan(
      expectDefined(
        repairCanonicalSessionKeys.mock.invocationCallOrder[0],
        "canonical session repair call order",
      ),
    );
    expect(
      expectDefined(
        repairCanonicalSessionKeys.mock.invocationCallOrder[0],
        "canonical session repair call order",
      ),
    ).toBeLessThan(
      expectDefined(
        repairCanonicalSessionResolvedSkills.mock.invocationCallOrder[0],
        "runtime-only skills repair call order",
      ),
    );
    expect(
      expectDefined(
        repairCanonicalSessionResolvedSkills.mock.invocationCallOrder[0],
        "runtime-only skills repair call order",
      ),
    ).toBeLessThan(
      expectDefined(
        repairReservedIncognitoSessionKeys.mock.invocationCallOrder[0],
        "reserved key repair call order",
      ),
    );
    expect(
      expectDefined(
        repairCanonicalSessionDeliveryStates.mock.invocationCallOrder[0],
        "delivery state repair call order",
      ),
    ).toBeLessThan(
      expectDefined(
        runPostSessionPluginDoctorStateRepairs.mock.invocationCallOrder[0],
        "post-session plugin repair call order",
      ),
    );
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledWith({
      config: cfg,
      env,
      maintenanceAuthority: { assertCurrent: expect.any(Function) },
    });
    expect(withDoctorSqliteMaintenanceLock).toHaveBeenCalledWith({
      env,
      operation: "session SQLite import",
      run: expect.any(Function),
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Legacy entries: 1"),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Archived 2 legacy transcript artifact(s)."),
      "Session SQLite",
    );
  });

  it("explains how to shrink SQLite files after removing persisted runtime skills", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 2,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    repairCanonicalSessionResolvedSkills.mockReturnValueOnce({
      found: 2,
      repaired: 2,
      scannedStores: 1,
    });

    await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: true,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Logical SQLite pages are freed"),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'shrinking the on-disk database requires "openclaw doctor --session-sqlite compact --session-sqlite-all-agents"',
      ),
      "Session SQLite",
    );
  });

  it("keeps session SQLite dry-run read-only without taking maintenance ownership", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 0,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const cfg = {};

    await noteSessionTranscriptHealth({
      cfg,
      env,
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: false,
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "dry-run",
    });
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({ cfg, env, mode: "detect" });
    expect(withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledWith({
      config: cfg,
      env,
      maintenanceAuthority: undefined,
    });
  });

  it("reports post-session plugin changes and actionable ownership warnings", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    runDoctorSessionSqlite.mockResolvedValueOnce({
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedTranscriptEvents: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 0,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    runPostSessionPluginDoctorStateRepairs.mockResolvedValueOnce({
      changes: ["Removed 2 orphaned plugin session bindings"],
      warnings: ["Plugin lifecycle ownership unavailable; rerun openclaw doctor --fix"],
    });

    await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      sessionDirs: [sessionsDir],
      sessionSqlite: true,
      shouldRepair: true,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Removed 2 orphaned plugin session bindings"),
      "Plugin session repair",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("rerun openclaw doctor --fix"),
      "Plugin session repair",
    );
  });

  it("skips session SQLite import when the Gateway owns the state lock", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    withDoctorSqliteMaintenanceLock.mockRejectedValueOnce(
      new DoctorSqliteMaintenanceLockUnavailableError(
        "session SQLite import",
        new GatewayLockError("gateway already running"),
      ),
    );

    await expect(
      noteSessionTranscriptHealth({
        cfg: {},
        env,
        sessionSqlite: true,
        shouldRepair: true,
      }),
    ).resolves.toBeUndefined();

    expect(runDoctorSessionSqlite).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipped: Gateway or another SQLite maintenance command owns the state directory",
      ),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('run "openclaw doctor --fix" for session-store maintenance'),
      "Session SQLite",
    );
  });

  it("keeps non-lock session SQLite import failures fatal", async () => {
    withDoctorSqliteMaintenanceLock.mockRejectedValueOnce(new Error("SQLite import failed"));

    await expect(
      noteSessionTranscriptHealth({
        cfg: {},
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        sessionSqlite: true,
        shouldRepair: true,
      }),
    ).rejects.toThrow("SQLite import failed");
  });

  it("repairs supported current-version linear transcripts", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-linear", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        timestamp: "2026-06-15T00:00:01Z",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        timestamp: "2026-06-15T00:00:02Z",
        message: { role: "user", content: "visible ask" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.map((entry) => entry.id)).toEqual(["session-linear", "plain-user"]);
  });

  it("repairs the branch selected by a terminal leaf control", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "active-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "message",
        id: "side-delivery",
        parentId: "active-assistant",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: "runtime-assistant",
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-delivery",
        targetId: "active-assistant",
        appendParentId: "plugin-metadata",
      },
      {
        type: "metadata",
        id: "post-leaf-metadata",
        parentId: "plugin-metadata",
        payload: { phase: "after-leaf" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const repaired = await fs.readFile(filePath, "utf-8");
    expect(repaired).toContain("answer");
    expect(repaired).toContain("plugin-metadata");
    expect(repaired).toContain("post-leaf-metadata");
    expect(repaired).not.toContain("side delivery");
    expect(repaired).not.toContain("secret");
    const repairedRecords = repaired
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(repairedRecords.find((entry) => entry.id === "plugin-metadata")).toMatchObject({
      parentId: "active-assistant",
    });
    const reopened = openFileBackedSessionManagerForTest(filePath, path.dirname(filePath));
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "post-leaf-metadata" });
  });

  it("preserves parentless visible history and a disjoint append cursor", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-disjoint", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "visible-parent",
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "active-user",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "visible-parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "metadata",
        id: "append-root",
        parentId: null,
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "append-root",
        targetId: "active-assistant",
        appendParentId: "append-root",
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const repaired = await fs.readFile(filePath, "utf-8");
    expect(repaired).toContain("previous");
    expect(repaired).toContain("answer");
    expect(repaired).toContain('"id":"append-root"');
    expect(repaired).not.toContain("stale");
    const reopened = openFileBackedSessionManagerForTest(filePath, path.dirname(filePath));
    expect(reopened.buildSessionContext().messages).toHaveLength(3);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "append-root" });
  });

  it("preserves an explicit root append cursor while repairing the visible branch", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-root", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "active-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "leaf",
        id: "root-append-control",
        parentId: "runtime-assistant",
        targetId: "active-assistant",
        appendParentId: null,
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    const reopened = openFileBackedSessionManagerForTest(filePath, path.dirname(filePath));
    expect(reopened.buildSessionContext().messages).toHaveLength(3);
    reopened.appendMessage({ role: "user", content: "new root", timestamp: Date.now() });
    const records = (await fs.readFile(filePath, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(records.at(-2)).toMatchObject({
      type: "leaf",
      targetId: "active-assistant",
      appendParentId: null,
    });
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: null });
  });

  it("rewrites legacy OpenAI Codex transcript metadata only during doctor repair", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "openai-codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);

    const preview = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: false });

    expect(preview.broken).toBe(true);
    expect(preview.repaired).toBe(false);
    expect(preview.legacyOpenAICodexEntries).toBe(1);
    expect(await fs.readFile(filePath, "utf-8")).toContain("openai-codex");

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.broken).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.legacyOpenAICodexEntries).toBe(1);
    const lines = (await fs.readFile(filePath, "utf-8")).trim().split(/\r?\n/);
    const assistant = JSON.parse(expectDefined(lines[1], "lines[1] test invariant"));
    expect(assistant.message.provider).toBe("openai");
    expect(assistant.message.api).toBe("openai-chatgpt-responses");
  });

  it("rewrites shipped codex transcript provider metadata", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "codex",
          api: "openai-chatgpt-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.repaired).toBe(true);
    expect(result.legacyOpenAICodexEntries).toBe(1);
    const lines = (await fs.readFile(filePath, "utf-8")).trim().split(/\r?\n/);
    const assistant = JSON.parse(expectDefined(lines[1], "lines[1] test invariant"));
    expect(assistant.message.provider).toBe("openai");
    expect(assistant.message.api).toBe("openai-chatgpt-responses");
  });

  it("ignores ordinary branch history without internal runtime context", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "branch-a",
        parentId: null,
        message: { role: "user", content: "draft A" },
      },
      {
        type: "message",
        id: "branch-b",
        parentId: null,
        message: { role: "user", content: "draft B" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.broken).toBe(false);
    expect(countNonEmptyLines(await fs.readFile(filePath, "utf-8"))).toBe(3);
  });
});
