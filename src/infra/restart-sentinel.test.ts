import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Covers restart sentinel persistence, summaries, and messages.

const { mockWarn, mockThrowOpen, mockThrowWrite } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockThrowOpen: vi.fn(),
  mockThrowWrite: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mockWarn }),
}));

vi.mock("../state/openclaw-state-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db.js")>();
  return {
    ...actual,
    openOpenClawStateDatabase: (...args: Parameters<typeof actual.openOpenClawStateDatabase>) => {
      mockThrowOpen();
      return actual.openOpenClawStateDatabase(...args);
    },
    runOpenClawStateWriteTransaction: (
      ...args: Parameters<typeof actual.runOpenClawStateWriteTransaction>
    ) => {
      mockThrowWrite();
      return actual.runOpenClawStateWriteTransaction(...args);
    },
  };
});

import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  buildRestartSuccessContinuation,
  clearRestartSentinel,
  clearRestartSentinelIfRevision,
  finalizeUpdateRestartSentinelRunningVersion,
  formatDoctorNonInteractiveHint,
  formatRestartSentinelMessage,
  hasRestartSentinel,
  markUpdateRestartSentinelFailure,
  readRestartSentinel,
  summarizeRestartSentinel,
  trimLogTail,
  writeRestartSentinel,
} from "./restart-sentinel.js";
import {
  CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
  buildControlPlaneUpdateRestartHealthPendingResult,
  isPendingControlPlaneUpdateRestartSentinel,
} from "./update-control-plane-sentinel.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";

beforeEach(() => {
  mockWarn.mockClear();
  mockThrowOpen.mockReset();
  mockThrowWrite.mockReset();
});

async function withRestartSentinelStateDir(run: () => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-sentinel-" }, async (tempDir) => {
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, run);
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
}

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

function readSentinelRow() {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["sentinel_key", "version", "kind", "status", "payload_json", "updated_at_ms"])
      .where("sentinel_key", "=", "current"),
  );
}

function readSentinelRevisionFloor() {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select("updated_at_ms")
      .where("sentinel_key", "=", "revision-floor"),
  )?.updated_at_ms;
}

function deleteSentinelRevisionFloor() {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.deleteFrom("gateway_restart_sentinel").where("sentinel_key", "=", "revision-floor"),
  );
}

function updateSentinelRow(
  values: Partial<{
    version: number;
    kind: string;
    status: string;
    continuation_json: string | null;
    stats_json: string | null;
    payload_json: string;
    updated_at_ms: number;
  }>,
) {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(values)
      .where("sentinel_key", "=", "current"),
  );
}

describe("restart sentinel", () => {
  it("writes and reads a sentinel", async () => {
    await withRestartSentinelStateDir(async () => {
      const payload = {
        kind: "update" as const,
        status: "ok" as const,
        ts: Date.now(),
        sessionKey: "agent:main:mobilechat:dm:+15555550123",
        continuation: {
          kind: "agentTurn" as const,
          message: "Reply with exactly: Yay! I did it!",
        },
        stats: { mode: "git" },
      };
      await writeRestartSentinel(payload);
      expect(readSentinelRow()).toMatchObject({
        sentinel_key: "current",
        version: 1,
        kind: "update",
        status: "ok",
        payload_json: JSON.stringify(payload),
      });

      const read = await readRestartSentinel();
      expect(read?.payload.kind).toBe("update");
      expect(read?.payload.continuation).toEqual(payload.continuation);
    });
  });

  it("canonicalizes nullable top-level fields and empty delivery context", async () => {
    await withRestartSentinelStateDir(async () => {
      const written = await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 1,
        deliveryContext: {},
        message: null,
        continuation: null,
        doctorHint: null,
        stats: null,
      });

      expect(written.payload).toEqual({ kind: "restart", status: "ok", ts: 1 });
      await expect(readRestartSentinel()).resolves.toEqual(written);
      expect(readSentinelRow()?.payload_json).toBe(
        JSON.stringify({ kind: "restart", status: "ok", ts: 1 }),
      );
    });
  });

  it("ignores legacy files without mutating them", async () => {
    await withRestartSentinelStateDir(async () => {
      const payload = {
        kind: "update" as const,
        status: "skipped" as const,
        ts: Date.now(),
        sessionKey: "agent:main:webchat:dm:user-123",
        message: "update restart pending",
        stats: {
          mode: "npm",
          reason: "restart-health-pending",
        },
      };
      const legacyPath = path.join(process.env.OPENCLAW_STATE_DIR ?? "", "restart-sentinel.json");
      const legacyContents = `${JSON.stringify({ version: 1, payload })}\n`;
      await fs.writeFile(legacyPath, legacyContents, "utf-8");

      await expect(hasRestartSentinel()).resolves.toBe(false);
      await expect(readRestartSentinel()).resolves.toBeNull();
      await writeRestartSentinel({ kind: "restart", status: "ok", ts: 2 });
      await clearRestartSentinel();
      await expect(fs.readFile(legacyPath, "utf-8")).resolves.toBe(legacyContents);
    });
  });

  it("reconstructs typed columns when payload_json is corrupt", async () => {
    await withRestartSentinelStateDir(async () => {
      const payload = {
        kind: "update" as const,
        status: "skipped" as const,
        ts: 42,
        sessionKey: "agent:main:webchat:dm:user-123",
        deliveryContext: { channel: "webchat", to: "user-123", accountId: "default" },
        threadId: "thread-1",
        message: "typed state",
        continuation: { kind: "agentTurn" as const, message: "continue" },
        doctorHint: "run doctor",
        stats: { mode: "npm", reason: "pending" },
      };
      const written = await writeRestartSentinel(payload);
      updateSentinelRow({ payload_json: "not-json" });

      await expect(readRestartSentinel()).resolves.toEqual(written);
    });
  });

  it("leaves malformed typed rows in place and reports them as unreadable", async () => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel({ kind: "update", status: "ok", ts: 1 });
      updateSentinelRow({ kind: "not-a-kind", payload_json: "{}" });

      await expect(readRestartSentinel()).resolves.toBeNull();
      await expect(hasRestartSentinel()).resolves.toBe(false);
      expect(readSentinelRow()).toMatchObject({ kind: "not-a-kind", payload_json: "{}" });
      expect(mockWarn).toHaveBeenCalledWith("Ignoring invalid typed restart sentinel row");
    });
  });

  it("rejects malformed typed JSON columns even when the shadow payload is valid", async () => {
    await withRestartSentinelStateDir(async () => {
      const payload = { kind: "update" as const, status: "ok" as const, ts: 1 };
      await writeRestartSentinel(payload);
      updateSentinelRow({
        continuation_json: JSON.stringify({ kind: "agentTurn", message: 42 }),
        payload_json: JSON.stringify(payload),
      });

      await expect(readRestartSentinel()).resolves.toBeNull();
      await expect(hasRestartSentinel()).resolves.toBe(false);
    });
  });

  it("keeps revisions strictly monotonic within the same millisecond", async () => {
    await withRestartSentinelStateDir(async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        const first = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
        const second = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 2 });
        expect(second.revision).toBe(first.revision + 1);
        expect(readSentinelRow()?.updated_at_ms).toBe(second.revision);
      } finally {
        now.mockRestore();
      }
    });
  });

  it("upgrades pre-floor rows before unconditional and guarded clears", async () => {
    await withRestartSentinelStateDir(async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        const first = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
        deleteSentinelRevisionFloor();
        expect(readSentinelRevisionFloor()).toBeUndefined();
        await expect(clearRestartSentinel()).resolves.toBe(true);

        await expect(readRestartSentinel()).resolves.toBeNull();
        await expect(hasRestartSentinel()).resolves.toBe(false);
        expect(readSentinelRevisionFloor()).toBe(first.revision);

        now.mockReturnValue(500);
        const second = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 2 });
        expect(second.revision).toBe(first.revision + 1);

        deleteSentinelRevisionFloor();
        await expect(clearRestartSentinelIfRevision(second.revision + 1)).resolves.toBe(false);
        expect(readSentinelRevisionFloor()).toBeUndefined();
        await expect(readRestartSentinel()).resolves.toEqual(second);

        await expect(clearRestartSentinelIfRevision(second.revision)).resolves.toBe(true);
        expect(readSentinelRevisionFloor()).toBe(second.revision);
        const third = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 3 });
        expect(third.revision).toBe(second.revision + 1);

        await expect(clearRestartSentinelIfRevision(third.revision)).resolves.toBe(true);
        deleteSentinelRevisionFloor();
        await expect(clearRestartSentinel()).resolves.toBe(false);
        expect(readSentinelRevisionFloor()).toBeUndefined();
      } finally {
        now.mockRestore();
      }
    });
  });

  it("does not let stale deletes remove a newer sentinel", async () => {
    await withRestartSentinelStateDir(async () => {
      const first = await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 1,
        message: "old",
      });
      const newer = await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 2,
        message: "new",
      });

      await expect(clearRestartSentinelIfRevision(first.revision)).resolves.toBe(false);
      await expect(readRestartSentinel()).resolves.toEqual(newer);
    });
  });

  it("formatRestartSentinelMessage uses custom message when present", () => {
    const payload = {
      kind: "config-apply" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Config updated successfully",
    };
    expect(formatRestartSentinelMessage(payload)).toBe("Config updated successfully");
  });

  it("uses the exact auto-recovery message for config recovery notices", () => {
    const payload = {
      kind: "config-auto-recovery" as const,
      status: "ok" as const,
      ts: Date.now(),
      message:
        "Gateway recovered automatically after a failed config change and restored the last known good configuration.",
      stats: { mode: "config-auto-recovery", reason: "gateway-run-invalid-config" },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(payload.message);
    expect(summarizeRestartSentinel(payload)).toBe("Gateway auto-recovery");
  });

  it("formatRestartSentinelMessage falls back to summary when no message", () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
      stats: { mode: "git" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
    expect(result).toContain("update");
    expect(result).toContain("ok");
  });

  it("formatRestartSentinelMessage falls back to summary for blank message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "   ",
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
  });

  it("formats config write success notices as restart required when marked", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Run restart-gateway.ps1 to apply config changes.",
      doctorHint: "Run openclaw doctor --non-interactive",
      stats: { mode: "config.patch", requiresRestart: true },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(
      [
        "Gateway restart required (config.patch)",
        "Run restart-gateway.ps1 to apply config changes.",
        "Run openclaw doctor --non-interactive",
      ].join("\n"),
    );
    expect(summarizeRestartSentinel(payload)).toBe("Gateway restart required (config.patch)");

    expect(
      summarizeRestartSentinel({
        kind: "config-apply",
        status: "ok",
        ts: Date.now(),
        stats: { mode: "config.apply", requiresRestart: true },
      }),
    ).toBe("Gateway restart required (config.apply)");
  });

  it("does not mark hot-reloaded config patch notices as restart required", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "ok" as const,
      ts: Date.now(),
      stats: { mode: "config.patch", requiresRestart: false },
    };

    expect(summarizeRestartSentinel(payload)).toBe(
      "Gateway restart config-patch ok (config.patch)",
    );
  });

  it("formats summary, distinct reason, and doctor hint together", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "error" as const,
      ts: Date.now(),
      message: "Patch failed",
      doctorHint: "Run openclaw doctor",
      stats: { mode: "patch", reason: "validation failed" },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(
      [
        "Gateway restart config-patch error (patch)",
        "Patch failed",
        "Reason: validation failed",
        "Run openclaw doctor",
      ].join("\n"),
    );
  });

  it("trims log tails", () => {
    const text = "a".repeat(9000);
    const trimmed = trimLogTail(text, 8000);
    expect(trimmed?.length).toBeLessThanOrEqual(8001);
    expect(trimmed?.startsWith("…")).toBe(true);
  });

  it("keeps trimmed log tails UTF-16 safe", () => {
    expect(trimLogTail("prefix🤖tail", 5)).toBe("…tail");
  });

  it("formats restart messages without volatile timestamps", () => {
    const payloadA = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: 100,
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const payloadB = { ...payloadA, ts: 200 };
    const textA = formatRestartSentinelMessage(payloadA);
    const textB = formatRestartSentinelMessage(payloadB);
    expect(textA).toBe(textB);
    expect(textA).toContain("Gateway restart ok");
    expect(textA).not.toContain("Gateway restart restart");
    expect(textA).not.toContain('"ts"');
  });

  it("summarizes restart payloads and trims log tails without trailing whitespace", () => {
    expect(
      summarizeRestartSentinel({
        kind: "update",
        status: "skipped",
        ts: 1,
      }),
    ).toBe("Gateway restart update skipped");
    expect(trimLogTail("hello\n")).toBe("hello");
    expect(trimLogTail(undefined)).toBeNull();
  });

  it("writes the running version back to update sentinels on startup", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {
          after: { version: "expected-version" },
        },
      });

      await finalizeUpdateRestartSentinelRunningVersion("actual-version");

      await expect(readRestartSentinel()).resolves.toMatchObject({
        version: 1,
        payload: {
          kind: "update",
          status: "ok",
          ts,
          stats: {
            after: {
              version: "actual-version",
            },
          },
        },
      });
    });
  });

  it("does not rewrite update sentinels when the running version is already current", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {
          after: { version: "actual-version" },
        },
      });

      await expect(
        finalizeUpdateRestartSentinelRunningVersion("actual-version"),
      ).resolves.toBeNull();
      await expect(readRestartSentinel()).resolves.toMatchObject({
        version: 1,
        payload: {
          kind: "update",
          status: "ok",
          ts,
          stats: {
            after: {
              version: "actual-version",
            },
          },
        },
      });
    });
  });

  it("marks update restart failures with a stable reason", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {},
      });

      await markUpdateRestartSentinelFailure("restart-unhealthy");

      await expect(readRestartSentinel()).resolves.toMatchObject({
        version: 1,
        payload: {
          kind: "update",
          status: "error",
          ts,
          stats: {
            reason: "restart-unhealthy",
          },
        },
      });
    });
  });
});

describe("restart sentinel error visibility", () => {
  it("throws when clearRestartSentinel cannot durably delete the row", async () => {
    await withRestartSentinelStateDir(async () => {
      const written = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
      mockThrowWrite.mockImplementationOnce(() => {
        throw new Error("SQLITE_IOERR: disk I/O error");
      });

      await expect(clearRestartSentinel()).rejects.toThrow("SQLITE_IOERR: disk I/O error");
      expect(mockWarn).not.toHaveBeenCalled();
      await expect(readRestartSentinel()).resolves.toEqual(written);
    });
  });

  it("logs a warning and returns null when readRestartSentinel DB read fails", async () => {
    mockThrowOpen.mockImplementationOnce(() => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    });

    await withRestartSentinelStateDir(async () => {
      await expect(readRestartSentinel()).resolves.toBeNull();

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        "Failed to read restart sentinel: SQLITE_CORRUPT: database disk image is malformed",
      );
    });
  });

  it("logs a warning and returns false when hasRestartSentinel DB read fails", async () => {
    mockThrowOpen.mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    await withRestartSentinelStateDir(async () => {
      await expect(hasRestartSentinel()).resolves.toBe(false);

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        "Failed to check restart sentinel: SQLITE_BUSY: database is locked",
      );
    });
  });
});

describe("restart success continuation", () => {
  it("does not infer an agent turn from session context alone", () => {
    expect(buildRestartSuccessContinuation({ sessionKey: "agent:main:main" })).toBeNull();
  });

  it("keeps explicit continuation messages", () => {
    expect(
      buildRestartSuccessContinuation({
        sessionKey: "agent:main:main",
        continuationMessage: "wake after restart",
      }),
    ).toEqual({
      kind: "agentTurn",
      message: "wake after restart",
    });
  });

  it("stays silent without session context", () => {
    expect(buildRestartSuccessContinuation({})).toBeNull();
  });
});

describe("control-plane update restart sentinel", () => {
  it("keeps restart-health-pending sentinels continuation-free until final success", () => {
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: "/tmp/openclaw",
      before: { version: "2026.4.23" },
      after: { version: "2026.4.24" },
      steps: [],
      durationMs: 42,
    };
    const meta = {
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "Check the running version and finish the update report.",
    };

    const pendingResult = buildControlPlaneUpdateRestartHealthPendingResult(result);
    const pendingPayload = buildUpdateRestartSentinelPayload({
      result: pendingResult,
      meta,
      nowMs: 1,
    });

    expect(pendingPayload.status).toBe("skipped");
    expect(pendingPayload.stats?.reason).toBe(CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON);
    expect(pendingPayload.continuation).toBeUndefined();
    expect(isPendingControlPlaneUpdateRestartSentinel(pendingPayload)).toBe(true);

    const finalPayload = buildUpdateRestartSentinelPayload({
      result,
      meta,
      nowMs: 2,
    });

    expect(finalPayload.status).toBe("ok");
    expect(finalPayload.continuation).toEqual({
      kind: "agentTurn",
      message: "Check the running version and finish the update report.",
    });
    expect(isPendingControlPlaneUpdateRestartSentinel(finalPayload)).toBe(false);
  });
});

describe("restart sentinel message dedup", () => {
  it("omits duplicate Reason: line when stats.reason matches message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Applying config changes",
      stats: { mode: "gateway.restart", reason: "Applying config changes" },
    };
    const result = formatRestartSentinelMessage(payload);
    // The message text should appear exactly once, not duplicated as "Reason: ..."
    const occurrences = result.split("Applying config changes").length - 1;
    expect(occurrences).toBe(1);
    expect(result).not.toContain("Reason:");
  });

  it("keeps Reason: line when stats.reason differs from message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Restart requested by /restart");
    expect(result).toContain("Reason: /restart");
  });

  it("formats the non-interactive doctor command as actionability guidance", () => {
    expect(formatDoctorNonInteractiveHint({ PATH: "/usr/bin:/bin" })).toBe(
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
    );
  });

  it("keeps profile-aware doctor guidance actionable outside constrained delivery surfaces", () => {
    expect(
      formatDoctorNonInteractiveHint({
        OPENCLAW_PROFILE: "isolated",
        PATH: "/usr/bin:/bin",
      }),
    ).toBe(
      "Recommended follow-up: run openclaw --profile isolated doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
    );
  });
});
