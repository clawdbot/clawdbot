import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../infra/update-managed-service-handoff-runtime.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let temporary: string;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-executor-"));
  temporary = path.join(root, "private-tmp");
  fs.mkdirSync(temporary, { mode: 0o700 });
  // Select only the private database location; the lease, process-start checks,
  // and exact-row comparisons are the production owner.
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function replaceOwner() {
  const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
  try {
    db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
      "replacement",
      root,
    );
  } finally {
    db.close();
  }
}

describe("live update executor", () => {
  it("reclaims a dead direct executor through the existing process-liveness owner", async () => {
    stageManagedHandoffRuntime(root);
    const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
    const options = {
      databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
      serviceManagerEnv: resolveServiceManagerEnv(),
    };
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
      if(store.acquire(${JSON.stringify(root)},"dead-executor",{kind:"update"}).kind!=="acquired")throw new Error("admission failed");
    `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(createManagedHandoffLeaseStore().read(root).kind).toBe("current");
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      fence.assertCurrent();
    });
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  });

  it("borrows only a live helper's exact assigned executor and leaves release to that helper", async () => {
    stageManagedHandoffRuntime(root);
    const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
    const runId = randomUUID();
    const owner = randomUUID();
    const metadata = path.join(root, "handoff.json");
    fs.writeFileSync(
      metadata,
      JSON.stringify({ version: 1, meta: { runId, handoffId: owner, root } }),
    );
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, metadata);
    const options = {
      databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
      serviceManagerEnv: resolveServiceManagerEnv(),
    };
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
      const acquired=store.acquire(${JSON.stringify(root)},${JSON.stringify(owner)},{kind:"update"});
      if(acquired.kind!=="acquired")throw new Error("helper admission failed");
      const assigned=store.bind(acquired.lease,${process.pid});
      if(!assigned)throw new Error("helper assignment failed");
      process.once("message",()=>{
        const local=store.bind(assigned,process.pid);
        if(!local||!store.release(local))throw new Error("helper release failed");
        process.disconnect();
      });
      process.send("assigned");
    `,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    try {
      const ready = await Promise.race([
        once(child, "message").then(([message]) => message),
        exited.then(() => {
          throw new Error(`helper exited before assignment: ${stderr}`);
        }),
      ]);
      expect(ready).toBe("assigned");
      const store = createManagedHandoffLeaseStore();
      await withUpdateCommandExecutor(runId, async (executor) => {
        const fence = await executor.enter(root);
        await Promise.resolve();
        fence.assertCurrent();
      });
      const current = store.read(root);
      expect(current.kind === "current" && current.lease.owner).toBe(owner);
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => executor.enter(root)),
      ).rejects.toThrow("changed during admission");
      expect(store.read(root)).toEqual(current);
    } finally {
      if (child.connected) {
        child.send("release");
      }
      const [code] = await exited;
      expect(code, stderr).toBe(0);
    }
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  });

  it("preserves an unreadable existing coordination database without repairing it", async () => {
    const database = path.join(temporary, "managed-update-handoffs.sqlite");
    fs.writeFileSync(database, "unreadable native owner");
    const before = fs.readFileSync(database);
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => executor.enter(root)),
    ).rejects.toThrow("state is unreadable");
    expect(fs.readFileSync(database)).toEqual(before);
  });

  it("does not open the coordination database for a read-only or no-op invocation", async () => {
    await withUpdateCommandExecutor(randomUUID(), async () => "preview");
    expect(fs.readdirSync(temporary)).toEqual([]);
  });

  it("holds the existing owner across awaited execution and refuses a second local invocation", async () => {
    const admitted = createDeferred();
    const settle = createDeferred();
    const runId = randomUUID();
    let retained: UpdateRecoveryFence | undefined;
    const running = withUpdateCommandExecutor(runId, async (executor) => {
      retained = await executor.enter(root);
      retained.assertCurrent();
      admitted.resolve();
      await settle.promise;
      retained.assertCurrent();
      return "completed";
    });
    try {
      await admitted.promise;
      const store = createManagedHandoffLeaseStore();
      expect(store.read(root).kind).toBe("current");
      await expect(
        withUpdateCommandExecutor(runId, async (other) => other.enter(root)),
      ).rejects.toThrow("Another update executor");
      retained!.assertCurrent();
    } finally {
      settle.resolve();
    }
    await expect(running).resolves.toBe("completed");
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    expect(() => retained!.assertCurrent()).toThrow("no longer current");
  });

  it("rejects a changed native-owner row after an await without removing the replacement", async () => {
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        await Promise.resolve();
        replaceOwner();
        fence.assertCurrent();
      }),
    ).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
    const current = createManagedHandoffLeaseStore().read(root);
    expect(current.kind === "current" && current.lease.owner).toBe("replacement");
  });

  it("preserves the primary error and releases only its own exact owner", async () => {
    const primary = new Error("package failed");
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(root);
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  });

  it("closes saved admission methods without minting a later owner", async () => {
    const saved = await withUpdateCommandExecutor(randomUUID(), async (executor) => executor);
    await expect(saved.enter(root)).rejects.toThrow("admission is closed");
    expect(fs.readdirSync(temporary)).toEqual([]);
  });

  it("pins the originally admitted installation for the full invocation", async () => {
    const moved = path.join(root, "different-install");
    fs.mkdirSync(moved);
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      await expect(executor.enter(moved)).rejects.toThrow("installation changed");
      fence.assertCurrent();
    });
    expect(createManagedHandoffLeaseStore().read(moved)).toEqual({ kind: "absent" });
  });
});
