import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteNativeHookRelayBridgeRecordIfOwned,
  pruneNativeHookRelayBridgeRecords,
  readNativeHookRelayBridgeRecord,
  renewOrRestoreNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";

let testRoot = "";
let primaryStateDbPath = "";
let secondaryStateDbPath = "";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  testRoot = tempDirs.make("openclaw-native-hook-relay-store-");
  primaryStateDbPath = path.join(testRoot, "primary.sqlite");
  secondaryStateDbPath = path.join(testRoot, "secondary.sqlite");
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function bridgeRecord(
  relayId: string,
  overrides: Partial<NativeHookRelayBridgeRecord> = {},
): NativeHookRelayBridgeRecord {
  return {
    relayId,
    pid: 100,
    hostname: "127.0.0.1",
    port: 18_789,
    token: "test-token-placeholder",
    expiresAtMs: 20_000,
    ...overrides,
  };
}

describe("native hook relay store", () => {
  it("upserts and reads bridge records", () => {
    const first = bridgeRecord("relay-upsert");
    const replacement = bridgeRecord("relay-upsert", {
      pid: 101,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });

    writeNativeHookRelayBridgeRecord({
      record: first,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: first.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(first);

    writeNativeHookRelayBridgeRecord({
      record: replacement,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("requires matching token and pid to renew or delete a bridge", () => {
    const record = bridgeRecord("relay-owned");
    writeNativeHookRelayBridgeRecord({
      record,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(
      renewOrRestoreNativeHookRelayBridgeRecord({
        record: { ...record, pid: record.pid + 1, expiresAtMs: 30_000 },
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      renewOrRestoreNativeHookRelayBridgeRecord({
        record: { ...record, token: "decoy-token", expiresAtMs: 30_000 },
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      renewOrRestoreNativeHookRelayBridgeRecord({
        record: { ...record, expiresAtMs: 30_000 },
        updatedAtMs: 2_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual({ ...record, expiresAtMs: 30_000 });

    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        pid: record.pid + 1,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        token: "decoy-token",
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
  });

  it("restores a missing record without overwriting another owner", () => {
    const record = bridgeRecord("relay-restored");
    expect(
      renewOrRestoreNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 1_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(record);

    const otherOwner = bridgeRecord(record.relayId, {
      pid: record.pid + 1,
      token: "test-auth-token",
    });
    writeNativeHookRelayBridgeRecord({
      record: otherOwner,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      renewOrRestoreNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 3_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(otherOwner);
  });

  it("does not let an old owner delete its replacement", () => {
    const oldOwner = bridgeRecord("relay-replaced", {
      pid: 100,
      token: "secret-token",
    });
    const replacement = bridgeRecord("relay-replaced", {
      pid: 101,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });
    writeNativeHookRelayBridgeRecord({
      record: oldOwner,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });
    writeNativeHookRelayBridgeRecord({
      record: replacement,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...oldOwner,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("prunes expired and dead bridges while preserving live and unknown pids", () => {
    const expired = bridgeRecord("relay-expired", { pid: 200, expiresAtMs: 9_999 });
    const dead = bridgeRecord("relay-dead", { pid: 201 });
    const live = bridgeRecord("relay-live", { pid: 202 });
    const unknown = bridgeRecord("relay-unknown", { pid: 203 });
    for (const [index, record] of [expired, dead, live, unknown].entries()) {
      writeNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 1_000 + index,
        stateDbPath: primaryStateDbPath,
      });
    }
    const isPidDead = vi.fn((pid: number) => pid === dead.pid);

    const pruned = pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead,
      nowMs: 10_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(pruned).toHaveLength(2);
    expect(pruned).toEqual(
      expect.arrayContaining([
        { relayId: expired.relayId, pid: expired.pid, reason: "expired" },
        { relayId: dead.relayId, pid: dead.pid, reason: "dead-pid" },
      ]),
    );
    expect(new Set(isPidDead.mock.calls.map(([pid]) => pid))).toStrictEqual(
      new Set([dead.pid, live.pid, unknown.pid]),
    );
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: expired.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: dead.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: live.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(live);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: unknown.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(unknown);
  });

  it("preserves a replacement published during dead-pid planning", () => {
    const stale = bridgeRecord("relay-prune-race", {
      pid: 201,
      token: "secret-token",
    });
    const replacement = bridgeRecord("relay-prune-race", {
      pid: 202,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });
    writeNativeHookRelayBridgeRecord({
      record: stale,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    const pruned = pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead: (pid) => {
        expect(pid).toBe(stale.pid);
        writeNativeHookRelayBridgeRecord({
          record: replacement,
          updatedAtMs: 2_000,
          stateDbPath: primaryStateDbPath,
        });
        return true;
      },
      nowMs: 10_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(pruned).toStrictEqual([]);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("isolates records by the exact state database path", () => {
    const primary = bridgeRecord("relay-isolated", {
      pid: 100,
      token: "config-token",
    });
    const secondary = bridgeRecord("relay-isolated", {
      pid: 200,
      port: 18_790,
      token: "gateway-token",
    });
    writeNativeHookRelayBridgeRecord({
      record: primary,
      stateDbPath: primaryStateDbPath,
    });
    writeNativeHookRelayBridgeRecord({
      record: secondary,
      stateDbPath: secondaryStateDbPath,
    });

    expect(fs.existsSync(primaryStateDbPath)).toBe(true);
    expect(fs.existsSync(secondaryStateDbPath)).toBe(true);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: primary.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(primary);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: secondary.relayId,
        stateDbPath: secondaryStateDbPath,
      }),
    ).toStrictEqual(secondary);
  });
});
