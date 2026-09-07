import { spawnSync } from "node:child_process";
import fs, { type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { sql } from "kysely";
import { z } from "zod";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { isPidDefinitelyDead, getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { canCleanupLegacyManagedHandoff } from "./update-managed-service-handoff-cleanup.js";

const text = z.string().min(1).max(4096);
const processIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  startIdentity: text.max(128),
});
const bootSchema = z.union([
  z.strictObject({
    platform: z.enum(["linux", "darwin"]),
    identity: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
  }),
  z.strictObject({
    platform: z.literal("win32"),
    identity: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/),
  }),
]);
const nativeLifetimeSchema = z.strictObject({
  kind: z.literal("native"),
  unit: text,
  scope: text,
  placement: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }),
    z.strictObject({
      kind: z.literal("attached"),
      invocation: z.string().regex(/^[a-f0-9]{32}$/i),
    }),
  ]),
});
const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("update") }),
  z
    .strictObject({
      kind: z.literal("triage"),
      phase: z.enum(["reserved", "running", "closing", "closed", "uncertain"]),
      lifetime: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("foreground"), boot: bootSchema }),
        nativeLifetimeSchema,
      ]),
    })
    .refine(
      (action) =>
        action.phase !== "running" ||
        action.lifetime.kind !== "native" ||
        action.lifetime.placement.kind === "attached",
    ),
]);
const payloadSchema = z.strictObject({
  version: z.literal(2),
  executor: processIdentitySchema,
  helper: processIdentitySchema,
  action: actionSchema,
});
export const triageFailureSchema = z.strictObject({
  kind: z.enum(["update", "gateway-startup"]),
  phase: z.string().max(120),
  error: z.string().max(800),
  installationRoot: text.optional(),
  expectedVersion: z.string().max(100).optional(),
  gateway: z.enum(["verify-running", "preserve"]),
});
type HandoffProcessIdentity = z.infer<typeof processIdentitySchema>;
type HandoffNativeLifetime = z.infer<typeof nativeLifetimeSchema>;
type ManagedHandoffLeaseAction = z.infer<typeof actionSchema>;
export type ManagedHandoffLease = z.infer<typeof payloadSchema> & {
  key: string;
  owner: string;
  payload: string;
  updatedAt: number;
};

function parse(value: string) {
  try {
    return payloadSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
export function resolveManagedUpdateLeaseDatabasePath(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite");
}

type LeaseRow = { owner: string; payload_json: string; updated_at: number };
type LeaseTable = LeaseRow & { install_root: string };
const leaseQueries = (db: HandoffDatabase) =>
  getNodeSqliteKysely<{ managed_update_handoffs: LeaseTable }>(db);
type LeaseRead =
  | { kind: "absent" | "unreadable" }
  | { kind: "current"; lease: ManagedHandoffLease };
type LeaseAcquisition =
  | { kind: "busy"; owner: string }
  | { kind: "acquired"; lease: ManagedHandoffLease };

/** One lease implementation, preloaded normally and sealed before package replacement. */
export function createManagedHandoffLeaseStore(
  options = {
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: resolveServiceManagerEnv(),
  },
  logger?: SqliteTransactionOptions["logger"],
) {
  const { databasePath, serviceManagerEnv } = options;
  const control = (command: string, args: string[], timeout = 5000) =>
    spawnSync(command, args, {
      env: serviceManagerEnv,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  // Lease reclamation needs ESRCH evidence; other probe errors cannot prove absence.
  const isPidAlive = (pid: number) => !isPidDefinitelyDead(pid);

  function readProcessStartIdentity(pid: number): string | null {
    const start = getFileLockProcessStartTime(
      pid,
      { ...serviceManagerEnv, LC_ALL: "C", TZ: "UTC" },
      1000,
    );
    return start === null ? null : String(start);
  }

  function processState(value: HandoffProcessIdentity) {
    if (!isPidAlive(value.pid)) {
      return "dead";
    }
    const start = readProcessStartIdentity(value.pid);
    return start === null ? "unknown" : start === value.startIdentity ? "live" : "dead";
  }
  function processIdentity(pid = process.pid): HandoffProcessIdentity {
    const startIdentity = readProcessStartIdentity(pid);
    if (!startIdentity) {
      throw new Error("managed handoff process start identity is unavailable");
    }
    return { pid, startIdentity };
  }
  function bootIdentity() {
    let value: string | undefined;
    if (process.platform === "linux") {
      value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else if (process.platform === "darwin" || process.platform === "win32") {
      const windows = process.platform === "win32";
      const result = control(
        windows ? "powershell.exe" : "/usr/sbin/sysctl",
        windows
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
            ]
          : ["-n", "kern.bootsessionuuid"],
        windows ? 5000 : 1000,
      );
      if (!result.error && result.status === 0) {
        value = result.stdout.trim();
      }
    }
    // Unknown boot identities cannot be replaced with uptime or a wall-clock guess.
    const boot = {
      platform: process.platform,
      identity: process.platform === "win32" ? value : value?.toLowerCase(),
    };
    const parsed = bootSchema.safeParse(boot);
    if (!parsed.success) {
      throw new Error("OS boot identity unavailable; run openclaw triage manually");
    }
    return parsed.data;
  }
  function properties(stdout: string | Buffer | null | undefined): Record<string, string> {
    return Object.fromEntries(
      String(stdout || "")
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
  }
  function nativeScope(life: HandoffNativeLifetime) {
    const result = control("systemctl", [
      "--user",
      "show",
      life.scope,
      "--property=Id,LoadState,ActiveState,InvocationID,ControlGroup",
    ]);
    const scope = properties(result.stdout);
    return !result.error && (result.status === 0 || scope.LoadState === "not-found") ? scope : null;
  }
  function nativeClosed(life: HandoffNativeLifetime, scope = nativeScope(life)) {
    // systemd retains populated cgroups even after failed/reset-failed. Its
    // cgroup retirement and unit GC require recursive emptiness, unlike ActiveState.
    return Boolean(
      scope &&
      scope.Id === life.scope &&
      (scope.LoadState === "not-found" ||
        (scope.LoadState === "loaded" &&
          ["inactive", "failed"].some((state) => state === scope.ActiveState) &&
          scope.ControlGroup === "" &&
          (life.placement.kind === "pending" || scope.InvocationID === life.placement.invocation))),
    );
  }
  function assertPath(stat: Stats, kind: "directory" | "file") {
    if (
      stat.isSymbolicLink() ||
      !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("managed handoff lease " + kind + " is unsafe");
    }
  }
  function withDatabase<T>(write: boolean, operation: (db: HandoffDatabase) => T): T {
    const dir = path.dirname(databasePath);
    if (write) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        throw new Error("managed handoff lease directory is unsafe");
      }
      fs.chmodSync(dir, 0o700);
    }
    assertPath(fs.lstatSync(dir), "directory");
    if (!write || fs.existsSync(databasePath)) {
      assertPath(fs.lstatSync(databasePath), "file");
    }
    const db = openNodeSqliteDatabase(databasePath, { readOnly: !write });
    try {
      setSqliteBusyTimeout(db, 5000);
      if (write) {
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .schema.createTable("managed_update_handoffs")
            .ifNotExists()
            .addColumn("install_root", "text", (column) => column.notNull().primaryKey())
            .addColumn("owner", "text", (column) => column.notNull())
            .addColumn("payload_json", "text", (column) => column.notNull())
            .addColumn("updated_at", "integer", (column) => column.notNull())
            .modifyEnd(sql`STRICT`),
        );
        fs.chmodSync(databasePath, 0o600);
      }
      return operation(db);
    } finally {
      // Canonical rollback may already close a damaged handle; keep its original error.
      if (db.isOpen) {
        db.close();
      }
    }
  }
  function row(db: HandoffDatabase, root: string) {
    return executeSqliteQueryTakeFirstSync(
      db,
      leaseQueries(db)
        .selectFrom("managed_update_handoffs")
        .select(["owner", "payload_json", "updated_at"])
        .where("install_root", "=", root),
    );
  }
  function handle(root: string, value: LeaseRow): ManagedHandoffLease {
    const payload = parse(value.payload_json);
    if (!payload || !text.safeParse(value.owner).success) {
      throw new Error(
        "existing managed handoff lease is incompatible; retain diagnostics and run openclaw triage manually",
      );
    }
    return {
      key: root,
      owner: value.owner,
      payload: value.payload_json,
      updatedAt: value.updated_at,
      ...payload,
    };
  }
  function admissionLease(root: string, value: LeaseRow | undefined) {
    // Only admission may retire a positively dead legacy row. Keep its complete
    // observation for the transaction CAS; read/handles remain strictly v2.
    const legacyDead =
      value &&
      text.safeParse(value.owner).success &&
      Number.isSafeInteger(value.updated_at) &&
      value.updated_at >= 0 &&
      canCleanupLegacyManagedHandoff(value.payload_json, processState);
    return value && !legacyDead ? handle(root, value) : null;
  }
  function deleteRow(db: HandoffDatabase, root: string, value: LeaseRow) {
    return (
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .deleteFrom("managed_update_handoffs")
          .where("install_root", "=", root)
          .where("owner", "=", value.owner)
          .where("payload_json", "=", value.payload_json)
          .where("updated_at", "=", value.updated_at),
      ).numAffectedRows === 1n
    );
  }
  function updateRow(
    db: HandoffDatabase,
    lease: ManagedHandoffLease,
    values: Pick<LeaseTable, "payload_json" | "updated_at"> &
      Partial<Pick<LeaseTable, "install_root">>,
  ) {
    return (
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set(values)
          .where("install_root", "=", lease.key)
          .where("owner", "=", lease.owner)
          .where("payload_json", "=", lease.payload)
          .where("updated_at", "=", lease.updatedAt),
      ).numAffectedRows === 1n
    );
  }
  function read(root: string): LeaseRead {
    try {
      if (!fs.existsSync(databasePath)) {
        return { kind: "absent" };
      }
      return withDatabase(false, (db) => {
        const value = row(db, root);
        return value ? { kind: "current", lease: handle(root, value) } : { kind: "absent" };
      });
    } catch {
      return { kind: "unreadable" };
    }
  }
  const sameRow = (a: LeaseRow | undefined, b: LeaseRow | undefined) =>
    a?.owner === b?.owner && a?.payload_json === b?.payload_json && a?.updated_at === b?.updated_at;
  function transact<T>(db: HandoffDatabase, operation: () => T): T {
    return runSqliteImmediateTransactionSync(db, operation, { logger });
  }
  function reclaimable(lease: ManagedHandoffLease) {
    const action = lease.action;
    if (action.kind === "triage" && action.lifetime.kind === "foreground") {
      const boot = bootIdentity();
      if (
        boot.platform === action.lifetime.boot.platform &&
        boot.identity !== action.lifetime.boot.identity
      ) {
        return true;
      }
      if (!["reserved", "closed"].includes(action.phase)) {
        return false;
      }
    }
    if (processState(lease.helper) !== "dead" || processState(lease.executor) !== "dead") {
      return false;
    }
    return (
      action.kind !== "triage" || action.lifetime.kind !== "native" || nativeClosed(action.lifetime)
    );
  }
  function admit(
    root: string,
    owner: string,
    payload: string,
    source?: ManagedHandoffLease,
  ): LeaseAcquisition {
    return withDatabase(true, (db) => {
      // Probe liveness before taking the write lock; commit only if both observations still match.
      const observed = row(db, root);
      const destination = admissionLease(root, observed);
      const canReplace = !destination || (destination.owner !== owner && reclaimable(destination));
      return transact(db, () => {
        if (
          source &&
          !sameRow(
            { owner: source.owner, payload_json: source.payload, updated_at: source.updatedAt },
            row(db, source.key),
          )
        ) {
          throw new Error("managed triage source changed during admission");
        }
        const latest = row(db, root);
        if (!sameRow(observed, latest)) {
          if (latest) {
            return { kind: "busy", owner: handle(root, latest).owner };
          }
          throw new Error("managed handoff lease changed during admission");
        }
        if (!canReplace) {
          return { kind: "busy", owner: destination.owner };
        }
        if (observed) {
          deleteRow(db, root, observed);
        }
        const updatedAt = Math.max(Date.now(), (source?.updatedAt ?? 0) + 1);
        if (source) {
          if (
            !updateRow(db, source, {
              install_root: root,
              payload_json: payload,
              updated_at: updatedAt,
            })
          ) {
            throw new Error("managed triage source changed during transfer");
          }
        } else {
          executeSqliteQuerySync(
            db,
            leaseQueries(db).insertInto("managed_update_handoffs").values({
              install_root: root,
              owner,
              payload_json: payload,
              updated_at: updatedAt,
            }),
          );
        }
        return {
          kind: "acquired",
          lease: handle(root, { owner, payload_json: payload, updated_at: updatedAt }),
        };
      });
    });
  }
  function acquire(
    root: string,
    owner: string,
    action: ManagedHandoffLeaseAction,
    transition = false,
  ): LeaseAcquisition {
    const helper = processIdentity();
    const payload = JSON.stringify({ version: 2, executor: helper, helper, action });
    if (!text.safeParse(root).success || !text.safeParse(owner).success || !parse(payload)) {
      throw new Error("managed handoff admission is invalid");
    }
    if (transition) {
      const result = read(root);
      if (
        result.kind !== "current" ||
        result.lease.owner !== owner ||
        result.lease.payload !== payload ||
        action.kind !== "triage" ||
        action.phase !== "reserved" ||
        action.lifetime.kind !== "native" ||
        action.lifetime.placement.kind !== "pending"
      ) {
        throw new Error("managed triage transition lost its current lease");
      }
      return { kind: "acquired", lease: result.lease };
    }
    return admit(root, owner, payload);
  }
  function current(lease: ManagedHandoffLease) {
    const result = read(lease.key);
    return (
      result.kind === "current" &&
      result.lease.owner === lease.owner &&
      result.lease.payload === lease.payload &&
      result.lease.updatedAt === lease.updatedAt
    );
  }
  function owns(lease: ManagedHandoffLease, role: "helper" | "executor" = "helper") {
    return (
      current(lease) &&
      !(
        lease.action.kind === "triage" &&
        ["closing", "closed", "uncertain"].includes(lease.action.phase)
      ) &&
      lease[role].pid === process.pid &&
      processState(lease.helper) === "live" &&
      (role === "helper" || processState(lease.executor) === "live")
    );
  }
  function cas(
    lease: ManagedHandoffLease,
    action: ManagedHandoffLeaseAction,
    executor?: HandoffProcessIdentity,
  ) {
    const payload = JSON.stringify({
      ...parse(lease.payload),
      action,
      ...(executor ? { executor, helper: lease.helper } : {}),
    });
    if (!parse(payload)) {
      return null;
    }
    return withDatabase(true, (db) => {
      const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
      return updateRow(db, lease, { payload_json: payload, updated_at: updatedAt })
        ? handle(lease.key, { owner: lease.owner, payload_json: payload, updated_at: updatedAt })
        : null;
    });
  }
  function bind(lease: ManagedHandoffLease, pid: number, action = lease.action) {
    if (!owns(lease)) {
      return null;
    }
    const previous = lease.action;
    if (previous.kind === "triage") {
      if (
        previous.phase !== "reserved" ||
        action.kind !== "triage" ||
        action.phase !== "reserved" ||
        lease.executor.pid !== lease.helper.pid
      ) {
        return null;
      }
      const lifetime =
        previous.lifetime.kind === "native" &&
        action.lifetime.kind === "native" &&
        previous.lifetime.placement.kind === "pending"
          ? { ...previous.lifetime, placement: action.lifetime.placement }
          : previous.lifetime;
      if (JSON.stringify(lifetime) !== JSON.stringify(action.lifetime)) {
        return null;
      }
    } else if (action.kind !== "update") {
      return null;
    }
    return cas(lease, action, processIdentity(pid));
  }
  function retarget(
    lease: ManagedHandoffLease,
    root: string,
    action: ManagedHandoffLeaseAction,
  ): LeaseAcquisition | null {
    if (
      !owns(lease, "executor") ||
      lease.helper.pid !== process.pid ||
      lease.action.kind !== "update" ||
      action.kind !== "triage" ||
      action.phase !== "reserved" ||
      action.lifetime.kind !== "native" ||
      action.lifetime.placement.kind !== "pending"
    ) {
      return null;
    }
    const payload = JSON.stringify({
      version: 2,
      executor: lease.helper,
      helper: lease.helper,
      action,
    });
    if (!text.safeParse(root).success || !parse(payload) || fs.realpathSync(root) !== root) {
      throw new Error("managed triage destination is not canonical");
    }
    if (root === lease.key) {
      const next = cas(lease, action, lease.helper);
      return next ? { kind: "acquired", lease: next } : null;
    }
    return admit(root, lease.owner, payload, lease);
  }
  function activate(lease: ManagedHandoffLease) {
    if (
      !owns(lease) ||
      processState(lease.executor) !== "live" ||
      lease.executor.pid === lease.helper.pid ||
      lease.action.kind !== "triage" ||
      lease.action.phase !== "reserved"
    ) {
      return null;
    }
    return cas(lease, { ...lease.action, phase: "running" });
  }
  function readGeneration(lease: ManagedHandoffLease) {
    const result = read(lease.key);
    if (result.kind !== "current") {
      return null;
    }
    const active = result.lease;
    return lease.action.kind === "triage" &&
      active.action.kind === "triage" &&
      lease.owner === active.owner &&
      JSON.stringify(lease.helper) === JSON.stringify(active.helper) &&
      JSON.stringify(lease.executor) === JSON.stringify(active.executor) &&
      JSON.stringify(lease.action.lifetime) === JSON.stringify(active.action.lifetime)
      ? { ...active, action: active.action }
      : null;
  }
  function settle(lease: ManagedHandoffLease, phase: "closing" | "closed" | "uncertain") {
    const active = readGeneration(lease);
    if (!active) {
      return null;
    }
    const actor =
      active.helper.pid === process.pid && phase !== "closed" ? active.helper : active.executor;
    if (actor.pid !== process.pid || processState(actor) !== "live") {
      return null;
    }
    if (phase === "closed") {
      if (!["running", "closing"].includes(active.action.phase)) {
        return null;
      }
    } else if (
      active.action.phase === "uncertain" ||
      (phase === "closing" && ["closing", "closed"].includes(active.action.phase))
    ) {
      return active;
    }
    return cas(active, { ...active.action, phase });
  }
  function release(lease: ManagedHandoffLease) {
    if (!current(lease)) {
      return false;
    }
    const localHelper = lease.helper.pid === process.pid && processState(lease.helper) === "live";
    const action = lease.action;
    const executorClosed =
      lease.executor.pid === process.pid || processState(lease.executor) === "dead";
    const closed = localHelper
      ? action.kind === "update"
        ? executorClosed
        : action.lifetime.kind === "foreground"
          ? ["reserved", "closed"].includes(action.phase) && executorClosed
          : nativeClosed(action.lifetime)
      : reclaimable(lease);
    if (!closed) {
      return false;
    }
    return withDatabase(true, (db) =>
      deleteRow(db, lease.key, {
        owner: lease.owner,
        payload_json: lease.payload,
        updated_at: lease.updatedAt,
      }),
    );
  }
  function stopNative(lease: ManagedHandoffLease, ownPlacement = false) {
    const life = lease.action.kind === "triage" && lease.action.lifetime;
    if (
      !life ||
      life.kind !== "native" ||
      (life.placement.kind !== "attached" && !ownPlacement) ||
      (!ownPlacement && !current(lease))
    ) {
      return false;
    }
    if (
      ownPlacement &&
      (![lease.helper.pid, lease.executor.pid].includes(process.pid) ||
        processState(lease.helper.pid === process.pid ? lease.helper : lease.executor) !== "live" ||
        !fs
          .readFileSync("/proc/self/cgroup", "utf8")
          .trim()
          .endsWith("/" + life.scope))
    ) {
      return false;
    }
    const scope = nativeScope(life);
    if (nativeClosed(life, scope)) {
      return true;
    }
    if (
      !scope ||
      scope.Id !== life.scope ||
      (life.placement.kind === "attached" && scope.InvocationID !== life.placement.invocation) ||
      (!ownPlacement && !current(lease))
    ) {
      return false;
    }
    const result = control(
      "systemctl",
      ["--user", ...(ownPlacement ? ["--no-block"] : []), "stop", life.scope],
      30000,
    );
    return !result.error && result.status === 0 && (ownPlacement || nativeClosed(life));
  }
  return {
    transact,
    read,
    acquire,
    bind,
    retarget,
    activate,
    owns,
    current,
    readGeneration,
    settle,
    release,
    stopNative,
    processIdentity,
    readProcessStartIdentity,
    isPidAlive,
    bootIdentity,
    properties,
    validFailure: (value: unknown) => triageFailureSchema.safeParse(value).success,
  };
}
