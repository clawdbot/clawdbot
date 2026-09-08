import type { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Writable } from "node:stream";
import { vi } from "vitest";
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
    action: "update" | "triage";
    scopeUnit: string;
    serviceRecovery: { unit: string };
  };
  const startIdentity = params.startIdentity ?? getFileLockProcessStartTime(child.pid);
  if (startIdentity === null) {
    throw new Error("expected the mocked handoff child to have a live process identity");
  }
  fs.mkdirSync(path.dirname(lease.updateLeaseDatabasePath), { recursive: true, mode: 0o700 });
  const owner =
    failure === "wrong-owner" ? `${lease.updateLeaseOwner}-replacement` : lease.updateLeaseOwner;
  const payload = JSON.stringify({
    version: 2,
    executor: {
      pid: failure === "dead-helper" ? child.pid + 1_000_000 : child.pid,
      startIdentity: failure === "malformed" ? null : String(startIdentity),
    },
    helper: { pid: child.pid, startIdentity: String(startIdentity) },
    action:
      lease.action === "triage"
        ? {
            kind: "triage",
            phase: "reserved",
            lifetime: {
              kind: "native",
              unit: lease.serviceRecovery.unit,
              scope: lease.scopeUnit,
              placement: { kind: "attached", invocation: "a".repeat(32) },
            },
          }
        : { kind: "update" },
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

export async function writeConcurrentManagedHandoffParams(
  params: {
    tmpDir: string;
    baseParams: Record<string, unknown>;
    name: string;
    owner: string;
    commandArgv: string[];
    stateDatabasePath?: string;
    leaseDatabasePath?: string;
  },
  handoffParents: Map<string, import("node:child_process").ChildProcess>,
): Promise<string> {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { getFileLockProcessStartTime: readParentStartTime } =
    await import("../shared/pid-alive.js");
  const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const parentPid = parent.pid;
  const startIdentity = parentPid ? readParentStartTime(parentPid) : null;
  if (!parentPid || startIdentity === null) {
    parent.kill("SIGKILL");
    throw new Error("expected a parent process with a stable start identity");
  }
  const paramsPath = path.join(params.tmpDir, `${params.name}.json`);
  handoffParents.set(paramsPath, parent);
  await fs.promises.writeFile(
    paramsPath,
    `${JSON.stringify(
      {
        ...params.baseParams,
        parentPid,
        parentStartIdentity: String(startIdentity),
        parentExitTimeoutMs: 5_000,
        handoffId: params.owner,
        updateLeaseOwner: params.owner,
        stateDatabasePath: params.stateDatabasePath ?? params.baseParams.stateDatabasePath,
        updateLeaseDatabasePath:
          params.leaseDatabasePath ?? params.baseParams.updateLeaseDatabasePath,
        commandArgv: params.commandArgv,
        triageCommandArgv: [process.execPath, "-e", "process.exit(0)", "--"],
        triageContextPath: path.join(params.tmpDir, `${params.name}-failure.json`),
        logPath: path.join(params.tmpDir, `${params.name}.log`),
        sensitivePaths: [],
      },
      null,
      2,
    )}\n`,
  );
  return paramsPath;
}
