import { spawn } from "node:child_process";
import { once } from "node:events";
// Persistent operator approval store tests cover terminal CAS, expiry, replay, and recovery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  closeOrphanedOperatorApprovals,
  consumeOperatorApprovalAllowOnce,
  expireDueOperatorApprovals,
  forceDenyOperatorApproval,
  getOperatorApproval,
  getOperatorApprovalDetailed,
  getOperatorApprovalDetailedByLocator,
  insertOperatorApproval,
  listPendingOperatorApprovals,
  OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS,
  OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
  pruneTerminalOperatorApprovals,
  resolveOperatorApproval,
  type NewOperatorApproval,
} from "./operator-approval-store.js";

type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;

const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-operator-approval-"));
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function approval(id: string, overrides: Partial<NewOperatorApproval> = {}): NewOperatorApproval {
  const kind = overrides.kind ?? overrides.presentation?.kind ?? "exec";
  const presentation: NewOperatorApproval["presentation"] =
    overrides.presentation ??
    (kind === "exec"
      ? {
          kind: "exec" as const,
          commandText: `echo ${id}`,
          commandPreview: `echo ${id}`,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        }
      : {
          kind: "plugin" as const,
          title: "Approve plugin action",
          description: `Allow the plugin action for ${id}.`,
          severity: "warning" as const,
          pluginId: "test-plugin",
          toolName: "test-tool",
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        });
  return {
    id,
    kind,
    presentation,
    requester: {
      deviceId: "request-device",
      clientId: "request-client",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: ["reviewer-b", "reviewer-a", "reviewer-b"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

function rawApprovalRow(options: OpenClawStateDatabaseOptions, id: string) {
  const database = openOpenClawStateDatabase(options);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

describe("operator approval store", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("round-trips only the safe presentation and durable routing metadata across reopen", () => {
    const databaseOptions = createDatabaseOptions();

    const inserted = insertOperatorApproval({
      approval: approval("round-trip"),
      databaseOptions,
    });
    expect(inserted.outcome).toBe("inserted");
    if (inserted.outcome !== "inserted") {
      throw new Error("expected approval insert");
    }
    expect(inserted.record).toMatchObject({
      id: "round-trip",
      resolutionRef: buildApprovalResolutionRef({
        approvalId: "round-trip",
        approvalKind: "exec",
      }),
      kind: "exec",
      status: "pending",
      presentation: {
        kind: "exec",
        commandText: "echo round-trip",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
      requester: {
        deviceId: "request-device",
        clientId: "request-client",
        deviceTokenAuth: true,
      },
      reviewerDeviceIds: ["reviewer-b", "reviewer-a"],
      source: {
        agentId: "main",
        sessionKey: "agent:main:child",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "tool-call-1",
        toolName: "exec",
      },
      audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
      runtimeEpoch: "runtime-a",
    });

    expect(
      insertOperatorApproval({
        approval: approval("plugin", { kind: "plugin", createdAtMs: 1_001 }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted", record: { id: "plugin", kind: "plugin" } });

    closeOpenClawStateDatabaseForTest();

    expect(getOperatorApproval({ id: "round-trip", nowMs: 2_000, databaseOptions })).toEqual(
      inserted.record,
    );
    expect(
      getOperatorApprovalDetailedByLocator({
        locator: inserted.record.resolutionRef,
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "found", record: inserted.record });
    expect(listPendingOperatorApprovals({ nowMs: 2_000, databaseOptions })).toEqual([
      inserted.record,
      expect.objectContaining({ id: "plugin", kind: "plugin" }),
    ]);
  });

  it("reads the default clock after waiting for the SQLite write lock", async () => {
    const databaseOptions = createDatabaseOptions();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + 1_500;
    insertOperatorApproval({
      approval: approval("lock-delayed-clock", { createdAtMs, expiresAtMs }),
      databaseOptions,
    });
    const databasePath = openOpenClawStateDatabase(databaseOptions).path;
    const releaseAtMs = expiresAtMs + 200;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { DatabaseSync } from "node:sqlite";',
          "const [databasePath, releaseAtRaw] = process.argv.slice(1);",
          "const database = new DatabaseSync(databasePath);",
          'database.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");',
          'process.stdout.write("locked\\n");',
          'setTimeout(() => { database.exec("COMMIT"); database.close(); }, Math.max(0, Number(releaseAtRaw) - Date.now()));',
        ].join("\n"),
        databasePath,
        String(releaseAtMs),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exitPromise = once(child, "exit");
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
      child.stdout.once("data", (chunk) => {
        if (String(chunk).includes("locked")) {
          resolve();
        } else {
          reject(new Error(`unexpected lock holder output: ${String(chunk)}`));
        }
      });
    });
    expect(Date.now()).toBeLessThan(expiresAtMs);

    const record = getOperatorApproval({ id: "lock-delayed-clock", databaseOptions });
    const [exitCode] = await exitPromise;

    expect(exitCode, stderr).toBe(0);
    expect(record).toMatchObject({ status: "expired", terminalReason: "timeout" });
  });

  it("preserves protocol-valid boundary whitespace as opaque approval identity", () => {
    const databaseOptions = createDatabaseOptions();
    for (const [index, id] of ["\uFEFF", "\u00A0", " approval-edge "].entries()) {
      const inserted = insertOperatorApproval({
        approval: approval(id, { createdAtMs: 1_000 + index }),
        databaseOptions,
      });

      expect(inserted).toMatchObject({ outcome: "inserted", record: { id } });
      expect(getOperatorApproval({ id, nowMs: 2_000, databaseOptions })).toMatchObject({
        id,
        status: "pending",
      });
    }
    expect(getOperatorApproval({ id: "approval-edge", nowMs: 2_000, databaseOptions })).toBeNull();
  });

  it("rejects presentations outside the canonical safe protocol schema", () => {
    const databaseOptions = createDatabaseOptions();
    const base = approval("unsafe-presentation");
    const unsafePresentation = {
      ...base.presentation,
      env: { SECRET_TOKEN: "must-not-persist" },
    } as unknown as NewOperatorApproval["presentation"];

    expect(() =>
      insertOperatorApproval({
        approval: { ...base, presentation: unsafePresentation },
        databaseOptions,
      }),
    ).toThrow(/safe protocol schema/);
    expect(rawApprovalRow(databaseOptions, base.id)).toBeUndefined();
  });

  it("rejects approval ids that cannot form stable deep-link path segments", () => {
    const databaseOptions = createDatabaseOptions();
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      expect(() => insertOperatorApproval({ approval: approval(id), databaseOptions })).toThrow(
        /approval id/,
      );
      expect(() => getOperatorApproval({ id, databaseOptions })).toThrow(/approval id/);
      expect(() =>
        resolveOperatorApproval({
          id,
          decision: "deny",
          resolver: { kind: "system", id: null },
          databaseOptions,
        }),
      ).toThrow(/approval id/);
    }
  });

  it("keeps canonical ids and transport references in disjoint lookup namespaces", () => {
    const databaseOptions = createDatabaseOptions();
    const inserted = insertOperatorApproval({
      approval: approval("namespace-owner"),
      databaseOptions,
    });
    if (inserted.outcome !== "inserted") {
      throw new Error("expected approval insert");
    }

    expect(
      insertOperatorApproval({
        approval: approval(inserted.record.resolutionRef, { createdAtMs: 1_001 }),
        databaseOptions,
      }),
    ).toEqual({ outcome: "conflict" });
    expect(
      getOperatorApprovalDetailedByLocator({
        locator: inserted.record.resolutionRef,
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "found", record: inserted.record });

    const futureId = "namespace-future-owner";
    const futureRef = buildApprovalResolutionRef({ approvalId: futureId, approvalKind: "exec" });
    expect(
      insertOperatorApproval({
        approval: approval(futureRef, { createdAtMs: 1_002 }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });
    expect(
      insertOperatorApproval({
        approval: approval(futureId, { createdAtMs: 1_003 }),
        databaseOptions,
      }),
    ).toEqual({ outcome: "conflict" });
  });

  it("prunes retained terminal rows before checking locator namespace conflicts", () => {
    const databaseOptions = createDatabaseOptions();
    const inserted = insertOperatorApproval({
      approval: approval("expired-namespace-owner"),
      databaseOptions,
    });
    if (inserted.outcome !== "inserted") {
      throw new Error("expected approval insert");
    }
    forceDenyOperatorApproval({
      id: inserted.record.id,
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 2_000,
      databaseOptions,
    });
    const createdAtMs = OPERATOR_APPROVAL_TERMINAL_RETENTION_MS + 3_000;

    expect(
      insertOperatorApproval({
        approval: approval(inserted.record.resolutionRef, {
          createdAtMs,
          expiresAtMs: createdAtMs + 10_000,
        }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });
    expect(rawApprovalRow(databaseOptions, inserted.record.id)).toBeUndefined();
  });

  it("returns the first terminal answer and distinguishes same and conflicting retries", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({ approval: approval("first-wins"), databaseOptions });

    const winner = resolveOperatorApproval({
      id: "first-wins",
      decision: "allow-once",
      resolver: { kind: "device", id: "winner-device" },
      nowMs: 2_000,
      databaseOptions,
    });
    const sameRetry = resolveOperatorApproval({
      id: "first-wins",
      decision: "allow-once",
      resolver: { kind: "channel", id: "telegram:loser" },
      nowMs: 2_001,
      databaseOptions,
    });
    const conflictingRetry = resolveOperatorApproval({
      id: "first-wins",
      decision: "deny",
      resolver: { kind: "channel", id: "telegram:loser" },
      nowMs: 2_002,
      databaseOptions,
    });

    expect(winner).toMatchObject({
      outcome: "resolved",
      record: {
        status: "allowed",
        decision: "allow-once",
        resolver: { kind: "device", id: "winner-device" },
      },
    });
    expect(sameRetry).toMatchObject({
      outcome: "already-resolved",
      retry: "same",
      record: { resolver: { kind: "device", id: "winner-device" } },
    });
    expect(conflictingRetry).toMatchObject({
      outcome: "already-resolved",
      retry: "conflict",
      record: { decision: "allow-once" },
    });
  });

  it("expires at the exact deadline and never accepts a late allow", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({
      approval: approval("deadline", { expiresAtMs: 2_000 }),
      databaseOptions,
    });

    const deadlineResult = resolveOperatorApproval({
      id: "deadline",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
      databaseOptions,
    });
    const lateResult = resolveOperatorApproval({
      id: "deadline",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_001,
      databaseOptions,
    });

    expect(deadlineResult).toMatchObject({
      outcome: "expired",
      record: { status: "expired", decision: "deny", terminalReason: "timeout" },
    });
    expect(lateResult).toMatchObject({
      outcome: "already-resolved",
      retry: "conflict",
      record: { status: "expired", decision: "deny" },
    });
  });

  it("expires before a trusted force-deny verdict at the exact deadline", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({
      approval: approval("force-deadline", { expiresAtMs: 2_000 }),
      databaseOptions,
    });

    expect(
      forceDenyOperatorApproval({
        id: "force-deadline",
        reason: "malformed-verdict",
        resolver: { kind: "runtime", id: "harness" },
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "expired",
      record: { status: "expired", decision: "deny", terminalReason: "timeout" },
    });
  });

  it("keeps an early expiry callback pending until the authoritative deadline", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({
      approval: approval("early-expiry", { expiresAtMs: 2_000 }),
      databaseOptions,
    });

    expect(
      forceDenyOperatorApproval({
        id: "early-expiry",
        status: "expired",
        requireDue: true,
        reason: "timeout",
        resolver: { kind: "system", id: null },
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
        nowMs: 1_999,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "not-due", record: { status: "pending" } });
    expect(
      getOperatorApproval({ id: "early-expiry", nowMs: 1_999, databaseOptions }),
    ).toMatchObject({ status: "pending" });
  });

  it("hides approvals from resolvers with the wrong kind or runtime epoch", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({ approval: approval("guarded"), databaseOptions });

    expect(
      resolveOperatorApproval({
        id: "guarded",
        decision: "allow-once",
        resolver: { kind: "runtime", id: "runtime" },
        expectedKind: "plugin",
        runtimeEpoch: "runtime-a",
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(
      forceDenyOperatorApproval({
        id: "guarded",
        reason: "run-aborted",
        resolver: { kind: "runtime", id: "runtime" },
        expectedKind: "exec",
        runtimeEpoch: "runtime-b",
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(getOperatorApproval({ id: "guarded", nowMs: 2_000, databaseOptions })).toMatchObject({
      status: "pending",
    });

    resolveOperatorApproval({
      id: "guarded",
      decision: "allow-once",
      resolver: { kind: "runtime", id: "runtime" },
      expectedKind: "exec",
      runtimeEpoch: "runtime-a",
      nowMs: 2_000,
      databaseOptions,
    });
    expect(
      consumeOperatorApprovalAllowOnce({
        id: "guarded",
        consumerId: "run-1:tool-call-1",
        expectedKind: "plugin",
        runtimeEpoch: "runtime-a",
        nowMs: 2_001,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(
      consumeOperatorApprovalAllowOnce({
        id: "guarded",
        consumerId: "run-1:tool-call-1",
        expectedKind: "exec",
        runtimeEpoch: "runtime-b",
        nowMs: 2_001,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(
      consumeOperatorApprovalAllowOnce({
        id: "guarded",
        consumerId: "run-1:tool-call-1",
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
        nowMs: 2_001,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "consumed" });
  });

  it("expires every due row in one fail-closed maintenance pass", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({
      approval: approval("due-a", { expiresAtMs: 2_000 }),
      databaseOptions,
    });
    insertOperatorApproval({
      approval: approval("due-b", { expiresAtMs: 3_000 }),
      databaseOptions,
    });
    insertOperatorApproval({ approval: approval("future"), databaseOptions });

    const result = expireDueOperatorApprovals({ nowMs: 3_000, databaseOptions });

    expect(result.affected).toBe(2);
    expect(result.records.map((record) => [record.id, record.status])).toEqual([
      ["due-a", "expired"],
      ["due-b", "expired"],
    ]);
    expect(listPendingOperatorApprovals({ nowMs: 3_000, databaseOptions })).toMatchObject([
      { id: "future" },
    ]);
  });

  it("consumes allow-once exactly once without erasing the terminal decision", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({
      approval: approval("consume", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    const resolved = resolveOperatorApproval({
      id: "consume",
      decision: "allow-once",
      resolver: { kind: "runtime", id: "approval-runtime" },
      nowMs: 2_000,
      databaseOptions,
    });
    expect(resolved).toMatchObject({
      outcome: "resolved",
      record: { resolvedAtMs: 5_000, updatedAtMs: 5_000 },
    });

    const first = consumeOperatorApprovalAllowOnce({
      id: "consume",
      consumerId: "run-1:tool-call-1",
      redemptionWindowMs: 15_000,
      nowMs: 3_000,
      databaseOptions,
    });
    const replay = consumeOperatorApprovalAllowOnce({
      id: "consume",
      consumerId: "run-1:tool-call-1",
      redemptionWindowMs: 15_000,
      nowMs: 3_001,
      databaseOptions,
    });

    expect(first).toMatchObject({
      outcome: "consumed",
      record: {
        status: "allowed",
        decision: "allow-once",
        consumedAtMs: 5_000,
        consumedBy: "run-1:tool-call-1",
      },
    });
    expect(replay).toMatchObject({
      outcome: "already-consumed",
      record: { decision: "allow-once", consumedAtMs: 5_000 },
    });
  });

  it("rejects allow-once redemption at the exact grace boundary", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({ approval: approval("stale-redemption"), databaseOptions });
    resolveOperatorApproval({
      id: "stale-redemption",
      decision: "allow-once",
      resolver: { kind: "runtime", id: "approval-runtime" },
      nowMs: 2_000,
      databaseOptions,
    });

    expect(
      consumeOperatorApprovalAllowOnce({
        id: "stale-redemption",
        consumerId: "run-1:tool-call-1",
        redemptionWindowMs: 1_000,
        nowMs: 3_000,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "redemption-expired",
      record: { resolvedAtMs: 2_000, consumedAtMs: null },
    });
  });

  it("cancels pending rows from older runtime epochs after reopen", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({
      approval: approval("orphan", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    insertOperatorApproval({
      approval: approval("current", { runtimeEpoch: "runtime-b" }),
      databaseOptions,
    });
    closeOpenClawStateDatabaseForTest();

    const result = closeOrphanedOperatorApprovals({
      runtimeEpoch: "runtime-b",
      nowMs: 2_000,
      databaseOptions,
    });

    expect(result).toMatchObject({
      affected: 1,
      records: [
        {
          id: "orphan",
          status: "cancelled",
          decision: "deny",
          terminalReason: "gateway-restart",
          resolvedAtMs: 5_000,
          updatedAtMs: 5_000,
        },
      ],
    });
    expect(getOperatorApproval({ id: "current", nowMs: 2_000, databaseOptions })).toMatchObject({
      status: "pending",
    });
  });

  it("terminalizes a corrupt pending row and never returns it as approvable", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({
      approval: approval("corrupt", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({ presentation_json: "{not-json" })
        .where("approval_id", "=", "corrupt"),
    );

    expect(getOperatorApprovalDetailed({ id: "corrupt", nowMs: 2_000, databaseOptions })).toEqual({
      outcome: "corrupt",
    });
    expect(getOperatorApproval({ id: "corrupt", nowMs: 2_000, databaseOptions })).toBeNull();
    expect(rawApprovalRow(databaseOptions, "corrupt")).toMatchObject({
      status: "denied",
      decision: "deny",
      terminal_reason: "storage-corrupt",
      resolver_kind: "system",
      resolved_at_ms: 5_000,
      updated_at_ms: 5_000,
    });
  });

  it("fails closed for forged terminal status tuples", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({ approval: approval("forged-allowed"), databaseOptions });
    insertOperatorApproval({ approval: approval("forged-denied"), databaseOptions });
    resolveOperatorApproval({
      id: "forged-allowed",
      decision: "allow-once",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
      databaseOptions,
    });
    resolveOperatorApproval({
      id: "forged-denied",
      decision: "deny",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
      databaseOptions,
    });
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    // Simulate external corruption that bypassed SQLite CHECK constraints; the
    // decoder must independently reject these approval-granting tuples.
    database.db.exec("PRAGMA ignore_check_constraints = ON");
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({ terminal_reason: "storage-corrupt" })
        .where("approval_id", "=", "forged-allowed"),
    );
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({ decision: "allow-once" })
        .where("approval_id", "=", "forged-denied"),
    );
    database.db.exec("PRAGMA ignore_check_constraints = OFF");

    expect(
      getOperatorApprovalDetailed({ id: "forged-allowed", nowMs: 2_001, databaseOptions }),
    ).toEqual({ outcome: "corrupt" });
    expect(
      getOperatorApprovalDetailed({ id: "forged-denied", nowMs: 2_001, databaseOptions }),
    ).toEqual({ outcome: "corrupt" });
  });

  it("prunes only terminal rows outside the 30-day retention window", () => {
    const databaseOptions = createDatabaseOptions();
    const nowMs = OPERATOR_APPROVAL_TERMINAL_RETENTION_MS + 10_000;
    insertOperatorApproval({
      approval: approval("old-terminal", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    insertOperatorApproval({ approval: approval("recent-terminal"), databaseOptions });
    insertOperatorApproval({ approval: approval("still-pending"), databaseOptions });
    forceDenyOperatorApproval({
      id: "old-terminal",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 4_000,
      databaseOptions,
    });
    expect(rawApprovalRow(databaseOptions, "old-terminal")).toMatchObject({
      resolved_at_ms: 5_000,
      updated_at_ms: 5_000,
    });
    forceDenyOperatorApproval({
      id: "recent-terminal",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: nowMs - 100,
      databaseOptions,
    });

    expect(pruneTerminalOperatorApprovals({ nowMs, databaseOptions })).toBe(1);
    expect(rawApprovalRow(databaseOptions, "old-terminal")).toBeUndefined();
    expect(rawApprovalRow(databaseOptions, "recent-terminal")).toBeDefined();
    expect(rawApprovalRow(databaseOptions, "still-pending")).toBeDefined();
  });

  it("prunes old terminal rows opportunistically when inserting", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({ approval: approval("old-on-insert"), databaseOptions });
    forceDenyOperatorApproval({
      id: "old-on-insert",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 2_000,
      databaseOptions,
    });
    const createdAtMs = OPERATOR_APPROVAL_TERMINAL_RETENTION_MS + 2_000;

    insertOperatorApproval({
      approval: approval("prune-trigger", {
        createdAtMs,
        expiresAtMs: createdAtMs + 1_000,
      }),
      databaseOptions,
    });

    expect(rawApprovalRow(databaseOptions, "old-on-insert")).toBeUndefined();
    expect(rawApprovalRow(databaseOptions, "prune-trigger")).toMatchObject({ status: "pending" });
  });

  it("rejects an unbounded ancestor audience", () => {
    const databaseOptions = createDatabaseOptions();
    const audienceSessionKeys = Array.from(
      { length: OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS + 1 },
      (_, index) => `agent:main:${index}`,
    );

    expect(() =>
      insertOperatorApproval({
        approval: approval("large-audience", { audienceSessionKeys }),
        databaseOptions,
      }),
    ).toThrow(/audience exceeds/);
  });
});
