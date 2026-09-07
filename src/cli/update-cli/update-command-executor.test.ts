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
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { waitForPidToExit } from "../../test-utils/process-tree.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
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

describe("candidate executor delegation", () => {
  const moduleUrl = new URL("./update-command-executor.ts", import.meta.url).href;
  const program = `
    import fs from "node:fs";
    import {setTimeout} from "node:timers/promises";
    import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(fs.readFileSync(0,"utf8"));
    await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async (fence)=>{
      process.stdout.write("admitted\\n");
      while(!fs.existsSync(input.proceed)) await setTimeout(10);
      fence.assertCurrent();
      fs.writeFileSync(input.output,"owned");
    });
  `;
  it.each([false, true])(
    "retains parent exclusion through a real child (revoked=%s)",
    async (revoked) => {
      const ready = createDeferred();
      const proceed = path.join(root, "proceed");
      const output = path.join(root, "effect");
      const work = withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        const pending = withUpdateCommandExecutorChild(fence, (grant, beforeInput) =>
          runUtf8CommandWithTimeout(
            [
              process.execPath,
              "--import",
              path.resolve("scripts/tsx.mjs"),
              "--input-type=module",
              "-e",
              program,
            ],
            {
              input: JSON.stringify({ grant, proceed, output }),
              beforeInput,
              timeoutMs: 15_000,
              killProcessTree: true,
              onOutputChunk: (chunk) => {
                if (chunk.toString().includes("admitted")) {
                  ready.resolve();
                }
              },
            },
          ),
        );
        try {
          await Promise.race([
            ready.promise,
            pending.then((result) => {
              throw new Error(result.stderr);
            }),
          ]);
          expect(() => fence.assertCurrent()).toThrow("suspended");
          const store = createManagedHandoffLeaseStore();
          const primary = store.read(root);
          expect(primary.kind).toBe("current");
          if (primary.kind !== "current") {
            throw new Error("missing primary owner");
          }
          expect(store.release(primary.lease)).toBe(false);
          if (revoked) {
            expect(store.bind(primary.lease, process.pid)).not.toBeNull();
          }
        } finally {
          fs.writeFileSync(proceed, "continue");
        }
        const result = await pending;
        expect(result.code, result.stderr).toBe(0);
        fence.assertCurrent();
      });
      if (revoked) {
        await expect(work).rejects.toThrow(/ownership|release/);
        expect(fs.existsSync(output)).toBe(false);
      } else {
        await work;
        expect(fs.readFileSync(output, "utf8")).toBe("owned");
        expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not release installation ownership while a candidate descendant is alive",
    async () => {
      let descendant: number | undefined;
      try {
        await expect(
          withUpdateCommandExecutor(randomUUID(), async (executor) => {
            const fence = await executor.enter(root);
            await withUpdateCommandExecutorChild(fence, async (grant, beforeInput) => {
              const result = await runUtf8CommandWithTimeout(
                [
                  process.execPath,
                  "-e",
                  `const fs=require('node:fs');const {spawn}=require('node:child_process');
                  JSON.parse(fs.readFileSync(0,'utf8'));
                  const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
                  child.once('message',()=>{process.stdout.write(String(child.pid));child.disconnect();child.unref();});`,
                ],
                {
                  input: JSON.stringify(grant),
                  beforeInput,
                  killProcessTree: true,
                  timeoutMs: 15_000,
                },
              );
              descendant = Number(result.stdout);
              expect(result.code, result.stderr).toBe(0);
              expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
              process.kill(descendant, 0);
              return result;
            });
          }),
        ).rejects.toThrow(/settled|release/);
        const store = createManagedHandoffLeaseStore();
        expect(store.acquire(root, "next-owner", { kind: "update" }).kind).toBe("busy");
      } finally {
        if (descendant) {
          process.kill(descendant, "SIGTERM");
          await waitForPidToExit(descendant);
        }
      }
    },
  );

  it("rejects a grant that does not match the stored parent generation", async () => {
    const output = path.join(root, "effect");
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      const result = await withUpdateCommandExecutorChild(fence, (grant, beforeInput) =>
        runUtf8CommandWithTimeout(
          [
            process.execPath,
            "--import",
            path.resolve("scripts/tsx.mjs"),
            "--input-type=module",
            "-e",
            program,
          ],
          {
            input: JSON.stringify({
              grant: {
                ...grant,
                parent: { ...grant.parent, updatedAt: grant.parent.updatedAt + 1 },
              },
              output,
            }),
            beforeInput,
            timeoutMs: 15_000,
            killProcessTree: true,
          },
        ),
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("does not match its parent");
      expect(fs.existsSync(output)).toBe(false);
      fence.assertCurrent();
    });
  });

  it.skipIf(process.platform === "win32")(
    "retains a candidate group after both the updater and its direct child exit",
    async () => {
      stageManagedHandoffRuntime(root);
      const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
      const options = {
        databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
        serviceManagerEnv: resolveServiceManagerEnv(),
      };
      const command = `
        const {spawn}=require('node:child_process');
        process.stdin.once('data',()=>{
          const leaf=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
          leaf.once('message',()=>{process.stdout.write(String(leaf.pid));leaf.disconnect();leaf.unref();});
        });
      `;
      const parent = spawnSync(
        process.execPath,
        [
          "-e",
          `
        const {spawn}=require('node:child_process');
        const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
        const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
        const original=store.acquire(${JSON.stringify(root)},'parent',{kind:'update'});
        const delegation=store.acquire(${JSON.stringify(root + "/.openclaw-update-child-group")},'run',{kind:'update'});
        if(original.kind!=='acquired'||delegation.kind!=='acquired')throw new Error('admission failed');
        const child=spawn(process.execPath,['-e',${JSON.stringify(command)}],{detached:true,stdio:['pipe','pipe','inherit']});
        if(!store.bind(delegation.lease,child.pid))throw new Error('bind failed');
        child.stdout.pipe(process.stdout);child.stdin.end('start');
      `,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(parent.status, parent.stderr).toBe(0);
      const descendant = Number(parent.stdout);
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      const store = createManagedHandoffLeaseStore();
      try {
        expect(store.acquire(root, "new", { kind: "update" }).kind).toBe("busy");
      } finally {
        process.kill(descendant, "SIGTERM");
        await waitForPidToExit(descendant);
      }
      const next = store.acquire(root, "new", { kind: "update" });
      expect(next.kind).toBe("acquired");
      if (next.kind === "acquired") {
        expect(store.release(next.lease)).toBe(true);
      }
    },
  );

  it("does not reclaim a dead parent while its delegated child is alive", async () => {
    stageManagedHandoffRuntime(root);
    const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
    const options = {
      databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
      serviceManagerEnv: resolveServiceManagerEnv(),
    };
    const parent = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {spawn}=require("node:child_process");
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
      const parent=store.acquire(${JSON.stringify(root)},"parent",{kind:"update"});
      const delegated=store.acquire(${JSON.stringify(root + "/.openclaw-update-child-test")},"run",{kind:"update"});
      if(parent.kind!=="acquired"||delegated.kind!=="acquired")throw new Error("admission failed");
      const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});
      child.unref();
      if(!store.bind(delegated.lease,child.pid))throw new Error("bind failed");
      process.stdout.write(String(child.pid));
    `,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(parent.status, parent.stderr).toBe(0);
    const pid = Number(parent.stdout);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    try {
      expect(createManagedHandoffLeaseStore().acquire(root, "new", { kind: "update" }).kind).toBe(
        "busy",
      );
    } finally {
      process.kill(pid, "SIGTERM");
      await waitForPidToExit(pid);
    }
    const store = createManagedHandoffLeaseStore();
    const acquired = store.acquire(root, "new", { kind: "update" });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind === "acquired") {
      expect(store.release(acquired.lease)).toBe(true);
    }
  });
});
