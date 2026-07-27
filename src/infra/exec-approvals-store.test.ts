import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
} from "./exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import {
  ensureExecApprovals,
  loadExecApprovals,
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshot,
  restoreExecApprovalsSnapshotLocked,
  saveExecApprovals,
  updateExecApprovals,
  withAgentExecApprovalsRemoved,
} from "./exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "./exec-approvals-store.test-support.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: (name: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: name === "infra/exec-approvals" ? loggerWarn : vi.fn(),
    error: vi.fn(),
  }),
}));

type ExecApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "exec_approvals_config">;

const tempDirs: string[] = [];
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

function createStateDir(): string {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-approvals-db-")));
  tempDirs.push(stateDir);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

function row() {
  return executeSqliteQueryTakeFirstSync(
    openOpenClawStateDatabase().db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(openOpenClawStateDatabase().db)
      .selectFrom("exec_approvals_config")
      .selectAll()
      .where("config_key", "=", "current"),
  );
}

function makeStateDatabaseUnavailable(): void {
  closeOpenClawStateDatabaseForTest();
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("missing test state dir");
  }
  fs.writeFileSync(path.join(stateDir, "state"), "not a directory");
}

beforeEach(() => {
  createStateDir();
  loggerWarn.mockReset();
  execApprovalsStoreTesting.reset();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  execApprovalsStoreTesting.reset();
  envSnapshot.restore();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("exec approvals SQLite store", () => {
  it("uses a permissive missing-row default without creating the row", () => {
    expect(loadExecApprovals()).toEqual({
      version: 1,
      socket: { path: undefined, token: undefined },
      defaults: {
        security: undefined,
        ask: undefined,
        askFallback: undefined,
        autoAllowSkills: undefined,
      },
      agents: {},
    });
    expect(readExecApprovalsSnapshot()).toMatchObject({
      exists: false,
      raw: null,
      hash: expect.stringMatching(/^missing:/u),
    });
    expect(row()).toBeUndefined();
  });

  it("persists CRUD state and all denormalized projections", async () => {
    const written = await updateExecApprovals({
      update: () => ({
        version: 1,
        socket: { path: "/tmp/openclaw-approvals.sock", token: "secret" },
        defaults: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: true,
        },
        agents: {
          main: { allowlist: [{ pattern: "/usr/bin/rg" }, { pattern: "/usr/bin/git" }] },
          worker: { allowlist: [{ pattern: "/usr/bin/jq" }] },
        },
      }),
    });

    expect(written?.exists).toBe(true);
    expect(loadExecApprovals().defaults?.security).toBe("allowlist");
    expect(row()).toMatchObject({
      config_key: "current",
      socket_path: "/tmp/openclaw-approvals.sock",
      has_socket_token: 1,
      default_security: "allowlist",
      default_ask: "on-miss",
      default_ask_fallback: "deny",
      auto_allow_skills: 1,
      agent_count: 2,
      allowlist_count: 3,
    });
  });

  it("preserves raw-byte CAS hashes and returns null on a stale base", async () => {
    const missing = readExecApprovalsSnapshot();
    const first = await updateExecApprovals({
      baseHash: missing.hash,
      update: () => ({ version: 1, defaults: { security: "deny" }, agents: {} }),
    });
    expect(first?.raw).not.toBeNull();
    expect(first?.hash).toBe(sha256Hex(first?.raw ?? ""));

    await expect(
      updateExecApprovals({
        baseHash: missing.hash,
        update: () => ({ version: 1, defaults: { security: "full" }, agents: {} }),
      }),
    ).resolves.toBeNull();

    const updated = await updateExecApprovals({
      baseHash: first?.hash,
      update: (file) => ({ ...file, defaults: { security: "full" } }),
    });
    expect(updated?.file.defaults?.security).toBe("full");
  });

  it("mints one socket token and reuses it on later initialization", () => {
    const first = ensureExecApprovals();
    const second = ensureExecApprovals();
    expect(first.socket?.token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.socket?.token).toBe(second.socket?.token);
    expect(first.socket?.path).toBe(second.socket?.path);
    expect(row()).toMatchObject({ has_socket_token: 1, socket_path: first.socket?.path });
  });

  it("fails closed and warns once for malformed raw_json", () => {
    const { db } = openOpenClawStateDatabase();
    db.prepare(
      "INSERT INTO exec_approvals_config (config_key, raw_json, socket_path, has_socket_token, default_security, default_ask, default_ask_fallback, auto_allow_skills, agent_count, allowlist_count, updated_at_ms) VALUES (?, ?, NULL, 0, NULL, NULL, NULL, NULL, 0, 0, 1)",
    ).run("current", "{not-json");

    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain("malformed");
  });

  it("throws typed snapshot failures while enforcement reads fail closed", () => {
    makeStateDatabaseUnavailable();

    expect(() => readExecApprovalsSnapshot()).toThrow("Exec approvals SQLite state is unavailable");
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain("unavailable");
  });

  it("aborts agent deletion before commit when the approvals store is unavailable", async () => {
    makeStateDatabaseUnavailable();
    const commit = vi.fn(async () => "committed");

    await expect(withAgentExecApprovalsRemoved("removed", commit)).rejects.toThrow(
      "Exec approvals SQLite state is unavailable",
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("removes one agent and preserves unrelated policy", async () => {
    saveExecApprovals({
      version: 1,
      agents: {
        removed: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/old" }] },
        kept: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/keep" }] },
      },
    });

    await expect(withAgentExecApprovalsRemoved("removed", async () => "ok")).resolves.toBe("ok");
    expect(loadExecApprovals().agents).toEqual({
      kept: expect.objectContaining({
        allowlist: [expect.objectContaining({ pattern: "/usr/bin/keep" })],
      }),
    });
  });

  it("fences a concurrent writer across a slow deletion commit", async () => {
    saveExecApprovals({
      version: 1,
      agents: {
        removed: { security: "allowlist" },
        kept: { security: "deny" },
      },
    });
    let notifyCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    let finishCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const deletion = withAgentExecApprovalsRemoved("removed", async () => {
      notifyCommitStarted();
      await commitGate;
      return "committed";
    });

    await commitStarted;
    try {
      expect(loadExecApprovals().agents).toEqual({ kept: { security: "deny" } });
      await expect(
        updateExecApprovals({
          update: (file) => ({
            ...file,
            agents: { ...file.agents, removed: { security: "full" } },
          }),
        }),
      ).rejects.toMatchObject({ name: "ExecApprovalsMutationFencedError" });
    } finally {
      finishCommit();
    }

    await expect(deletion).resolves.toBe("committed");
  });

  it("fences writers during deletion even when the agent has no approval policy", async () => {
    saveExecApprovals({ version: 1, agents: { kept: { security: "deny" } } });
    let notifyCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    let finishCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const deletion = withAgentExecApprovalsRemoved("missing", async () => {
      notifyCommitStarted();
      await commitGate;
    });

    await commitStarted;
    try {
      expect(() =>
        saveExecApprovals({
          version: 1,
          agents: { kept: { security: "full" } },
        }),
      ).toThrow("Exec approvals cannot be changed while agent deletion is in progress; retry.");
    } finally {
      finishCommit();
    }
    await deletion;
  });

  it("restores only the removed agent when the surrounding commit fails", async () => {
    saveExecApprovals({
      version: 1,
      agents: { removed: { security: "allowlist" }, kept: { security: "deny" } },
    });

    await expect(
      withAgentExecApprovalsRemoved("removed", async () => {
        throw new Error("roster commit failed");
      }),
    ).rejects.toThrow("roster commit failed");

    expect(loadExecApprovals().agents).toMatchObject({
      removed: { security: "allowlist" },
      kept: { security: "deny" },
    });
  });

  it("allows writers after an abandoned mutation lease expires", async () => {
    const { db } = openOpenClawStateDatabase();
    const now = Date.now();
    db.prepare(
      "INSERT INTO state_leases (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    ).run("exec-approvals", "mutation", "crashed-deletion", now - 1, now - 10, now - 10, now - 10);

    await expect(
      updateExecApprovals({
        update: () => ({ version: 1, agents: { current: { security: "full" } } }),
      }),
    ).resolves.toMatchObject({ file: { agents: { current: { security: "full" } } } });
  });

  it("restores snapshots and honors rollback CAS", async () => {
    const missing = readExecApprovalsSnapshot();
    const first = await updateExecApprovals({
      update: () => ({ version: 1, defaults: { security: "deny" }, agents: {} }),
    });
    if (!first) {
      throw new Error("missing first snapshot");
    }
    expect(await restoreExecApprovalsSnapshotLocked(missing, first.hash)).toBe(true);
    expect(readExecApprovalsSnapshot().exists).toBe(false);

    saveExecApprovals({ version: 1, defaults: { security: "allowlist" }, agents: {} });
    const original = readExecApprovalsSnapshot();
    const newer = await updateExecApprovals({
      update: (file) => ({ ...file, defaults: { security: "full" } }),
    });
    if (!newer) {
      throw new Error("missing newer snapshot");
    }
    expect(await restoreExecApprovalsSnapshotLocked(original, original.hash)).toBe(false);
    restoreExecApprovalsSnapshot(original);
    expect(loadExecApprovals().defaults?.security).toBe("allowlist");
  });

  it("serializes two SQLite handles and rejects a stale cross-handle CAS", () => {
    saveExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} });
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    closeOpenClawStateDatabaseForTest();
    const first = new DatabaseSync(databasePath);
    const second = new DatabaseSync(databasePath);
    try {
      first.exec("PRAGMA busy_timeout = 5000");
      second.exec("PRAGMA busy_timeout = 5000");
      const stale = snapshotFromExecApprovalsRow({
        path: "state/openclaw.sqlite#exec_approvals_config",
        row: readExecApprovalsConfigRow(first),
      });
      runSqliteImmediateTransactionSync(second, () => {
        writeExecApprovalsConfigRow({
          db: second,
          file: { version: 1, defaults: { security: "full" }, agents: {} },
        });
      });
      const current = snapshotFromExecApprovalsRow({
        path: stale.path,
        row: readExecApprovalsConfigRow(first),
      });
      expect(current.hash).not.toBe(stale.hash);
      expect(current.file.defaults?.security).toBe("full");
    } finally {
      first.close();
      second.close();
    }
  });

  it("blocks runtime reads while the retired JSON or claim exists", () => {
    closeOpenClawStateDatabaseForTest();
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("missing test state dir");
    }
    fs.writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      serializeExecApprovals({ version: 1, agents: {} }),
    );
    execApprovalsStoreTesting.reset();
    expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);
  });

  it.each([
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])("detects legacy state at every source-claim-source probe", (first, claim, second) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("missing test state dir");
    }
    const sourcePath = path.join(stateDir, "exec-approvals.json");
    const probe = vi
      .fn<(filePath: string) => boolean>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(second);

    expect(() => assertNoPendingLegacyExecApprovals({ pathMayExist: probe })).toThrow(
      ExecApprovalsMigrationRequiredError,
    );
    expect(probe.mock.calls.map(([filePath]) => filePath)).toEqual([
      sourcePath,
      `${sourcePath}.doctor-importing`,
      sourcePath,
    ]);
  });

  it("caches an absent legacy result only after all three probes are clear", () => {
    const clearProbe = vi.fn<(filePath: string) => boolean>(() => false);
    assertNoPendingLegacyExecApprovals({ pathMayExist: clearProbe });
    expect(clearProbe).toHaveBeenCalledTimes(3);

    const laterProbe = vi.fn<(filePath: string) => boolean>(() => true);
    assertNoPendingLegacyExecApprovals({ pathMayExist: laterProbe });
    expect(laterProbe).not.toHaveBeenCalled();
  });
});
