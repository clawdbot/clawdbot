import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import * as pidIdentity from "../shared/pid-alive.js";
import * as nodeSqlite from "./node-sqlite.js";
import { createManagedHandoffLeaseStore as createStore } from "./update-managed-service-handoff-lease.js";
import type {
  createManagedHandoffLeaseStore,
  ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";

const scratch: string[] = [];
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of scratch.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const unix = process.platform === "win32" ? it.skip : it;
const action = {
  kind: "triage",
  phase: "reserved",
  lifetime: {
    kind: "native",
    unit: "openclaw-gateway.service",
    scope: "openclaw-triage-test.scope",
    placement: { kind: "pending" },
  },
} as const;
type Store = ReturnType<typeof createManagedHandoffLeaseStore>;

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retarget-")));
  scratch.push(root);
  stageManagedHandoffRuntime(root);
  const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
  const from = path.join(root, "package"),
    to = path.join(root, "checkout");
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  const options = {
    databasePath: path.join(root, "lease", "state.sqlite"),
    serviceManagerEnv: resolveServiceManagerEnv(),
  };
  const store = createStore(options);
  const acquired = store.acquire(from, "original-helper", { kind: "update" });
  if (acquired.kind !== "acquired") {
    throw new Error("fixture busy");
  }
  // Exercise the transaction's observation window using real owner operations.
  const racing = (beforeBegin: () => void) => {
    let pending: (() => void) | undefined = beforeBegin;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = openDatabase(...args);
      const exec = db.exec.bind(db);
      db.exec = (sql) => {
        if (sql === "BEGIN IMMEDIATE" && pending) {
          const operation = pending;
          pending = undefined;
          operation();
        }
        return exec(sql);
      };
      return db;
    });
    return createStore(options);
  };
  const closedDestination = (
    lifetime?: Extract<ManagedHandoffLease["action"], { kind: "triage" }>["lifetime"],
    uncertain = false,
  ) => {
    // Both independent processes finish through bind/activate/complete, then exit
    // without deleting the closed row. No fabricated lease grants reclamation.
    const common = `const fs=require('node:fs'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process');
const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});`;
    const executor =
      common +
      `process.once('message',lease=>{const closed=store.settle(lease,${JSON.stringify(uncertain ? "uncertain" : "closed")});if(!closed)throw new Error('complete failed');process.send(closed,()=>process.disconnect());});`;
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        common +
          `
const acquired=store.acquire(${JSON.stringify(to)},'finished-owner',{kind:'triage',phase:'reserved',lifetime:${lifetime ? JSON.stringify(lifetime) : "{kind:'foreground',boot:store.bootIdentity()}"}});
if(acquired.kind!=='acquired')throw new Error('destination busy');
const child=spawn(process.execPath,['-e',${JSON.stringify(executor)}],{stdio:['ignore','ignore','inherit','ipc']});
child.once('message',lease=>process.stdout.write(JSON.stringify(lease)));
const bound=store.bind(acquired.lease,child.pid),running=bound&&store.activate(bound);
if(!running)throw new Error('activation failed');child.send(running);
`,
      ],
      { encoding: "utf8", timeout: 10_000, env: options.serviceManagerEnv },
    );
    expect(result.status, result.stderr).toBe(0);
    const closed = JSON.parse(result.stdout) as ManagedHandoffLease;
    expect(closed.action).toMatchObject({ phase: uncertain ? "uncertain" : "closed" });
    return closed;
  };
  return { from, to, store, source: acquired.lease, racing, closedDestination, options };
}

unix.each(["failed", "inactive"])(
  "retains an uncertain %s scope until systemd releases its cgroup",
  (activeState) => {
    const { to, store, source, options, closedDestination } = fixture();
    const lifetime = {
      ...action.lifetime,
      placement: { kind: "attached" as const, invocation: "a".repeat(32) },
    };
    const lease = closedDestination(lifetime, true);
    const bin = path.join(path.dirname(to), "bin");
    fs.mkdirSync(bin);
    options.serviceManagerEnv.PATH = bin + path.delimiter + options.serviceManagerEnv.PATH;
    const publishScope = (controlGroup?: string) => {
      const fields = [
        `Id=${lifetime.scope}`,
        "LoadState=loaded",
        `ActiveState=${activeState}`,
        `InvocationID=${lifetime.placement.invocation}`,
        ...(controlGroup === undefined ? [] : [`ControlGroup=${controlGroup}`]),
      ];
      fs.writeFileSync(
        path.join(bin, "systemctl"),
        `#!/bin/sh\nprintf '%s\\n' ${fields.map((field) => `'${field}'`).join(" ")}\n`,
        { mode: 0o700 },
      );
    };
    for (const controlGroup of [`/user.slice/${lifetime.scope}`, undefined]) {
      publishScope(controlGroup);
      expect(store.stopNative(lease)).toBe(false);
      expect(store.release(lease)).toBe(false);
      expect(store.acquire(to, "contender", { kind: "update" })).toEqual({
        kind: "busy",
        owner: lease.owner,
      });
      expect(store.retarget(source, to, action)).toEqual({ kind: "busy", owner: lease.owner });
      expect(store.read(to)).toEqual({ kind: "current", lease });
    }
    publishScope("");
    expect(store.stopNative(lease)).toBe(true);
    expect(store.release(lease)).toBe(true);
    expect(store.retarget(source, to, action)?.kind).toBe("acquired");
  },
);

unix("moves the captured source key after its realpath changes and preserves the helper", () => {
  const { from, to, store, source } = fixture();
  fs.rmdirSync(from);
  fs.symlinkSync(to, from, "dir");
  const moved = store.retarget(source, to, action);
  expect(moved?.kind).toBe("acquired");
  if (moved?.kind !== "acquired") {
    throw new Error("retarget refused");
  }
  expect(store.read(from)).toEqual({ kind: "absent" });
  expect(moved.lease).toMatchObject({
    key: to,
    owner: source.owner,
    helper: source.helper,
    executor: source.helper,
    action,
  });
  expect(store.current(source)).toBe(false);
  expect(store.current(moved.lease)).toBe(true);
});

unix("keeps same-root transition in the existing binding flow", () => {
  const { from, store, source } = fixture();
  const moved = store.retarget(source, from, action);
  expect(moved?.kind).toBe("acquired");
  if (moved?.kind !== "acquired") {
    throw new Error("retarget refused");
  }
  expect(moved.lease.key).toBe(from);
  expect(moved.lease.updatedAt).toBeGreaterThan(source.updatedAt);
  expect(store.current(moved.lease)).toBe(true);
});

unix("preserves the original error when canonical rollback closes the operation's handle", () => {
  const { from, to, store, source, options } = fixture();
  const failure = new Error("fixture commit failed");
  let damaged: DatabaseSync | undefined;
  const opener = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = openDatabase(...args);
    if (!args[1]?.readOnly) {
      damaged = db;
      const exec = db.exec.bind(db);
      db.exec = (sql) => {
        if (sql === "COMMIT") {
          throw failure;
        }
        if (sql === "ROLLBACK") {
          throw new Error("fixture rollback failed");
        }
        exec(sql);
      };
    }
    return db;
  });
  expect(() => store.retarget(source, to, action)).toThrow(failure);
  expect(damaged?.isOpen).toBe(false);
  opener.mockRestore();
  expect(store.read(from)).toEqual({ kind: "current", lease: source });
  expect(store.read(to)).toEqual({ kind: "absent" });
  const independent = openDatabase(options.databasePath);
  try {
    expect(() =>
      store.transact(independent, () =>
        store.transact(independent, () => {
          throw failure;
        }),
      ),
    ).toThrow(failure);
    expect(independent.isOpen).toBe(true);
    expect(store.transact(independent, () => "sentinel handle remains usable")).toBe(
      "sentinel handle remains usable",
    );
  } finally {
    independent.close();
  }
});

unix("refuses retarget while the update executor is still a child", async () => {
  const { to, store, source } = fixture();
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  try {
    const bound = store.bind(source, child.pid!)!;
    expect(store.retarget(bound, to, action)).toBeNull();
    expect(store.current(bound)).toBe(true);
    expect(store.read(to)).toEqual({ kind: "absent" });
  } finally {
    child.kill();
    await exited;
  }
});

unix("does not touch a destination after the source generation is lost", () => {
  const { to, store, source, racing, closedDestination } = fixture();
  closedDestination();
  const before = store.read(to);
  let current: ManagedHandoffLease | null = null;
  const other = racing(() => {
    current = store.bind(source, process.pid);
  });
  expect(() => other.retarget(source, to, action)).toThrow("source changed");
  expect(store.read(to)).toEqual(before);
  expect(store.current(current!)).toBe(true);
  expect(store.retarget(source, to, action)).toBeNull();
});

unix.each(["arrival", "generation"] as const)(
  "leaves a destination %s winner unchanged",
  (race) => {
    const { to, store, source, racing, closedDestination } = fixture();
    if (race === "generation") {
      closedDestination();
    }
    let winner: ReturnType<Store["read"]>;
    const other = racing(() => {
      expect(store.acquire(to, "winner", { kind: "update" }).kind).toBe("acquired");
      winner = store.read(to);
    });
    expect(other.retarget(source, to, action)).toEqual({ kind: "busy", owner: "winner" });
    expect(store.read(to)).toEqual(winner!);
    expect(store.current(source)).toBe(true);
  },
);

unix("reclaims a closed destination only after its real helper and executor exit", () => {
  const { from, to, store, source, closedDestination } = fixture();
  closedDestination();
  expect(store.retarget(source, to, action)?.kind).toBe("acquired");
  expect(store.read(from)).toEqual({ kind: "absent" });
  expect(store.read(to)).toMatchObject({
    kind: "current",
    lease: { owner: source.owner, helper: source.helper, action },
  });
});

unix("leaves source and destination unchanged when destination inspection is unreadable", () => {
  const { to, store, source, options } = fixture();
  expect(store.acquire(to, "winner", { kind: "update" }).kind).toBe("acquired");
  const before = store.read(to);
  const probe = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = openDatabase(...args);
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.startsWith('select "owner"')) {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = (root) => {
          if (typeof root !== "string") {
            throw new Error("expected one positional installation root");
          }
          if (root === to) {
            throw new Error("destination unreadable");
          }
          return iterate(root);
        };
      }
      return statement;
    };
    return db;
  });
  const other = createStore(options);
  try {
    expect(() => other.retarget(source, to, action)).toThrow("destination unreadable");
  } finally {
    probe.mockRestore();
  }
  expect(store.current(source)).toBe(true);
  expect(store.read(to)).toEqual(before);
});

// Released v1 claims are cleanup inputs only, never current runtime authority.
unix.each(["update", "foreground", "retarget"] as const)(
  "retires a dead legacy process only at %s admission",
  (admission) => {
    const { from, to, store, source, options } = fixture();
    const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    const pid = Number(child.stdout.trim());
    expect(() => process.kill(pid, 0)).toThrow();
    const db = new DatabaseSync(options.databasePath);
    try {
      const payload = JSON.stringify({ version: 1, pid, startIdentity: "0" });
      db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
        to,
        "legacy-owner",
        payload,
        1,
      );
      const rows = () =>
        db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all();
      const before = rows();
      expect(store.read(to)).toEqual({ kind: "unreadable" });
      expect(rows()).toEqual(before);
      const result =
        admission === "retarget"
          ? store.retarget(source, to, action)
          : store.acquire(
              to,
              "legacy-owner",
              admission === "update"
                ? { kind: "update" }
                : {
                    kind: "triage",
                    phase: "reserved",
                    lifetime: { kind: "foreground", boot: store.bootIdentity() },
                  },
            );
      expect(result?.kind).toBe("acquired");
      expect(store.read(to)).toMatchObject({ kind: "current", lease: { version: 2 } });
      // A late stable updater/helper binding must lose its expected-payload CAS.
      expect(
        db
          .prepare(
            "UPDATE managed_update_handoffs SET payload_json = ?, updated_at = ? WHERE install_root = ? AND owner = ? AND payload_json = ?",
          )
          .run(payload, 2, to, "legacy-owner", payload).changes,
      ).toBe(0);
      expect(store.read(from)).toEqual(
        admission === "retarget" ? { kind: "absent" } : { kind: "current", lease: source },
      );
    } finally {
      db.close();
    }
  },
);

unix("reclaims a legacy reused PID without granting authority to its live process", () => {
  const { to, store, options } = fixture();
  const db = new DatabaseSync(options.databasePath);
  try {
    db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
      to,
      "legacy-owner",
      JSON.stringify({ version: 1, pid: process.pid, startIdentity: "0" }),
      1,
    );
    expect(store.acquire(to, "fresh-owner", { kind: "update" }).kind).toBe("acquired");
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  } finally {
    db.close();
  }
});

unix.each([
  {
    label: "live",
    value: (identity: { pid: number; startIdentity: string }) => ({ version: 1, ...identity }),
  },
  {
    label: "missing identity",
    value: () => ({ version: 1, pid: process.pid, startIdentity: null }),
  },
  {
    label: "malformed identity",
    value: () => ({ version: 1, pid: process.pid, startIdentity: "not-a-creation-identity" }),
  },
  { label: "invalid PID", value: () => ({ version: 1, pid: -1, startIdentity: "0" }) },
  {
    label: "extra authority",
    value: () => ({ version: 1, pid: process.pid, startIdentity: "0", action: { kind: "update" } }),
  },
  { label: "non-object", value: () => [] },
])("preserves the complete $label legacy row on admission and retarget", ({ value }) => {
  const { to, store, source, options } = fixture();
  const db = new DatabaseSync(options.databasePath);
  try {
    db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
      to,
      "legacy-owner",
      JSON.stringify(value(store.processIdentity())),
      1,
    );
    const rows = () =>
      db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all();
    const before = rows();
    expect(() => store.acquire(to, "fresh-owner", { kind: "update" })).toThrow("incompatible");
    expect(() => store.retarget(source, to, action)).toThrow("incompatible");
    expect(rows()).toEqual(before);
  } finally {
    db.close();
  }
});

unix.each(["owner", "payload_json", "updated_at"] as const)(
  "preserves a legacy %s replacement between death probe and commit",
  (column) => {
    const { to, store, source, options, racing } = fixture();
    const db = new DatabaseSync(options.databasePath);
    try {
      const payload = JSON.stringify({ version: 1, pid: process.pid, startIdentity: "0" });
      const live = JSON.stringify({ version: 1, ...store.processIdentity() });
      const rows = () =>
        db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all();
      for (const admission of ["acquire", "retarget"]) {
        db.prepare("INSERT OR REPLACE INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
          to,
          "legacy-owner",
          payload,
          1,
        );
        let winner: ReturnType<typeof rows> = [];
        const other = racing(() => {
          db.prepare(`UPDATE managed_update_handoffs SET ${column} = ? WHERE install_root = ?`).run(
            column === "owner" ? "rebound-owner" : column === "payload_json" ? live : 2,
            to,
          );
          winner = rows();
        });
        expect(() =>
          admission === "acquire"
            ? other.acquire(to, "fresh-owner", { kind: "update" })
            : other.retarget(source, to, action),
        ).toThrow("incompatible");
        expect(rows()).toEqual(winner);
      }
    } finally {
      db.close();
    }
  },
);

unix("keeps the dead legacy destination when its retarget source changes", () => {
  const { to, store, source, options, racing } = fixture();
  const db = new DatabaseSync(options.databasePath);
  try {
    db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
      to,
      "legacy-owner",
      JSON.stringify({ version: 1, pid: process.pid, startIdentity: "0" }),
      1,
    );
    const destination = () =>
      db.prepare("SELECT * FROM managed_update_handoffs WHERE install_root = ?").get(to);
    const before = destination();
    const other = racing(() => {
      expect(store.bind(source, process.pid)).not.toBeNull();
    });
    expect(() => other.retarget(source, to, action)).toThrow("source changed");
    expect(destination()).toEqual(before);
  } finally {
    db.close();
  }
});

unix("does not reclaim a legacy process when its creation identity is unknown", async () => {
  const { to, store, source, options } = fixture();
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  const db = new DatabaseSync(options.databasePath);
  const readStart = pidIdentity.getFileLockProcessStartTime;
  try {
    const identity = store.processIdentity(child.pid);
    db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
      to,
      "legacy-owner",
      JSON.stringify({ version: 1, ...identity, startIdentity: "0" }),
      1,
    );
    const rows = () =>
      db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all();
    const before = rows();
    const probe = vi
      .spyOn(pidIdentity, "getFileLockProcessStartTime")
      .mockImplementation((pid, ...args) => (pid === child.pid ? null : readStart(pid, ...args)));
    try {
      expect(() => store.acquire(to, "fresh-owner", { kind: "update" })).toThrow("incompatible");
      expect(() => store.retarget(source, to, action)).toThrow("incompatible");
      expect(rows()).toEqual(before);
    } finally {
      probe.mockRestore();
    }
  } finally {
    db.close();
    child.stdin.end();
    await exited;
  }
});

unix(
  "keeps a closed v2 generation occupied while its actors live and preserves late revoke",
  async () => {
    const { to, store, source, options } = fixture();
    const acquired = store.acquire(to, "closing-owner", {
      kind: "triage",
      phase: "reserved",
      lifetime: { kind: "foreground", boot: store.bootIdentity() },
    });
    if (acquired.kind !== "acquired") {
      throw new Error("fixture busy");
    }
    const runtimeEntry = path.join(path.dirname(to), "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
    const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
    const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
    process.stdin.resume();
    process.once('message',lease=>{const closed=store.settle(lease, "closed");if(!closed)throw new Error('completion refused');process.send(closed,()=>process.disconnect());});
  `,
      ],
      { stdio: ["pipe", "ignore", "inherit", "ipc"] },
    );
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
    });
    try {
      const completed = new Promise<ManagedHandoffLease>((resolve) => {
        child.once("message", resolve);
      });
      const bound = store.bind(acquired.lease, child.pid!);
      const running = bound && store.activate(bound);
      if (!running) {
        throw new Error("activation refused");
      }
      child.send(running);
      const closed = await completed;
      expect(store.settle(running, "closing")).toEqual(closed);
      expect(store.acquire(to, "contender", { kind: "update" })).toEqual({
        kind: "busy",
        owner: closed.owner,
      });
      expect(store.retarget(source, to, action)).toEqual({ kind: "busy", owner: closed.owner });
      expect(store.read(to)).toEqual({ kind: "current", lease: closed });
      child.stdin!.end();
      await exited;
      expect(store.release(closed)).toBe(true);
      expect(store.read(to)).toEqual({ kind: "absent" });
    } finally {
      child.stdin!.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await exited;
    }
  },
);

unix(
  "reclaims a released dead process at common managed admission and cleans up on cancel",
  async () => {
    const { startManagedServiceUpdateHandoff, cancelManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } =
      await import("./update-managed-service-handoff-lease.js");
    const { to } = fixture();
    const store = createManagedHandoffLeaseStore();
    const reserved = store.acquire(to, "legacy-owner", { kind: "update" });
    expect(reserved.kind).toBe("acquired");
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
      encoding: "utf8",
    });
    expect(dead.status).toBe(0);
    const pid = Number(dead.stdout.trim());
    expect(() => process.kill(pid, 0)).toThrow();
    const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
    try {
      db.prepare("UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?").run(
        JSON.stringify({ version: 1, pid, startIdentity: "0" }),
        to,
      );
      const identity = {
        kind: "managed-update-handoff" as const,
        installRoot: to,
        handoffId: "fresh-helper",
      };
      try {
        const started = await startManagedServiceUpdateHandoff({
          root: to,
          restartDrainTimeoutMs: 300_000,
          parentPid: process.pid,
          execPath: process.execPath,
          argv1: "/unused/openclaw.mjs",
          env: { OPENCLAW_STATE_DIR: to },
          handoffId: identity.handoffId,
          meta: {},
        });
        expect(started.status).toBe("started");
        const directory = path.dirname(started.logPath);
        scratch.push(directory);
        const params = JSON.parse(
          fs.readFileSync(path.join(directory, "handoff.json"), "utf8"),
        ) as { sensitivePaths: string[] };
        await expect(cancelManagedServiceUpdateHandoff(identity)).resolves.toBe(
          "restored-in-process",
        );
        // Observe product terminal cleanup before fixture rescue removes the directories.
        expect(params.sensitivePaths.filter((file) => fs.existsSync(file))).toEqual([]);
        expect(
          db.prepare("SELECT * FROM managed_update_handoffs WHERE install_root = ?").get(to),
        ).toBeUndefined();
      } finally {
        await cancelManagedServiceUpdateHandoff(identity);
      }
    } finally {
      db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(to);
      db.close();
    }
  },
);
