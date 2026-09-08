// Synthetic native boundary only: real Node helpers, IPC, leases and descendants.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { buildCliRespawnPlan } from "../entry.respawn.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  triageTestRuntimeEntrypoints,
  triageMaintenanceRuntimeEntrypoints,
} from "./triage-runtime.test-support.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";
import { startManagedServiceUpdateHandoff } from "./update-managed-service-handoff.js";

export function triageRuntimeNodeOptions(): string {
  // Prepared JavaScript does not need a source loader in every fixing descendant.
  return resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.continuation).pathname.endsWith(".ts")
    ? `--import ${path.resolve("scripts/tsx.mjs")}`
    : "";
}

export async function createTriageBoundary(
  mode: "startup" | "update" = "startup",
  fault?: "scope" | "placement" | "unit",
  maintenance?: "active" | "inactive",
  beforeStart?: (root: string, env: NodeJS.ProcessEnv) => Promise<void>,
  switchRoot?: true | string,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tb-")));
  let runtimeFiles: string[];
  try {
    // No actor exists yet if the package's fallible source closure cannot be staged.
    runtimeFiles = stageManagedHandoffRuntime(root);
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  const installRoot = switchRoot ? path.join(root, "package") : root;
  const candidateRoot = switchRoot === true ? path.join(root, "checkout") : switchRoot || root;
  await fs.mkdir(installRoot, { recursive: true });
  await fs.mkdir(candidateRoot, { recursive: true });
  const events = path.join(root, "events.jsonl");
  const scopeFile = path.join(root, "scope.json");
  const primaryFile = path.join(root, "primary.json");
  const bin = path.join(root, "bin");
  const metaPath = path.join(root, "meta.json");
  const stateDir = path.join(root, ".openclaw");
  await fs.mkdir(stateDir);
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      version: 1,
      meta: { root: installRoot, handoffId: root, note: "original update" },
    }),
  );
  await fs.mkdir(bin);
  // The installed candidate can be ESM; native command fixtures remain CommonJS.
  await fs.writeFile(path.join(bin, "package.json"), '{"type":"commonjs"}');
  await fs.mkdir(path.join(root, "members"));
  await fs.mkdir(path.join(root, "controllers"));
  const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const parentExit = new Promise((resolve) => {
    parent.once("exit", resolve);
  });
  const parentPid = parent.pid!;
  const unit = "openclaw-gateway.service";
  const scope = `openclaw-triage-${path.basename(root)}.scope`;
  const updateScope = scope.replace("triage-", "update-");
  await fs.writeFile(primaryFile, JSON.stringify({ active: true, pid: parentPid }));
  await fs.writeFile(
    scopeFile,
    JSON.stringify({ name: mode === "startup" ? scope : updateScope, active: true }),
  );
  const common = `const fs = require('node:fs');
const root = ${JSON.stringify(root)};
const scopeFile = ${JSON.stringify(scopeFile)};
const primaryFile = ${JSON.stringify(primaryFile)};
if (/systemctl$|systemd-run$|launchctl$/.test(process.argv[1] || '')) {
  const controller = root + '/controllers/' + process.pid;
  fs.writeFileSync(controller, '');
  process.once('exit', () => fs.rmSync(controller, {force:true}));
}
const event = (kind, data = {}) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({kind, pid:process.pid, handoff:process.env.OPENCLAW_UPDATE_RUN_HANDOFF ?? null, sentinel:process.env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META ?? null, ...data})+'\\n');
`;
  // HOME does not fence macOS's gui/UID namespace if a service mock misses.
  await fs.writeFile(
    path.join(bin, "launchctl"),
    `#!${process.execPath}\n` +
      common +
      "event('unexpected-native', {command:'launchctl'}); process.exitCode=97;\n",
    { mode: 0o700 },
  );
  const preload = path.join(root, "placement.cjs");
  await fs.writeFile(
    preload,
    common +
      `
const read = fs.readFileSync;
const native = /systemctl$|systemd-run$|launchctl$/.test(process.argv[1] || '');
if (/maintenance.mjs$/.test(process.argv[1] || '')) event('maintenance-phase', {phase:'preload',ppid:process.ppid,sequence:0,elapsedMs:0});
if (!native) fs.writeFileSync(root + '/members/' + process.pid, String(process.pid));
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string' && /^\\/proc\\/(self|[0-9]+)\\/cgroup$/.test(file)) {
    const scope = JSON.parse(read(scopeFile, 'utf8'));
    return '0::/synthetic/' + (${JSON.stringify(fault)} === 'placement' ? 'foreign.scope' : scope.name) + '\\n';
  }
  return read.call(this, file, ...args);
};
`,
  );
  await fs.writeFile(
    path.join(bin, "systemctl"),
    `#!${process.execPath}\n` +
      common +
      `
const args = process.argv.slice(2);
const action = args.find(x => ['show','start','stop','restart','reset-failed'].includes(x));
const name = args[args.indexOf(action)+1];
const scope = JSON.parse(fs.readFileSync(scopeFile,'utf8'));
let primary = JSON.parse(fs.readFileSync(primaryFile,'utf8'));
event(action, {name});
if (action === 'show') {
  // A stopped scope retains its cgroup until its registered processes have exited.
  const populated = !scope.active && name.endsWith('.scope') && fs.readdirSync(root+'/members').some(member => {
    try { process.kill(Number(member), 0); }
    catch (error) { return error.code !== 'ESRCH'; }
    const state = require('node:child_process').spawnSync('ps', ['-o', 'stat=', '-p', member], {encoding:'utf8',timeout:1000});
    return state.error || !/^Z/.test(state.stdout.trim());
  });
  const properties = name.endsWith('.scope') ? {
    Id:scope.name, LoadState:'loaded', ActiveState:scope.active?'active':'inactive',
    PartOf:${JSON.stringify(fault)} === 'scope' ? '' : ${JSON.stringify(unit)},
    CanStart:'no', KillMode:'control-group', ControlGroup:scope.active || populated ? '/synthetic/'+scope.name : '', InvocationID:'a'.repeat(32),
  } : { Id:${JSON.stringify(unit)}, LoadState:'loaded', ActiveState:primary.active?'active':'inactive',
    MainPID:primary.active?primary.pid:0, ExecMainStartTimestampMonotonic:primary.active?'111':'0',
    InvocationID:primary.active?'b'.repeat(32):'', FragmentPath:root+(${JSON.stringify(fault)} === 'unit' && !primary.active ? '/foreign.service' : '/gateway.service') };
  process.stdout.write(Object.entries(properties).map(([k,v])=>k+'='+v).join('\\n')+'\\n');
} else if (action === 'start') {
  // Failed update restoration leaves the verified installed primary INACTIVE.
  event('restore-failed'); process.exitCode = 1;
} else if (action === 'restart') {
  event('restart-preserved', {scope:scope.name});
} else if (action === 'stop') {
  if (!name.endsWith('.scope')) {
    primary.active = false; fs.writeFileSync(primaryFile,JSON.stringify(primary));
  }
  if (name.endsWith('.scope') || scope.name.startsWith('openclaw-triage-')) {
    scope.active=false; fs.writeFileSync(scopeFile,JSON.stringify(scope));
    event('scope-stopped');
    for (const member of fs.readdirSync(root+'/members')) {
      try { process.kill(Number(member), 'SIGTERM'); } catch {}
    }
  }
}
`,
    { mode: 0o700 },
  );
  await fs.writeFile(
    path.join(bin, "systemd-run"),
    `#!${process.execPath}\n` +
      common +
      `
const args=process.argv.slice(2), index=args.findIndex(x=>!x.startsWith('--'));
const name=args.find(x=>x.startsWith('--unit=')).slice(7);
fs.writeFileSync(scopeFile,JSON.stringify({name,active:true}));
event('attached', {name});
process.execve(args[index],args.slice(index),process.env);
`,
    { mode: 0o700 },
  );
  // Existing boundary callers replace candidate.mjs before launch. A busy-root
  // contender uses its own file so it cannot overwrite the winner's candidate.
  const candidate = path.join(
    candidateRoot,
    typeof switchRoot === "string" ? `candidate-${path.basename(root)}.mjs` : "candidate.mjs",
  );
  const maintenanceProbe = await writeTriageMaintenanceProbe({ root, primaryFile, unit, events });
  const continuationModule = resolveRuntimeWorkerUrl(
    triageTestRuntimeEntrypoints.continuation,
  ).href;
  await fs.writeFile(
    candidate,
    `
import { acceptTriageContinuation } from ${JSON.stringify(continuationModule)};
import { buildCliRespawnPlan } from ${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.respawn).href)};
if (buildCliRespawnPlan()) throw new Error('Installed child would respawn and lose its IPC claim');
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const event=(kind,data={})=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({kind,pid:process.pid,handoff:process.env.OPENCLAW_UPDATE_RUN_HANDOFF ?? null,sentinel:process.env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META ?? null,...data})+'\\n');
const admission=await acceptTriageContinuation();
if (!admission) throw new Error('No live triage admission');
event('fixer', {failure:admission.failure});
if (${Boolean(maintenance)}) {
  const started=performance.now(); let sequence=0;
  const phase=(phase,data={})=>event('maintenance-phase',{phase,ppid:process.ppid,sequence:++sequence,elapsedMs:performance.now()-started,...data});
  phase('spawn-begin');
  const child=spawn(process.execPath,['--experimental-test-module-mocks',${JSON.stringify(maintenanceProbe)},${JSON.stringify(maintenance ?? "active")}],{stdio:'inherit'});
  child.once('spawn',()=>phase('spawn',{child:child.pid}));
  child.once('error',error=>phase('spawn-error',{error:String(error)}));
  const exit=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  event('maintenance-exit',exit);
}
const branch=spawn(process.execPath,['-e',${JSON.stringify(common + "event('descendant', {stateDir:process.env.OPENCLAW_STATE_DIR, workspace:process.env.OPENCLAW_WORKSPACE_DIR, shell:process.env.OPENCLAW_SHELL, compileCache:process.env.NODE_DISABLE_COMPILE_CACHE}); const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000)")}],{detached:true,stdio:'ignore'});
event('branch',{child:branch.pid});
admission.signal.addEventListener('abort',()=>{event('cancelled');void admission.finish("uncertain");process.exitCode=1;});
await new Promise(resolve=>admission.signal.addEventListener('abort',resolve,{once:true}));
`,
  );
  const updater = path.join(root, "updater.cjs");
  const failure = {
    kind: "update",
    phase: "synthetic-update",
    error: "original failure",
    installationRoot: candidateRoot,
    gateway: mode === "update" ? "preserve" : "verify-running",
  };
  await fs.writeFile(
    updater,
    common +
      `
event('updater');
process.stdout.write(JSON.stringify({status:'error',reason:'original failure'})+'\\n');
(async()=>{
  const {queueManagedUpdateTriage}=await import(${JSON.stringify(continuationModule)});
  if (${Boolean(switchRoot)}) {
    fs.renameSync(${JSON.stringify(installRoot)}, ${JSON.stringify(installRoot + ".old")});
    fs.symlinkSync(${JSON.stringify(candidateRoot)}, ${JSON.stringify(installRoot)}, 'dir');
    event('exposed');
  }
  if (!await queueManagedUpdateTriage(${JSON.stringify(failure)},[process.execPath,${JSON.stringify(candidate)},'triage'])) throw new Error('No managed queue');
  event('triage-queued');process.disconnect();process.exitCode=7;
})().catch(error=>{console.error(error);process.disconnect();process.exitCode=9;});
`,
  );
  const log = path.join(root, "handoff.log");
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  const paramsFile = path.join(root, "handoff.json");
  const helperFile = path.join(root, "handoff.cjs");
  await fs.writeFile(helperFile, await stagedHandoffScript(root));
  const childEnv = {
    ...process.env,
    HOME: root,
    OPENCLAW_HOME: "",
    OPENCLAW_PROFILE: "default",
    OPENCLAW_SUPERVISOR_MODE: "",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
    OPENCLAW_SYSTEMD_UNIT: unit,
    OPENCLAW_SHELL: "exec",
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: metaPath,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
    NODE_OPTIONS: [triageRuntimeNodeOptions(), `--require ${preload}`].filter(Boolean).join(" "),
  };
  const commandArgv = [
    process.execPath,
    mode === "startup" ? candidate : updater,
    mode === "startup" ? "triage" : "update",
  ];
  // Mirror the real handoff producer before the helper owns the child IPC channel.
  const startup = buildCliRespawnPlan({
    argv: commandArgv,
    env: childEnv,
    execArgv: [],
    execPath: commandArgv[0],
  });
  const nodeExecArgv = startup?.argv.slice(0, startup.argv.length - commandArgv.length + 1) ?? [];
  if (startup) {
    commandArgv[0] = startup.command;
  }
  const env = startup?.env ?? childEnv;
  await fs.writeFile(
    paramsFile,
    JSON.stringify({
      serviceManagerEnv: resolveServiceManagerEnv({
        ...process.env,
        HOME: root,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      }),
      nodeExecArgv,
      action: mode === "startup" ? "triage" : "update",
      failure: mode === "startup" ? { ...failure, kind: "gateway-startup" } : undefined,
      parentPid,
      parentStartIdentity: String(getFileLockProcessStartTime(parentPid)),
      parentExitTimeoutMs: 30_000,
      parentExitDeadlineAt: Date.now() + 30_000,
      cwd: root,
      commandArgv,
      commandLabel: "synthetic",
      handoffId: root,
      logPath: log,
      metaPath,
      stateDatabasePath: path.join(root, "state.sqlite"),
      nodeSqliteLocation: path.join(root, "state.sqlite"),
      updateLeaseDatabasePath: databasePath,
      updateLeaseKey: installRoot,
      updateLeaseOwner: root,
      sensitivePaths: runtimeFiles,
      serviceRecovery: { kind: "systemd", unit },
      scopeUnit: mode === "startup" ? scope : updateScope,
      systemdRun: path.join(bin, "systemd-run"),
    }),
  );
  try {
    await beforeStart?.(root, env);
  } catch (error) {
    // The caller cannot register cleanup until this fixture returns.
    parent.kill("SIGKILL");
    await parentExit;
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  const helper = spawn(process.execPath, [helperFile, paramsFile], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    stderr = "";
  helper.stdout!.on("data", (chunk) => (output += chunk.toString()));
  helper.stderr!.on("data", (chunk) => (stderr += chunk.toString()));
  // Subscribe before READY so control replies remain queued even between awaits.
  const lines = createInterface({ input: helper.stdout!, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  const response = async () => {
    const reply = await replies.next();
    if (reply.done) {
      throw new Error(
        `Handoff exited before its control reply: ${stderr} ${await fs.readFile(log, "utf8").catch(() => "")}`,
      );
    }
    return reply.value;
  };
  const exit = new Promise((resolve) => {
    helper.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const readEvents = async (): Promise<
    Array<{
      kind: string;
      pid: number;
      child?: number;
      name?: string;
      handoff?: string | null;
      sentinel?: string | null;
      result?: unknown;
      error?: string;
      failure?: { gateway: string; installationRoot: string; error: string };
    }>
  > =>
    (await fs.readFile(events, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    root,
    installRoot,
    candidateRoot,
    readLease: (key = installRoot) => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return db
          .prepare(
            "SELECT owner, payload_json, updated_at FROM managed_update_handoffs WHERE install_root = ?",
          )
          .get(key);
      } finally {
        db.close();
      }
    },
    helper,
    parent,
    exit,
    readEvents,
    output: () => output,
    stderr: () => stderr,
    log: () => fs.readFile(log, "utf8"),
    readSentinel: () => {
      const db = new DatabaseSync(path.join(root, "state.sqlite"), { readOnly: true });
      try {
        return db
          .prepare(
            "SELECT payload_json FROM gateway_restart_sentinel WHERE sentinel_key = 'current'",
          )
          .get();
      } finally {
        db.close();
      }
    },
    response,
    control: (command: string) => {
      helper.stdin!.write(command + "\n");
      return response();
    },
    native: async (action: string, target = unit) => {
      const child = spawn(path.join(bin, "systemctl"), ["--user", action, target], {
        env,
        stdio: "ignore",
      });
      await new Promise((resolve) => {
        child.once("exit", resolve);
      });
    },
    replay: async () => {
      // Replay a stale claim with prepared code, not a missing-module failure after cleanup.
      stageManagedHandoffRuntime(root);
      const child = spawn(process.execPath, [helperFile, paramsFile], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let replayOutput = "";
      child.stdout.on("data", (chunk) => (replayOutput += chunk.toString()));
      child.stderr.resume();
      await new Promise((resolve) => {
        child.once("exit", resolve);
      });
      return replayOutput;
    },
    replaceLease: (field: "owner" | "cancelled" | "scope" = "owner") => {
      const db = new DatabaseSync(databasePath);
      try {
        // Match the lease owner's bounded connection policy: contention must not
        // prevent the fault producer from applying the intended loss.
        setSqliteBusyTimeout(db, 5000);
        if (field === "owner") {
          db.prepare(
            "UPDATE managed_update_handoffs SET owner = 'replacement' WHERE install_root = ?",
          ).run(root);
        } else {
          const row = db
            .prepare("SELECT payload_json FROM managed_update_handoffs WHERE install_root = ?")
            .get(root) as { payload_json: string };
          const payload = JSON.parse(row.payload_json);
          if (field === "cancelled") {
            payload.action.phase = "closing";
          } else {
            payload.action.lifetime.placement.invocation = "c".repeat(32);
          }
          db.prepare(
            "UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?",
          ).run(JSON.stringify(payload), root);
        }
      } finally {
        db.close();
      }
    },
    members: async () =>
      Promise.all(
        (await fs.readdir(path.join(root, "members"))).map(async (pid) => ({
          pid: Number(pid),
          alive: isPidAlive(Number(pid)),
        })),
      ),
    cleanup: async () => {
      for (const pid of await fs.readdir(path.join(root, "members"))) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {}
      }
      for (const child of [helper, parent]) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
      await Promise.all([exit, parentExit]);
      // Native control children are outside the synthetic scope they stop.
      await vi.waitFor(
        async () => {
          const controllers = await fs.readdir(path.join(root, "controllers"));
          if (controllers.some((pid) => isPidAlive(Number(pid)))) {
            throw new Error("native fixture controllers are still running");
          }
        },
        { timeout: 5000, interval: 20 },
      );
      lines.close();
      const finalEvents = await readEvents();
      const db = new DatabaseSync(databasePath);
      try {
        setSqliteBusyTimeout(db, 5000);
        db.prepare("DELETE FROM managed_update_handoffs WHERE owner = ?").run(root);
      } finally {
        db.close();
      }
      await fs.rm(root, { recursive: true, force: true });
      if (finalEvents.some((event) => event.kind === "unexpected-native")) {
        throw new Error("Triage fixture attempted an unexpected native service command");
      }
    },
  };
}

let helperScript: string | undefined;
async function stagedHandoffScript(root: string): Promise<string> {
  if (helperScript) {
    return helperScript;
  }
  const captured = new Error("captured staged helper before launch");
  const writeFile = fs.writeFile;
  const staging = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (typeof args[0] === "string" && path.basename(args[0]) === "handoff.cjs") {
      if (typeof args[1] !== "string") {
        throw new Error("staged helper is not script text");
      }
      helperScript = args[1];
      throw captured;
    }
    return writeFile(...args);
  });
  try {
    await startManagedServiceUpdateHandoff({
      root,
      supervisor: null,
      restartDrainTimeoutMs: 0,
      argv1: path.join(root, "dist/index.js"),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      },
      meta: {},
    });
  } catch (error) {
    if (error !== captured) {
      throw error;
    }
  } finally {
    staging.mockRestore();
  }
  if (!helperScript) {
    throw new Error("handoff did not stage its executable");
  }
  return helperScript;
}

async function writeTriageMaintenanceProbe(params: {
  root: string;
  primaryFile: string;
  unit: string;
  events: string;
}): Promise<string> {
  const { root, primaryFile, unit, events } = params;
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  const script = path.join(root, "maintenance.mjs");
  await fs.writeFile(
    script,
    `
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mock } from 'node:test';
const root=${JSON.stringify(root)}, primaryFile=${JSON.stringify(primaryFile)};
const event=(kind,data={})=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({kind,pid:process.pid,...data})+'\\n');
const started=performance.now(); let sequence=0;
const phase=(phase,data={})=>event('maintenance-phase',{phase,ppid:process.ppid,sequence:++sequence,elapsedMs:performance.now()-started,...data});
phase('entry');
const native=async(action)=>{
  phase('native-begin',{action});
  const child=spawn('systemctl',['--user',action,${JSON.stringify(unit)}],{stdio:'ignore'});
  child.once('error',error=>phase('native-error',{error:String(error)}));
  await new Promise(resolve=>child.once('exit',resolve));
  phase('native-end',{action});
};
// Keep the real ownership/selector checks, using a synthetic account home.
const user=os.userInfo();
os.userInfo=()=>({...user,homedir:root});
const serviceUrl=${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.service).href)};
phase('service-import-begin');
const actual=await import(serviceUrl);
phase('service-import-end');
const service={
  isLoaded:async()=>{phase('isLoaded');return true;},
  readCommand:async()=>{phase('readCommand');return {programArguments:[process.execPath,root+'/dist/index.js','gateway','run'],environment:{}};},
  readRuntime:async()=>{
    phase('readRuntime');
    const primary=JSON.parse(fs.readFileSync(primaryFile,'utf8'));
    return {status:primary.active?'running':'stopped',pid:primary.active?primary.pid:undefined};
  },
  stop:()=>native('stop'),
  restart:()=>native('restart'),
};
phase('mock-begin');
mock.module(serviceUrl,{namedExports:{...actual,resolveGatewayService:()=>{phase('resolveGatewayService');return service;}}});
phase('mock-end');
phase('doctor-import-begin');
const {beginDoctorMaintenance}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.doctor).href)});
phase('doctor-import-end');
phase('update-import-begin');
const {maybeStopManagedServiceBeforeMutableUpdate}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.update).href)});
phase('update-import-end');
if(process.argv[2]==='inactive'){
  const primary=JSON.parse(fs.readFileSync(primaryFile,'utf8'));
  fs.writeFileSync(primaryFile,JSON.stringify({...primary,active:false}));
  // Exercise Linux's inactive-unit policy on macOS too. No PID/native probes
  // are needed on the corrected inactive branch; this is not native proof.
  Object.defineProperty(process,'platform',{value:'linux'});
}
try {
  phase('update-begin');
  const result=await maybeStopManagedServiceBeforeMutableUpdate({root,updateInstallKind:'package',shouldRestart:true,jsonMode:true});
  event('maintenance-result',{result:{stopped:result.stopped,inspected:result.inspected,running:result.running,blockMessage:result.blockMessage,skip:result.serviceMutationSkipMessage,kind:result.serviceUpdateVerdict?.kind}});
  phase('doctor-begin');
  const maintenance=await beginDoctorMaintenance({root,options:{repair:true},runtime:{log:()=>{},error:()=>{},exit:()=>{throw new Error('unexpected exit')}}});
  phase('doctor-release');
  await maintenance?.release();
  event('doctor-maintenance',{admitted:!!maintenance});
} catch(error){event('maintenance-refused',{error:String(error)});}
phase('mock-restore');
mock.restoreAll();
phase('done');
`,
  );
  return script;
}
