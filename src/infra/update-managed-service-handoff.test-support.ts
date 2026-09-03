import type { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Writable } from "node:stream";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";

export type MockManagedUpdateHandoffLeaseFailure =
  | "absent"
  | "malformed"
  | "wrong-owner"
  | "dead-helper";

export function signalMockManagedUpdateHandoffReady(params: {
  child: EventEmitter & { pid: number; stdout: Pick<Writable, "destroyed" | "write"> };
  paramsPath: string;
  cleanups: Set<() => void>;
  startIdentity?: number;
  failure?: MockManagedUpdateHandoffLeaseFailure;
}): void {
  const { child, cleanups, failure } = params;
  if (child.stdout.destroyed) {
    return;
  }
  const lease = JSON.parse(fs.readFileSync(params.paramsPath, "utf8")) as {
    updateLeaseDatabasePath: string;
    updateLeaseKey: string;
    updateLeaseOwner: string;
  };
  const startIdentity = params.startIdentity ?? getFileLockProcessStartTime(child.pid);
  if (startIdentity === null) {
    throw new Error("expected the mocked handoff child to have a live process identity");
  }
  fs.mkdirSync(path.dirname(lease.updateLeaseDatabasePath), { recursive: true, mode: 0o700 });
  const owner =
    failure === "wrong-owner" ? `${lease.updateLeaseOwner}-replacement` : lease.updateLeaseOwner;
  const payload = JSON.stringify({
    version: 1,
    pid: failure === "dead-helper" ? child.pid + 1_000_000 : child.pid,
    startIdentity: failure === "malformed" ? null : String(startIdentity),
  });
  const db = new DatabaseSync(lease.updateLeaseDatabasePath);
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(lease.updateLeaseDatabasePath, 0o600);
    }
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(
      "CREATE TABLE IF NOT EXISTS managed_update_handoffs " +
        "(install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, " +
        "payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT",
    );
    if (failure !== "absent") {
      db.prepare(
        "INSERT INTO managed_update_handoffs " +
          "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(install_root) DO UPDATE SET updated_at = excluded.updated_at " +
          "WHERE owner = excluded.owner AND payload_json = excluded.payload_json",
      ).run(lease.updateLeaseKey, owner, payload, Date.now());
    }
  } finally {
    db.close();
  }
  if (failure !== "absent") {
    const cleanup = () => {
      cleanups.delete(cleanup);
      const cleanupDb = new DatabaseSync(lease.updateLeaseDatabasePath);
      try {
        cleanupDb.exec("PRAGMA busy_timeout = 5000;");
        cleanupDb
          .prepare(
            "DELETE FROM managed_update_handoffs " +
              "WHERE install_root = ? AND owner = ? AND payload_json = ?",
          )
          .run(lease.updateLeaseKey, owner, payload);
      } finally {
        cleanupDb.close();
      }
    };
    cleanups.add(cleanup);
    child.once("exit", cleanup);
  }
  child.stdout.write("OPENCLAW_UPDATE_HANDOFF_READY\n");
}
