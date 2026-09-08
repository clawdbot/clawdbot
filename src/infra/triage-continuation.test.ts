// Real IPC/SQLite/process ownership; native placement alone uses the existing synthetic boundary.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { forceKillChildProcessTree } from "../process/child-process-tree.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";
import {
  createTriageBoundary,
  triageRuntimeNodeOptions,
} from "./update-managed-service-triage.test-support.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});
const unix = process.platform === "win32" ? it.skip : it;
const source = (entry: keyof typeof triageTestRuntimeEntrypoints) =>
  JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints[entry]).href);

function readClaim(root: string) {
  const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath(), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT owner, payload_json, updated_at FROM managed_update_handoffs WHERE install_root = ?",
      )
      .get(root);
  } finally {
    db.close();
  }
}

async function createRoot() {
  // Darwin socket paths must also fit inside the wrapper's private TMPDIR.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tc-")));
}

async function control(root: string, label: string, command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(path.join(root, `${label}.sock`));
    socket.once("connect", () => socket.end(command));
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

async function prepare(root: string, heldHandle: boolean | "stdio" = false) {
  const candidate = path.join(root, "candidate.mjs");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module","name":"openclaw"}');
  await fs.writeFile(
    path.join(root, "dist/index.js"),
    `await import(${JSON.stringify(candidate)});`,
  );
  await fs.writeFile(
    candidate,
    `
import fs from 'node:fs';
import { acceptTriageContinuation } from ${source("continuation")};
import { runUtf8CommandWithTimeout } from ${source("exec")};
const admission = await acceptTriageContinuation();
const label = admission.failure.phase;
if(process.argv[2]==='hold'){fs.writeFileSync(${JSON.stringify(root)}+'/admitted','');await new Promise(resolve=>process.once('message',resolve));}
admission.assertCurrent();
fs.writeFileSync(${JSON.stringify(root)}+'/'+label+'.cli',String(process.pid));
const result = await runUtf8CommandWithTimeout([process.execPath,${JSON.stringify(path.join(root, "family.mjs"))},label,'0'], {
  signal:admission.signal,killProcessTree:true,killSignal:'SIGINT',killGraceMs:5000,outputCapture:'tail',maxOutputBytes:1024,
});
await admission.finish(result.cleanup === 'normal' || result.cleanup === 'cooperative' ? 'closed' : 'uncertain');
process.exitCode=result.code ?? 1;
`,
  );
  if (heldHandle === true) {
    await fs.writeFile(
      candidate,
      `
import fs from 'node:fs'; import net from 'node:net'; import {mock} from 'node:test';
import {acceptTriageContinuation} from ${source("continuation")};
import {getFileLockProcessStartTime} from ${source("identity")};
mock.timers.enable({apis:['setTimeout']});
const admission=await acceptTriageContinuation(),root=${JSON.stringify(root)},label=admission.failure.phase;
const server=net.createServer(socket=>socket.once('data',async data=>{
  socket.end(); const command=String(data);
  if(command==='finish'){await admission.finish('uncertain');fs.writeFileSync(root+'/'+label+'.finished','');}
  else if(command.startsWith('tick:'))mock.timers.tick(Number(command.slice(5)));
}));
await new Promise(resolve=>server.listen(root+'/'+label+'.sock',resolve));
fs.writeFileSync(root+'/'+label+'.pids',JSON.stringify({pid:process.pid,start:getFileLockProcessStartTime(process.pid)})+'\\n');
fs.writeFileSync(root+'/'+label+'.cli',String(process.pid));
admission.signal.addEventListener('abort',()=>fs.writeFileSync(root+'/'+label+'.cancelled','held cleanup'));
`,
    );
  }
  if (heldHandle === "stdio") {
    await fs.writeFile(
      path.join(root, "stdio-writer.mjs"),
      `
import fs from 'node:fs'; import net from 'node:net';
import {getFileLockProcessStartTime} from ${source("identity")};
const root=${JSON.stringify(root)},label=process.argv[2];
fs.appendFileSync(root+'/'+label+'.pids',JSON.stringify({pid:process.pid,start:getFileLockProcessStartTime(process.pid)})+'\\n');
const server=net.createServer(socket=>socket.once('data',data=>{
  socket.end();
  if(String(data)==='report'){
    fs.writeSync(1,'retained stdout final\\n');fs.writeSync(2,'retained stderr final\\n');
    server.close();
  }
}));
await new Promise(resolve=>server.listen(root+'/'+label+'.writer.sock',resolve));
process.send('ready',()=>process.disconnect());
`,
    );
    await fs.writeFile(
      candidate,
      `
import fs from 'node:fs'; import {spawn} from 'node:child_process';
import {acceptTriageContinuation} from ${source("continuation")};
import {getFileLockProcessStartTime} from ${source("identity")};
const admission=await acceptTriageContinuation(),root=${JSON.stringify(root)},label=admission.failure.phase;
fs.writeFileSync(root+'/'+label+'.pids',JSON.stringify({pid:process.pid,start:getFileLockProcessStartTime(process.pid)})+'\\n');
const writer=spawn(process.execPath,[${JSON.stringify(path.join(root, "stdio-writer.mjs"))},label],{stdio:['ignore','inherit','inherit','ipc']});
writer.unref();
await new Promise(resolve=>writer.once('message',resolve));
await admission.finish('uncertain');
fs.writeFileSync(root+'/'+label+'.cli',String(process.pid));
`,
    );
  }
  await fs.writeFile(
    path.join(root, "family.mjs"),
    `
import fs from 'node:fs'; import net from 'node:net'; import {spawn} from 'node:child_process';
import { getFileLockProcessStartTime } from ${source("identity")};
const root=${JSON.stringify(root)},label=process.argv[2],role=Number(process.argv[3]);
fs.appendFileSync(root+'/'+label+'.pids',JSON.stringify({pid:process.pid,start:getFileLockProcessStartTime(process.pid)})+'\\n');
let child,joined;
if(role<2){child=spawn(process.execPath,[import.meta.filename,label,String(role+1)],{stdio:['ignore','ignore','ignore','ipc']});joined=new Promise(resolve=>child.once('exit',resolve));await new Promise(resolve=>child.once('message',resolve));}
let stopping=false;
async function stop(){if(stopping)return;stopping=true;if(child){child.send('stop');await joined;}if(server)await new Promise(resolve=>server.close(resolve));if(process.connected)process.disconnect();if(role===0&&label==='failed')process.exitCode=17;}
const server=role===0?net.createServer(socket=>socket.once('data',data=>{socket.end();if(String(data)==='release')void stop();})):undefined;
if(server)await new Promise(resolve=>server.listen(root+'/'+label+'.sock',resolve));
process.on('message',()=>void stop());
process.on('SIGINT',()=>fs.writeFileSync(root+'/'+label+'.cancelled','waiting for registered cleanup'));
if(process.send)process.send('ready');
`,
  );
  await fs.writeFile(
    path.join(root, "foreground.mjs"),
    `
import { triageAfterFailure } from ${source("failure")};
const kind=process.argv[2],phase=process.argv[3];
${
  heldHandle
    ? `
const {mock}=await import('node:test'); const net=await import('node:net');
mock.timers.enable({apis:['setTimeout']});
${
  heldHandle === "stdio"
    ? `
const fs=await import('node:fs'),kill=process.kill;
process.kill=function(pid,signal){
  if(signal && signal!==0)fs.appendFileSync(${JSON.stringify(path.join(root, "signals.jsonl"))},JSON.stringify({pid,signal})+'\\n');
  return kill.call(process,pid,signal);
};`
    : ""
}
const timerControl=net.createServer(socket=>socket.once('data',data=>{socket.end();mock.timers.tick(Number(String(data).slice(5)));}));
await new Promise(resolve=>timerControl.listen(${JSON.stringify(root)}+'/'+phase+'.parent.sock',resolve));
`
    : ""
}
if(process.argv[4]==='defer'){
  const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(root)}+'/'+phase+'.deferred','');
  await new Promise(resolve=>process.stdin.once('data',resolve));
}
process.stdout.write('{"status":"error","reason":"original"}\\n');
await triageAfterFailure({log:console.log,error:console.error,exit:()=>{throw new Error('original exit overwritten');}},
 {kind,phase,error:'original',installationRoot:${JSON.stringify(root)},gateway:'preserve'});
process.exitCode=7;
${heldHandle ? "timerControl.close();" : ""}
`,
  );
}

function foreground(root: string, label: string, kind = "update", defer = false) {
  const child = spawn(
    process.execPath,
    [path.join(root, "foreground.mjs"), kind, label, defer ? "defer" : "go"],
    {
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_SHELL: "",
        CODEX_THREAD_ID: "",
        OPENCLAW_UPDATE_RUN_HANDOFF: "",
        OPENCLAW_SUPERVISOR_MODE: "",
        OPENCLAW_LAUNCHD_LABEL: "",
        OPENCLAW_SYSTEMD_UNIT: "",
        OPENCLAW_STATE_DIR: path.join(root, ".openclaw"),
        OPENCLAW_CONFIG_PATH: path.join(root, ".openclaw/openclaw.json"),
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        NODE_OPTIONS: triageRuntimeNodeOptions(),
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (!defer) {
    child.stdin!.end();
  }
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      forceKillChildProcessTree(child);
    }
    await exit;
  });
  return { child, exit, output: () => ({ stdout, stderr }) };
}

unix("reports a missing foreground executable without signalling an unspawned child", async () => {
  const root = await createRoot();
  await prepare(root);
  cleanups.push(() => rescue(root));
  await fs.writeFile(
    path.join(root, "foreground.mjs"),
    `
    import {continueTriageInFreshProcess} from ${source("continuation")};
    try {
      await continueTriageInFreshProcess({
        root:${JSON.stringify(root)}, commandArgv:[${JSON.stringify(path.join(root, "missing-node"))},"triage"],
        failure:{kind:"update",phase:"missing",error:"original",installationRoot:${JSON.stringify(root)},gateway:"preserve"},
        signal:new AbortController().signal, output:()=>{}
      });
      process.exitCode=99;
    } catch(error) { console.error(String(error)); process.exitCode=7; }
  `,
  );
  const owner = foreground(root, "missing");
  expect(await owner.exit, owner.output().stderr).toEqual({ code: 7, signal: null });
  expect(owner.output().stderr).toContain("ENOENT");
});

async function live(root: string, label: string) {
  await vi.waitFor(
    async () => {
      const pids = (await fs.readFile(path.join(root, `${label}.pids`), "utf8"))
        .trim()
        .split("\n")
        .map((line) => Number(JSON.parse(line).pid));
      expect(pids).toHaveLength(3);
      expect(pids.every(isPidAlive)).toBe(true);
      await control(root, label, "ping");
    },
    { timeout: 30_000 },
  );
}
async function rescue(root: string, remove = true) {
  for (const file of await fs.readdir(root)) {
    if (!file.endsWith(".pids")) {
      continue;
    }
    for (const line of (await fs.readFile(path.join(root, file), "utf8")).trim().split("\n")) {
      const { pid, start } = JSON.parse(line);
      if (isPidAlive(pid) && getFileLockProcessStartTime(pid) === start) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
  const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
  try {
    db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(root);
  } finally {
    db.close();
  }
  if (remove) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

unix.each([
  "native-first",
  "foreground-first",
  "simultaneous",
  "foreground-pair",
  "foreground-simultaneous",
  "unsupervised-startup",
  "failed-but-drained",
  "dead-legacy",
] as const)(
  "admits one family and leaves the exact winner unchanged: %s",
  async (order) => {
    let root: string;
    let first: ReturnType<typeof foreground> | undefined;
    let simultaneous: ReturnType<typeof foreground> | undefined;
    let firstLabel = order === "failed-but-drained" ? "failed" : "first";
    let native: Awaited<ReturnType<typeof createTriageBoundary>> | undefined;
    if (
      order === "foreground-pair" ||
      order === "foreground-simultaneous" ||
      order === "unsupervised-startup" ||
      order === "failed-but-drained" ||
      order === "dead-legacy"
    ) {
      root = await createRoot();
      await prepare(root);
      cleanups.push(() => rescue(root));
      if (order === "dead-legacy") {
        const store = createManagedHandoffLeaseStore();
        const reserved = store.acquire(root, "legacy-fixture", { kind: "update" });
        expect(reserved.kind).toBe("acquired");
        const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        const exited = new Promise((resolve) => {
          child.once("exit", resolve);
        });
        const identity = store.processIdentity(child.pid);
        child.stdin.end();
        await exited;
        const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
        try {
          db.prepare(
            "UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?",
          ).run(JSON.stringify({ version: 1, ...identity }), root);
        } finally {
          db.close();
        }
      }
      first = foreground(root, firstLabel, "update", order === "foreground-simultaneous");
      if (order === "foreground-simultaneous") {
        simultaneous = foreground(root, "other", "update", true);
        first.child.stdin!.end("go");
        simultaneous.child.stdin!.end("go");
        await vi.waitFor(
          async () => {
            const files = await fs.readdir(root);
            expect(files.includes("first.pids") || files.includes("other.pids")).toBe(true);
            firstLabel = files.includes("first.pids") ? "first" : "other";
          },
          { timeout: 30_000 },
        );
      }
      await live(root, firstLabel).catch((error: unknown) => {
        throw new Error(`${String(error)}; owner output: ${JSON.stringify(first?.output())}`);
      });
    } else {
      native = await createTriageBoundary(
        "startup",
        undefined,
        undefined,
        async (candidateRoot) => {
          await prepare(candidateRoot);
          const paramsFile = path.join(candidateRoot, "handoff.json");
          const params = JSON.parse(await fs.readFile(paramsFile, "utf8"));
          params.failure.phase = "native";
          await fs.writeFile(paramsFile, JSON.stringify(params));
          if (order !== "native-first") {
            first = foreground(candidateRoot, "first");
            if (order === "foreground-first") {
              await live(candidateRoot, "first");
            }
          }
        },
      );
      root = native.root;
      cleanups.push(() => native!.cleanup());
      cleanups.push(() => rescue(root, false));
      const ready = await native.response();
      if (ready === "OPENCLAW_UPDATE_HANDOFF_READY") {
        expect(await native.control("commit")).toBe("committed");
        await live(root, "native");
      } else {
        expect(ready).toContain("HANDOFF_BUSY");
        await live(root, "first");
      }
    }
    const held = readClaim(root);
    const loser = simultaneous
      ? firstLabel === "first"
        ? simultaneous
        : first!
      : order === "foreground-first" || order === "simultaneous"
        ? first!
        : foreground(
            root,
            "loser",
            order === "unsupervised-startup" ? "gateway-startup" : "update",
          );
    const nativeWon = Boolean(
      native && (await fs.stat(path.join(root, "native.pids")).catch(() => null)),
    );
    if (nativeWon || !native) {
      expect(await loser.exit).toEqual({ code: 7, signal: null });
      expect(loser.output().stdout).toBe('{"status":"error","reason":"original"}\n');
      expect(loser.output().stderr).toContain("already owned");
    }
    expect(readClaim(root)).toEqual(held);
    const label = nativeWon ? "native" : firstLabel;
    await live(root, label);
    const pids = (await fs.readFile(path.join(root, `${label}.pids`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => Number(JSON.parse(line).pid));
    await control(root, label, "release");
    if (nativeWon) {
      await native!.exit;
    } else {
      await (firstLabel === "other" ? simultaneous! : first!).exit;
    }
    await vi.waitFor(() => expect(pids.filter(isPidAlive)).toEqual([]));
    // Native scope closure remains native-owned; foreground closed rows release immediately.
    if (!nativeWon) {
      expect(readClaim(root)).toBeUndefined();
    }
    if (order === "failed-but-drained") {
      expect(first!.output().stderr).toContain("failed (exit 17)");
      expect(first!.output().stderr).not.toContain("cleanup is uncertain");
      expect(first!.output().stdout).toBe('{"status":"error","reason":"original"}\n');
      expect(await first!.exit).toEqual({ code: 7, signal: null });
    }
    const next = foreground(root, "next");
    await live(root, "next");
    expect(readClaim(root)?.owner).not.toBe(held?.owner);
    await control(root, "next", "release");
    expect(await next.exit).toEqual({ code: 7, signal: null });
  },
  60_000,
);

unix.each(["signal", "disconnect"] as const)(
  "retains admission while separate-group cleanup is held after %s",
  async (kind) => {
    const root = await createRoot();
    await prepare(root);
    cleanups.push(() => rescue(root));
    const owner = foreground(root, "held");
    await live(root, "held");
    const loser = foreground(root, "loser", "update", true);
    await vi.waitFor(() => fs.access(path.join(root, "loser.deferred")), { timeout: 30_000 });
    const claim = readClaim(root)!;
    const payload = JSON.parse(String(claim.payload_json));
    const externalPid = Number(
      JSON.parse((await fs.readFile(path.join(root, "held.pids"), "utf8")).split("\n")[0]!).pid,
    );
    expect(payload.executor.pid).not.toBe(externalPid);
    const processGroup = (pid: number) =>
      Number(
        execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
      );
    expect(processGroup(payload.executor.pid)).not.toBe(processGroup(externalPid));
    expect(getFileLockProcessStartTime(payload.executor.pid)).not.toBeNull();
    if (kind === "signal") {
      owner.child.kill("SIGTERM");
    } else {
      // Caller death closes the real IPC channel, while the admitted CLI owns cleanup.
      owner.child.kill("SIGKILL");
      await owner.exit;
    }
    await vi.waitFor(() => fs.access(path.join(root, "held.cancelled")), { timeout: 5000 });
    loser.child.stdin!.end("go");
    expect(await loser.exit).toEqual({ code: 7, signal: null });
    expect(loser.output().stderr).toContain("already owned");
    expect(readClaim(root)?.owner).toBe(claim.owner);
    await control(root, "held", "release");
    if (kind === "signal") {
      await owner.exit;
    }
    await vi.waitFor(() => expect(isPidAlive(payload.executor.pid)).toBe(false), { timeout: 5000 });
    const next = foreground(root, "next");
    await live(root, "next");
    await control(root, "next", "release");
    await next.exit;
  },
  60_000,
);

unix.each(["abort", "owner-disconnect", "terminal-disconnect"] as const)(
  "bounds a held CLI handle after %s without certifying extinction",
  async (boundary) => {
    const root = await createRoot();
    await prepare(root, true);
    cleanups.push(() => rescue(root));
    const owner = foreground(root, "held");
    await vi
      .waitFor(() => fs.access(path.join(root, "held.cli")), { timeout: 30_000 })
      .catch((error: unknown) => {
        throw new Error(`${String(error)}; owner output: ${JSON.stringify(owner.output())}`);
      });
    expect(owner.child.exitCode).toBeNull();
    expect(owner.output().stdout).toBe('{"status":"error","reason":"original"}\n');
    expect(owner.output().stderr).toContain("Automatic triage is preparing the installed CLI");
    const held = readClaim(root)!;
    const executor = JSON.parse(String(held.payload_json)).executor;
    if (boundary === "abort") {
      owner.child.kill("SIGTERM");
    } else if (boundary === "owner-disconnect") {
      owner.child.kill("SIGKILL");
      await owner.exit;
    } else {
      await control(root, "held", "finish");
      await vi.waitFor(() => fs.access(path.join(root, "held.finished")));
    }
    await vi.waitFor(() => fs.access(path.join(root, "held.cancelled")), { timeout: 5000 });
    const timerOwner = boundary === "owner-disconnect" ? "held" : "held.parent";
    await control(root, timerOwner, "tick:29999");
    expect(isPidAlive(executor.pid)).toBe(true);
    expect(readClaim(root)?.owner).toBe(held.owner);
    await control(root, timerOwner, "tick:1");
    await vi.waitFor(() => expect(isPidAlive(executor.pid)).toBe(false), { timeout: 5000 });
    if (boundary !== "owner-disconnect") {
      expect(await owner.exit).toEqual({ code: 7, signal: null });
      expect(owner.output().stdout).toBe('{"status":"error","reason":"original"}\n');
      expect(owner.output().stderr).toContain("cleanup is uncertain");
    }
    const fenced = readClaim(root)!;
    expect(JSON.parse(String(fenced.payload_json)).action.phase).toBe("uncertain");
    const loser = foreground(root, "loser");
    expect(await loser.exit).toEqual({ code: 7, signal: null });
    expect(loser.output().stderr).toContain("already owned");
    expect(readClaim(root)).toEqual(fenced);
  },
  60_000,
);

unix.each(["abrupt-executor", "replacement"] as const)(
  "does not release uncertain or replaced work after %s",
  async (kind) => {
    const root = await createRoot();
    await prepare(root);
    cleanups.push(() => rescue(root));
    const owner = foreground(root, "held");
    await live(root, "held");
    const loser = foreground(root, "loser", "update", true);
    await vi.waitFor(() => fs.access(path.join(root, "loser.deferred")), { timeout: 30_000 });
    const held = readClaim(root)!;
    const payload = JSON.parse(String(held.payload_json));
    if (kind === "abrupt-executor") {
      process.kill(payload.executor.pid, "SIGKILL");
      expect(await owner.exit).toEqual({ code: 7, signal: null });
      expect(owner.output().stderr).toContain("cleanup is uncertain");
    } else {
      const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
      try {
        db.prepare(
          "UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ? AND owner = ?",
        ).run("replacement-generation", root, String(held.owner));
      } finally {
        db.close();
      }
      await vi.waitFor(() => fs.access(path.join(root, "held.cancelled")), { timeout: 5000 });
    }
    const fenced = readClaim(root);
    loser.child.stdin!.end("go");
    await loser.exit;
    expect(loser.output().stderr).toContain("already owned");
    expect(readClaim(root)).toEqual(fenced);
    await control(root, "held", "release");
    if (kind === "replacement") {
      await owner.exit;
    }
    expect(readClaim(root)).toEqual(fenced);
  },
  60_000,
);

unix.each([
  "missing-root",
  "wrong-root",
  "wrong-generation",
  "old-wire",
  "extra-field",
  "revoked",
  "revoked-after-admission",
] as const)(
  "refuses private child admission before any fixing work: %s",
  async (fault) => {
    const root = await createRoot();
    await prepare(root);
    cleanups.push(() => rescue(root));
    const store = createManagedHandoffLeaseStore();
    const acquired = store.acquire(root, "admission-fixture", {
      kind: "triage",
      phase: "reserved",
      lifetime: { kind: "foreground", boot: store.bootIdentity() },
    });
    if (acquired.kind !== "acquired") {
      throw new Error("fixture admission busy");
    }
    const child = spawn(
      process.execPath,
      [path.join(root, "candidate.mjs"), fault === "revoked-after-admission" ? "hold" : "go"],
      {
        env: {
          ...process.env,
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          NODE_OPTIONS: triageRuntimeNodeOptions(),
          TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
    });
    await new Promise((resolve) => {
      child.once("message", resolve);
    });
    const bound = store.bind(acquired.lease, child.pid!);
    if (!bound) {
      throw new Error("fixture binding failed");
    }
    const running = store.activate(bound);
    if (!running) {
      throw new Error("fixture activation failed");
    }
    const message: Record<string, unknown> = {
      type: "triage",
      version: 2,
      installRoot: root,
      owner: running.owner,
      failure: {
        kind: "update",
        phase: "forbidden",
        error: "original",
        installationRoot: root,
        gateway: "preserve",
      },
    };
    if (fault === "missing-root") {
      delete message.installRoot;
    }
    if (fault === "wrong-root") {
      message.installRoot = path.dirname(root);
    }
    if (fault === "wrong-generation") {
      message.owner = "stale-generation";
    }
    if (fault === "old-wire") {
      message.version = 1;
    }
    if (fault === "extra-field") {
      message.extra = true;
    }
    if (fault === "revoked") {
      store.settle(running, "closing");
    }
    child.send(message);
    if (fault === "revoked-after-admission") {
      await vi.waitFor(() => fs.access(path.join(root, "admitted")), { timeout: 5000 });
      store.settle(running, "closing");
      child.send("go");
    }
    expect(await exited, stderr).not.toBe(0);
    await expect(fs.access(path.join(root, "forbidden.cli"))).rejects.toThrow();
    expect(readClaim(root)?.owner).toBe(running.owner);
  },
  30_000,
);

unix.each(["drained", "deadline"] as const)(
  "retains final diagnostics until inherited stdio is %s after executor exit",
  async (settlement) => {
    const root = await createRoot();
    await prepare(root, "stdio");
    cleanups.push(() => rescue(root));
    const owner = foreground(root, "pipes");
    await vi.waitFor(() => fs.access(path.join(root, "pipes.cli")), { timeout: 30_000 });
    const held = readClaim(root)!;
    const executor = JSON.parse(String(held.payload_json)).executor;
    await vi.waitFor(() => expect(isPidAlive(executor.pid)).toBe(false), { timeout: 5000 });
    const members = (await fs.readFile(path.join(root, "pipes.pids"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const writer = members.find((member) => member.pid !== executor.pid)!;
    expect(isPidAlive(writer.pid)).toBe(true);
    expect(JSON.parse(String(readClaim(root)!.payload_json)).action.phase).toBe("uncertain");
    // The terminal root cannot stand in for the still-open output handles.
    expect(owner.child.exitCode).toBeNull();
    expect(owner.output().stderr).not.toContain("retained stdout final");
    if (settlement === "drained") {
      await control(root, "pipes.writer", "report");
    } else {
      await control(root, "pipes.parent", "tick:29999");
      expect(owner.child.exitCode).toBeNull();
      expect(isPidAlive(writer.pid)).toBe(true);
      await control(root, "pipes.parent", "tick:1");
    }
    expect(await owner.exit).toEqual({ code: 7, signal: null });
    expect(owner.output().stdout).toBe('{"status":"error","reason":"original"}\n');
    expect(owner.output().stderr).toContain("cleanup is uncertain");
    if (settlement === "drained") {
      expect(owner.output().stderr).toContain("retained stdout final");
      expect(owner.output().stderr).toContain("retained stderr final");
      await vi.waitFor(() => expect(isPidAlive(writer.pid)).toBe(false));
    } else {
      expect(isPidAlive(writer.pid)).toBe(true);
    }
    const signals = (await fs.readFile(path.join(root, "signals.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(signals.filter((entry) => Math.abs(entry.pid) === executor.pid)).toEqual([]);
    const fenced = readClaim(root)!;
    expect(fenced.owner).toBe(held.owner);
    expect(JSON.parse(String(fenced.payload_json)).action.phase).toBe("uncertain");
    const loser = foreground(root, "loser");
    expect(await loser.exit).toEqual({ code: 7, signal: null });
    expect(loser.output().stderr).toContain("already owned");
    expect(readClaim(root)).toEqual(fenced);
  },
  60_000,
);
