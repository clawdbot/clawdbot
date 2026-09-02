import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import type { VitestWorkerManifest } from "../../scripts/lib/vitest-worker-artifacts.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createVitestProcessCompletion } from "../../scripts/vitest-process-group.mts";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import {
  createWorkerArtifactTest,
  preparationClient,
  waitForFixtureFile,
  writeFixture,
} from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const repoRoot = path.resolve(import.meta.dirname, "../..");
type OwnerReceipt = { owner: number; borrower: number; generation: string };

const shutdownCases = [
  { route: "direct", phase: "disposal" },
  { route: "serial", phase: "disposal" },
  { route: "direct", phase: "admission" },
  { route: "direct", phase: "compilation" },
  { route: "serial", phase: "compilation" },
  { route: "direct", phase: "deletion" },
  { route: "serial", phase: "deletion" },
] as const;

it
  .runIf(process.platform !== "win32")
  .for(
    shutdownCases.flatMap(({ route, phase }) =>
      (["SIGINT", "SIGTERM"] as const).map((shutdownSignal) => ({ route, phase, shutdownSignal })),
    ),
  )(
  "$route wrapper joins $phase work before honoring $shutdownSignal",
  ({ route, phase, shutdownSignal }, { workerArtifacts, signal, onTestFinished }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const expectedExitCode = shutdownSignal === "SIGINT" ? 130 : 143;
      const root = workerArtifacts.fixtureDirectory();
      const input = writeFixture(root, "input", "owned verification input");
      const released = path.join(root, "release");
      const ownerFile = path.join(root, "owner.json");
      const compilerFile = path.join(root, "compiler.json");
      const compiling = path.join(root, "compiler-ready");
      const compilerCanceled = path.join(root, "compiler-canceled");
      const admitted = path.join(root, "verification-ready");
      const borrowerClosed = path.join(root, "borrower-closed");
      const borrowerExit = path.join(root, "borrower-exit");
      const ownerIdle = path.join(root, "owner-idle");
      const loopRequest = path.join(root, "loop-request");
      const responsive = path.join(root, "loop-responsive");
      const abort = new AbortController();
      const release = () => fs.writeFileSync(released, "release");
      const compiler = writeFixture(
        root,
        "compiler.mjs",
        `
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory=process.argv[2];
if(${JSON.stringify(phase)}==='compilation') {
  const keepAlive=setInterval(()=>{},1000);
  await new Promise(resolve=>{
    process.once('SIGTERM',()=>{
      fs.writeFileSync(${JSON.stringify(compilerCanceled)},'canceled');
      clearInterval(keepAlive);resolve();
    });
    fs.writeFileSync(${JSON.stringify(compiling)},'ready');
  });
  process.exit(0);
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const output='export const fixture = true;';
fs.mkdirSync(path.join(directory,'dist'));
fs.writeFileSync(path.join(directory,'dist','worker.js'),output);
const inputs={ [${JSON.stringify(input)}]:hash(fs.readFileSync(${JSON.stringify(input)})) };
const outputs={'worker.js':hash(output)};
fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({
  identity:hash(JSON.stringify([inputs,outputs])),inputs,outputs,durationMs:0,
}));
`,
      );
      const borrower = writeFixture(
        root,
        "borrower.mjs",
        `
import fs from 'node:fs';
import {requestVitestWorkerArtifacts} from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/vitest-worker-artifacts.mts")).href)};
const exitFile=${JSON.stringify(borrowerExit)};
const exitCheck=()=>{if(fs.existsSync(exitFile)) process.exit(1);};
if(${JSON.stringify(phase)}==='admission') {
  fs.watchFile(exitFile,{interval:50},exitCheck);
  exitCheck();
}
try {
  await requestVitestWorkerArtifacts();
  console.log('fixture borrower completed');
} catch(error) {
  console.error(error);process.exitCode=1;
} finally {fs.unwatchFile(exitFile,exitCheck);process.disconnect();}
`,
      );
      const preload = writeFixture(
        root,
        "preload.mjs",
        `
import cp from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const root=${JSON.stringify(root)}, input=${JSON.stringify(input)};
// CI workspaces need not provide native directory notifications. Control-file
// readiness must remain observable without that optional filesystem facility.
const nativeWatch=fs.watch;
fs.watch=(directory,...args)=>{
  if(directory===root) throw new Error('Native fixture notifications unavailable');
  return nativeWatch(directory,...args);
};
const publish=(name,value)=>{
  const filename=path.join(root,name);
  fs.writeFileSync(filename+'.tmp',JSON.stringify(value));
  fs.renameSync(filename+'.tmp',filename);
};
const spawn=cp.spawn;
const phase=${JSON.stringify(phase)};
let borrowerClosed=false, held=false, generation;
cp.spawn=(bin,args,options)=>{
  if(args[0]===${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-worker-compiler.mts"))}) {
    const child=spawn(bin,[${JSON.stringify(compiler)},args[1]],options);
    publish('compiler.json',{pid:child.pid});
    return child;
  }
  const bootstrap=args.indexOf(${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-worker-bootstrap.mts"))});
  if(bootstrap<0) return spawn(bin,args,options);
  const child=spawn(bin,[${JSON.stringify(borrower)}],options);
  child.once('close',(code,signal)=>{borrowerClosed=true;publish('borrower-closed',{pid:child.pid,code,signal});});
  generation=args[bootstrap+1];
  publish('owner.json',{owner:process.pid,borrower:child.pid,generation});
  return child;
};
// Node can cache process.emit before a preload replaces it. Probe held I/O
// directly; adding a signal listener could rescue a broken wrapper instead.
const waitForRelease=()=>new Promise(resolve=>{
  let idle=false, responsive=false;
  const controls=${JSON.stringify([borrowerClosed, loopRequest, released])};
  const check=()=>{
    if(borrowerClosed && !idle) {idle=true;publish('owner-idle',{owner:process.pid});}
    if(!responsive && fs.existsSync(${JSON.stringify(loopRequest)})) {
      responsive=true;publish('loop-responsive',{owner:process.pid});
    }
    if(fs.existsSync(${JSON.stringify(released)})) {
      for(const filename of controls) fs.unwatchFile(filename,check);
      resolve();
    }
  };
  for(const filename of controls) fs.watchFile(filename,{interval:50},check);
  check();
});
const readFile=fsp.readFile;
fsp.readFile=async(filename,...args)=>{
  if(filename===input && !held && (phase==='admission' || (phase==='disposal' && borrowerClosed))) {
    held=true;
    publish('verification-ready',{owner:process.pid});
    await waitForRelease();
  }
  return readFile(filename,...args);
};
// The same delayed deletion blocks synchronous callers but lets async callers
// process signals. Neither path may finish until the external fixture releases it.
const rm=fsp.rm, rmSync=fs.rmSync;
fsp.rm=async(filename,...args)=>{
  if(phase==='deletion' && filename===generation) {
    publish('verification-ready',{owner:process.pid});
    await waitForRelease();
  }
  return rm(filename,...args);
};
fs.rmSync=(filename,...args)=>{
  if(phase==='deletion' && filename===generation) {
    publish('verification-ready',{owner:process.pid});
    const wait=new Int32Array(new SharedArrayBuffer(4));
    while(!fs.existsSync(${JSON.stringify(released)})) Atomics.wait(wait,0,0,10);
  }
  return rmSync(filename,...args);
};
syncBuiltinESMExports();
`,
      );
      const config = writeFixture(root, "vitest.config.mjs", "export default {};\n");
      const args =
        route === "direct"
          ? ["scripts/run-vitest.mjs", "run", "--config", config]
          : [
              "--import",
              "./scripts/tsx.mjs",
              "scripts/test-projects-serial.mts",
              "test/scripts/vitest-worker-shutdown.test.ts",
            ];
      // Keep the wrappers, IPC and process owners real; only expensive child
      // executables and one verification read or deletion are controlled by the fixture.
      const command = workerArtifacts.fixtureLifetime.track(
        runNodeScript(
          args,
          {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          20_000,
          {
            cwd: repoRoot,
            signal: AbortSignal.any([signal, abort.signal]),
            maxBuffer: 2 * 1024 * 1024,
            requireProcessTreeExit: true,
          },
        ),
      );
      onTestFinished(async () => {
        release();
        abort.abort();
        await command;
      });
      const waitForReceipt = (filename: string) =>
        withTestTimeout(
          waitForFixtureFile(filename, command),
          10_000,
          `Missing shutdown receipt: ${filename}`,
        );
      let owner: OwnerReceipt | undefined;
      try {
        // Child readiness can beat the parent's PID receipts. Join every required
        // receipt within the command's existing startup deadline before reading them.
        const ready = phase === "compilation" ? compiling : admitted;
        await Promise.all(
          [ready, ownerFile, compilerFile].map((filename) => waitForFixtureFile(filename, command)),
        );
        owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as OwnerReceipt;
        const compilerPid = (JSON.parse(fs.readFileSync(compilerFile, "utf8")) as { pid: number })
          .pid;
        if (phase === "compilation") {
          expect(isProcessAlive(compilerPid)).toBe(true);
          expect(fs.existsSync(path.join(owner.generation, "manifest.json"))).toBe(false);
          // Only the borrower dies. Its completion must let the invocation cancel
          // the compiler, rather than waiting for that compiler before disposal.
          process.kill(owner.borrower, shutdownSignal);
          await waitForReceipt(compilerCanceled);
          expect(fs.readFileSync(compilerCanceled, "utf8")).toBe("canceled");
          expect(fs.existsSync(released)).toBe(false);
        } else {
          expect(JSON.parse(fs.readFileSync(admitted, "utf8"))).toEqual({ owner: owner.owner });
          if (phase === "admission") {
            // An ordinary borrower failure cannot supply the owner's signal status.
            // Observe a loop turn after close before interrupting the retained owner.
            fs.writeFileSync(borrowerExit, "exit");
            await waitForReceipt(borrowerClosed);
            expect(JSON.parse(fs.readFileSync(borrowerClosed, "utf8"))).toMatchObject({
              code: 1,
              signal: null,
            });
            await waitForReceipt(ownerIdle);
          }
          expect(isProcessAlive(owner.borrower)).toBe(false);
          expect(isProcessAlive(compilerPid)).toBe(false);
          expect(fs.existsSync(path.join(owner.generation, "manifest.json"))).toBe(true);

          process.kill(owner.owner, shutdownSignal);
          fs.writeFileSync(loopRequest, "probe");
          await waitForReceipt(responsive);
          expect(JSON.parse(fs.readFileSync(responsive, "utf8"))).toEqual({ owner: owner.owner });
          expect(isProcessAlive(owner.owner)).toBe(true);
          expect(fs.existsSync(owner.generation)).toBe(true);
          expect(fs.existsSync(released)).toBe(false);
          release();
        }
        const result = await command;
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(expectedExitCode);
        expect(result.stdout.includes("fixture borrower completed")).toBe(
          phase === "disposal" || phase === "deletion",
        );
        const trailer = `[test] FAILED (exit ${expectedExitCode})`;
        expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([trailer]);
        expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
        expect(fs.existsSync(owner.generation)).toBe(false);
      } finally {
        release();
        abort.abort();
        const result = await command;
        if (result.error) {
          console.error(result.error, result.stderr);
        }
        owner ??= fs.existsSync(ownerFile)
          ? (JSON.parse(fs.readFileSync(ownerFile, "utf8")) as OwnerReceipt)
          : undefined;
        if (owner) {
          const compilerPid = fs.existsSync(compilerFile)
            ? (JSON.parse(fs.readFileSync(compilerFile, "utf8")) as { pid: number }).pid
            : undefined;
          for (const pid of [owner.owner, owner.borrower, compilerPid]) {
            if (pid === undefined) {
              continue;
            }
            await waitForDead(pid, 5_000);
            await expect
              .poll(() =>
                inspectManagedProcessGroup(
                  { pid, exitCode: expectedExitCode },
                  { errorPolicy: "indeterminate" },
                ),
              )
              .toBe("dead");
          }
          fs.rmSync(owner.generation, { recursive: true, force: true });
        }
      }
    }),
);

it("rejects a live borrower when its owner closes during verification", ({
  workerArtifacts,
  signal,
}) =>
  workerArtifacts.fixtureLifetime.run(async () => {
    const { observeChild } = workerArtifacts.createFixtureCommands();
    const owner = createVitestWorkerRun();
    const directory = owner.descriptor.directory;
    const manifestFile = path.join(directory, "manifest.json");
    const started = createDeferred();
    const release = createDeferred();
    const readFile = fs.promises.readFile.bind(fs.promises);
    let held = false;
    const reader = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
      const filename = args[0];
      if (
        !held &&
        typeof filename === "string" &&
        filename !== manifestFile &&
        fs.existsSync(manifestFile)
      ) {
        const manifest: VitestWorkerManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        if (Object.hasOwn(manifest.inputs, filename)) {
          held = true;
          started.resolve();
          await release.promise;
        }
      }
      return readFile(...args);
    });
    const stop = () => {
      release.resolve();
      // Disposal must also start when a broken fixture times out before admission.
      void owner.dispose().catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", preparationClient], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const completion = observeChild(
        child,
        owner.borrow(
          child,
          createVitestProcessCompletion({
            child,
            detached: process.platform !== "win32",
          }),
        ),
      );
      void workerArtifacts.fixtureLifetime.verifyCleanup(async () => {
        await completion;
      });
      await Promise.race([
        started.promise,
        completion.then(() => {
          throw new Error("Borrower exited before verification was held");
        }),
      ]);
      let disposed = false;
      const disposal = workerArtifacts.fixtureLifetime.track(
        owner.dispose().then(() => {
          disposed = true;
        }),
      );
      await nextTurn();
      expect(disposed).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(fs.existsSync(directory)).toBe(true);
      release.resolve();
      expect(await completion, stderr).toEqual({ code: 1, signal: null });
      expect(stderr).toContain("owner is closing");
      await disposal;
      expect(fs.existsSync(directory)).toBe(false);
    } finally {
      signal.removeEventListener("abort", stop);
      release.resolve();
      try {
        await owner.dispose();
      } finally {
        reader.mockRestore();
      }
    }
  }));
