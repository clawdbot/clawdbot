import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertPathToPattern } from "tinyglobby";
import { aroundEach, describe, expect, it, vi, type TestContext } from "vitest";
import { isVitestWorkerMetadataRequest } from "../../scripts/lib/vitest-cli-mode.mts";
import { stripVitestAnsi } from "../../scripts/lib/vitest-unhandled-errors.mts";
import {
  isVitestWorkerDeclaration,
  resolveVitestWorkerDeclaration,
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import {
  createVitestWorkerRun,
  type VitestWorkerRun,
} from "../../scripts/lib/vitest-worker-run.mts";
import { resolveVitestSpawnParams, spawnWatchedVitestProcess } from "../../scripts/run-vitest.mts";
import { createVitestProcessCompletion } from "../../scripts/vitest-process-group.mts";
import { resolveRuntimeWorkerArgv } from "../../src/infra/runtime-worker-url.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const root = process.cwd();
const fixtureLifetime = createFixtureLifetime();
// onTestFinished owns cancellation and close. Drain it before removing inputs,
// and also join sibling bodies that outlive a rejected Promise.all assertion.
aroundEach(async (runTest) => {
  try {
    await runTest();
  } finally {
    await fixtureLifetime.cleanup();
  }
});
const artifacts = path.join(root, ".artifacts");
const compilerModule = "scripts/lib/vitest-worker-run.mts";
const compilerEntry = "scripts/lib/vitest-worker-compiler.mts";
const artifactsModule = "scripts/lib/vitest-worker-artifacts.mts";
const preparationClient = `
  import {requestVitestWorkerArtifacts} from ${JSON.stringify(pathToFileURL(path.join(root, artifactsModule)).href)};
  try {await requestVitestWorkerArtifacts();}
  catch (error) {console.error(error);process.exitCode=1;}
  finally {process.disconnect();}
`;
const tooling = [
  compilerModule,
  compilerEntry,
  artifactsModule,
  "scripts/lib/runtime-process-build-entries.mts",
  "scripts/lib/vitest-worker-build-entries.mts",
  "scripts/lib/state-schema-inline-plugin.mts",
  "scripts/lib/fs-safe-native-assets.mts",
];

function fixtureDirectory() {
  fs.mkdirSync(artifacts, { recursive: true });
  return fixtureLifetime.createTempDir("worker proof-", artifacts);
}

function createFixtureCommands({
  signal,
  onTestFinished,
}: Pick<TestContext, "signal" | "onTestFinished">) {
  const finished = new AbortController();
  const commandSignal = AbortSignal.any([signal, finished.signal]);
  const commands: Promise<unknown>[] = [];
  commandSignal.throwIfAborted();
  // All commands retain this body's authority, including native IPC borrowers.
  // Finishing stops child work; whole-body finally still owns generation disposal.
  onTestFinished(async () => {
    finished.abort();
    await Promise.allSettled(commands);
  });

  function observeChild<T>(child: ChildProcess, completion: Promise<T>): Promise<T> {
    const cancel = () => {
      child.kill("SIGTERM");
    };
    const joined = completion.finally(() => commandSignal.removeEventListener("abort", cancel));
    commands.push(joined);
    void joined.catch(() => {});
    commandSignal.addEventListener("abort", cancel, { once: true });
    if (commandSignal.aborted) {
      cancel();
    }
    return joined;
  }

  function node(args: string[], cwd = root, env = process.env) {
    const completion = fixtureLifetime.track(
      runNodeScript(args, env, undefined, {
        cwd,
        signal: commandSignal,
        maxBuffer: 2 * 1024 * 1024,
        requireProcessTreeExit: process.platform !== "win32",
      }).then((result) => ({ ...result, code: result.status })),
    );
    commands.push(completion);
    return completion;
  }

  function startBorrower(owner: VitestWorkerRun, args: string[], nodeArgs: string[] = []) {
    commandSignal.throwIfAborted();
    const logs = fixtureDirectory();
    const stdout = path.join(logs, "stdout.log"),
      stderr = path.join(logs, "stderr.log");
    const out = fs.openSync(stdout, "w"),
      err = fs.openSync(stderr, "w");
    const handle = spawnWatchedVitestProcess({
      workerRun: owner,
      pnpmArgs: ["exec", "node", ...nodeArgs, "node_modules/vitest/vitest.mjs", ...args],
      spawnParams: { ...resolveVitestSpawnParams(process.env), stdio: ["ignore", out, err] },
      env: process.env,
    });
    fs.closeSync(out);
    fs.closeSync(err);
    const completion = observeChild(handle.child, handle.completion);
    void fixtureLifetime.verifyCleanup(async () => {
      await completion;
    });
    return {
      ...handle,
      completion,
      result: fixtureLifetime.track(
        completion.then((result) => ({
          ...result,
          stdout: fs.readFileSync(stdout, "utf8"),
          stderr: fs.readFileSync(stderr, "utf8"),
        })),
      ),
    };
  }

  async function prepareWorkers(owner: VitestWorkerRun): Promise<VitestWorkerManifest> {
    commandSignal.throwIfAborted();
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
    void fixtureLifetime.verifyCleanup(async () => {
      await completion;
    });
    const result = await completion;
    expect(result.code, stderr).toBe(0);
    return JSON.parse(
      fs.readFileSync(path.join(owner.descriptor.directory, "manifest.json"), "utf8"),
    );
  }

  return { node, startBorrower, prepareWorkers, observeChild };
}

function writeFixture(directory: string, name: string, source: string) {
  const filename = path.join(directory, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source);
  return filename;
}

function waitForFixtureFile(filename: string, completion: Promise<unknown>, expected?: string) {
  return new Promise<void>((resolve, reject) => {
    const matches = () =>
      fs.existsSync(filename) &&
      fs.statSync(filename).size > 0 &&
      (expected === undefined || fs.readFileSync(filename, "utf8") === expected);
    const check = () => {
      if (matches()) {
        fs.unwatchFile(filename, check);
        resolve();
      }
    };
    // Readiness is the file state, including on hosts without native watch events.
    fs.watchFile(filename, { interval: 50 }, check);
    void completion.then(
      () => {
        fs.unwatchFile(filename, check);
        if (matches()) {
          resolve();
        } else {
          reject(new Error(`Child exited before writing ${filename}`));
        }
      },
      (error: unknown) => {
        fs.unwatchFile(filename, check);
        reject(new Error(`Child failed before writing ${filename}`, { cause: error }));
      },
    );
    check();
  });
}

function workerProbe(
  directory: string,
  holdSecond = false,
  mode: "compiled" | "source" | "auto" = "compiled",
  cacheProof: false | "single" | "projects" = false,
) {
  const value = writeFixture(directory, "value.ts", 'export const value: string = "first";');
  const configuredValue = writeFixture(
    directory,
    "configured-value.ts",
    'export const value: string = "configured";',
  );
  const parent = path.join(root, "src/infra/sqlite-readonly-location.ts");
  const test = writeFixture(
    directory,
    "child.test.ts",
    `
    import * as cp from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { DatabaseSync } from 'node:sqlite';
    import { it, expect, vi, inject } from 'vitest';
    import {value} from '#fixture-value';
    import { runtimeProcessEntrypoints } from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
    import { vectorKnnProcessEntrypoint } from ${JSON.stringify(path.join(root, "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts"))};
    import { runtimeProcessBuildEntries } from ${JSON.stringify(path.join(root, "scripts/lib/runtime-process-build-entries.mts"))};
    import { vitestWorkerBuildEntries } from ${JSON.stringify(path.join(root, "scripts/lib/vitest-worker-build-entries.mts"))};
    import { tuiPtyRuntimeEntrypoints } from ${JSON.stringify(path.join(root, "src/tui/tui-pty-runtime-test-support.ts"))};
    import { resolveRuntimeWorkerUrl } from ${JSON.stringify(path.join(root, "src/infra/runtime-worker-url.ts"))};
    import { prepareSqliteReadOnlyLocation } from ${JSON.stringify(path.join(root, "src/infra/sqlite-readonly-location.ts"))};
    const tuiUrls = Object.values(tuiPtyRuntimeEntrypoints).map(entry => resolveRuntimeWorkerUrl(entry).href);
    // Import acquisition must finish during collection, before any fixture hook starts.
    const tuiPresentAtCollection = tuiUrls.every(url => fs.existsSync(new URL(url)));
    vi.mock('node:child_process', async (original) => {
      const actual = await original();
      return {...actual, execFile: vi.fn(actual.execFile)};
    });
    it('runs current SQLite code in the expected execution mode', async () => {
      const launcherArgv = inject('launcherArgv');
      expect(path.isAbsolute(launcherArgv[1])).toBe(true);
      expect(path.basename(launcherArgv[1])).toBe('vitest.mjs');
      expect(Object.values(runtimeProcessBuildEntries)).toHaveLength(7);
      for (const source of Object.values(runtimeProcessBuildEntries)) {
        expect(source).not.toContain('/dist/');
        expect(source).toMatch(/\\.ts$/);
        expect(fs.existsSync(source)).toBe(true);
      }
      expect(tuiPresentAtCollection).toBe(true);
      for (const entry of Object.values(tuiPtyRuntimeEntrypoints)) {
        const source = vitestWorkerBuildEntries[entry.distWorkerPath.replace(/\\.js$/, '')];
        expect(source).not.toContain('/dist/');
        expect(source).toMatch(/\\.ts$/);
        expect(fs.existsSync(source)).toBe(true);
      }
      const dir = fs.mkdtempSync(${JSON.stringify(path.join(directory, "database-"))});
      const file = path.join(dir, 'probe.sqlite');
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('current source');");
      db.close();
      try {
        const prepared = await prepareSqliteReadOnlyLocation(file);
        try {
          const snapshot = new DatabaseSync(prepared.location, {readOnly:true});
          expect(snapshot.prepare('SELECT value FROM probe').get()).toEqual({value:'current source'});
          snapshot.close();
          const args = cp.execFile.mock.calls[0][1];
          const generation = runtimeProcessEntrypoints.sqliteReadOnly.currentModuleUrl;
          const sourceMode = ${mode === "auto" ? "generation.endsWith('.ts')" : mode === "source"};
          expect(tuiUrls).toHaveLength(4);
          for (const url of tuiUrls) {
            expect(url.endsWith(sourceMode ? '.ts' : '.js')).toBe(true);
            if (!sourceMode) expect(fileURLToPath(url).startsWith(fileURLToPath(new URL('../', generation)))).toBe(true);
          }
          expect(args.includes('tsx')).toBe(sourceMode);
          expect(args[sourceMode ? 2 : 0]).toMatch(sourceMode ? /\\.ts$/ : /\\.js$/);
          fs.appendFileSync(${JSON.stringify(path.join(directory, "observations.jsonl"))}, JSON.stringify({args, tuiUrls, value, configValue:inject('configValue'), knn:vectorKnnProcessEntrypoint.currentModuleUrl})+'\\n');
          fs.appendFileSync(${JSON.stringify(path.join(directory, "generations.jsonl"))}, JSON.stringify(generation)+'\\n');
          const release = inject('releaseFile');
          if (release) await new Promise(resolve => {
            const check = () => {if(fs.existsSync(release)){fs.unwatchFile(release,check);resolve();}};
            fs.watchFile(release,{interval:50},check);
            check();
          });
        } finally {prepared.cleanup();}
      } finally {fs.rmSync(dir,{recursive:true,force:true});}
    });
  `,
  );
  const transformFiles = [value, configuredValue, parent].map((file) => file.replaceAll("\\", "/"));
  const shared = pathToFileURL(path.join(root, "test/vitest/vitest.shared.config.ts")).href;
  const cacheDirectory = path.join(directory, "cache");
  // Vitest keeps invocation metadata at the root cache even for inline projects.
  // Share the fixture's transform directory so cleanup owns both.
  const experimental = cacheProof ? { fsModuleCache: true, fsModuleCachePath: cacheDirectory } : {};
  const config = writeFixture(
    directory,
    "vitest.config.mts",
    `
    import fs from 'node:fs';
    import {sharedVitestConfig as shared} from ${JSON.stringify(shared)};
    const probe = {name:'fixture:transform-counter', transform(code,id) {
      if (${Boolean(cacheProof)} && ${JSON.stringify(transformFiles)}.includes(id)) fs.appendFileSync(${JSON.stringify(path.join(directory, "transforms.jsonl"))},JSON.stringify(id)+'\\n');
    }};
    const project = name => ({plugins:[...shared.plugins,probe],resolve:{...shared.resolve,alias:[{find:'#fixture-value',replacement:${JSON.stringify(value)}},...shared.resolve.alias]},test:{name,include:[${JSON.stringify(convertPathToPattern(test))}],pool:'forks',maxWorkers:1,testTimeout:shared.test.testTimeout,experimental:${JSON.stringify(experimental)},provide:{launcherArgv:process.argv,configValue:'first',releaseFile:${holdSecond} && name==='second' ? ${JSON.stringify(path.join(directory, "release"))} : null}}});
    export default async () => ({root:${JSON.stringify(root)},${cacheProof === "single" ? "...project('first')" : `plugins:shared.plugins,test:{${cacheProof ? `experimental:${JSON.stringify(experimental)},` : ""}projects:[project('first'),project('second')]}`}});
  `,
  );
  return { config, value, configuredValue, parent, cacheDirectory };
}

describe("fresh compiled subprocess invocation", () => {
  it("carries native fs-safe writes and verifies every copied target", (context) =>
    fixtureLifetime.run(async () => {
      const { node, prepareWorkers } = createFixtureCommands(context);
      const source = path.join(
        path.dirname(createRequire(import.meta.url).resolve("@openclaw/fs-safe/package.json")),
        "dist/native",
      );
      const assets = fs
        .readdirSync(source, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".node"))
        .toSorted()
        .map((name) => ({ name, bytes: fs.readFileSync(path.join(source, name)) }));
      expect(assets).toHaveLength(7);
      const owner = createVitestWorkerRun();
      const directory = owner.descriptor.directory;
      const native = path.join(directory, "dist/native");
      try {
        const manifest = await prepareWorkers(owner);
        for (const inputFile of [
          compilerModule,
          compilerEntry,
          artifactsModule,
          "scripts/lib/fs-safe-native-assets.mts",
        ]) {
          expect(manifest.inputs[path.join(root, inputFile)]).toBe(
            createHash("sha256")
              .update(fs.readFileSync(path.join(root, inputFile)))
              .digest("hex"),
          );
        }
        for (const { name, bytes } of assets) {
          expect(manifest.outputs[path.join("native", name)]).toBe(
            createHash("sha256").update(bytes).digest("hex"),
          );
          expect(fs.readFileSync(path.join(native, name))).toEqual(bytes);
        }
        const probe = async (name: string, mode: string | undefined, outcome: string) => {
          const rootDir = path.join(directory, name);
          fs.mkdirSync(rootDir);
          const result = await node(
            [
              "--input-type=module",
              "--eval",
              `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import {createRequire} from 'node:module';
            import {pathToFileURL} from 'node:url';
            const [entry,rootDir,outcome,native] = process.argv.slice(1);
            const {root} = await import(pathToFileURL(entry));
            const scoped = await root(rootDir);
            if (outcome === 'missing') {
              await assert.rejects(scoped.write('proof.txt','native proof'),error => {
                assert.equal(error.code,'helper-unavailable');
                assert.equal(error.cause?.code,'MODULE_NOT_FOUND');
                return true;
              });
              assert.deepEqual(fs.readdirSync(rootDir),[]);
            } else {
              await scoped.write('proof.txt','native proof');
              await scoped.create('created.txt','create proof');
              assert.equal(fs.readFileSync(path.join(rootDir,'proof.txt'),'utf8'),'native proof');
              assert.equal(fs.readFileSync(path.join(rootDir,'created.txt'),'utf8'),'create proof');
            }
            const loaded = Object.keys(createRequire(import.meta.url).cache).filter(file=>file.endsWith('fs-safe-native.node'));
            assert.equal(loaded.length,outcome === 'native' ? 1 : 0);
            if (loaded.length) assert(loaded[0].startsWith(native+path.sep));
            console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,outcome,loaded}));
            `,
              path.join(directory, "dist/plugin-sdk/file-access-runtime.js"),
              rootDir,
              outcome,
              native,
            ],
            directory,
            {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              HOME: directory,
              USERPROFILE: directory,
              TMPDIR: directory,
              TMP: directory,
              TEMP: directory,
              OPENCLAW_FS_SAFE_NATIVE_MODE: mode,
            },
          );
          expect(result.code, result.stderr + result.stdout).toBe(0);
          console.log(name, result.stdout.trim());
        };
        const joinProbes = async (probes: Promise<void>[]) => {
          // Join every native caller before moving assets, including on failure.
          const results = await Promise.allSettled(probes);
          for (const result of results) {
            if (result.status === "rejected") {
              throw result.reason;
            }
          }
        };
        await joinProbes([
          probe("default", undefined, "fallback"),
          ...["off", "auto", "require"].map((mode) =>
            probe(mode, mode, mode === "off" ? "fallback" : "native"),
          ),
        ]);
        // All targets are pinned above; one damaged copy exercises the shared
        // verifier without rehashing the whole source graph for every platform.
        // Never execute a deliberately damaged binary.
        const { name, bytes } = assets[0]!;
        const filename = path.join(native, name);
        try {
          fs.appendFileSync(filename, "altered copy");
          expect(() => verifyVitestWorkerArtifacts(directory)).toThrow(
            "Compiled subprocess artifact changed",
          );
          fs.rmSync(filename);
          expect(() => verifyVitestWorkerArtifacts(directory)).toThrow("ENOENT");
        } finally {
          fs.writeFileSync(filename, bytes);
        }
        const savedNative = path.join(directory, "saved-native");
        fs.renameSync(native, savedNative);
        try {
          await joinProbes([
            probe("missing-require", "require", "missing"),
            ...["off", "auto"].map((mode) => probe(`missing-${mode}`, mode, "fallback")),
          ]);
        } finally {
          fs.renameSync(savedNative, native);
        }
      } finally {
        await owner.dispose();
      }
      expect(fs.existsSync(directory)).toBe(false);
    }));

  it.for(["native", "compiler"])(
    "rejects %s output altered during the real copy phase before publishing a manifest",
    (target, context) =>
      fixtureLifetime.run(async () => {
        const { node } = createFixtureCommands(context);
        const directory = fixtureDirectory();
        const altered = path.join(directory, "altered");
        const preload = writeFixture(
          directory,
          "copy-fault.mjs",
          `
        import fs from 'node:fs';
        import fsp from 'node:fs/promises';
        import path from 'node:path';
        import {syncBuiltinESMExports} from 'node:module';
        const copy = fsp.cp;
        fsp.cp = async (from,to,options) => {
          await copy(from,to,options);
          if (path.basename(to) !== 'native') return;
          const filename = ${JSON.stringify(target)} === 'native'
            ? path.join(to,fs.readdirSync(to,{recursive:true}).find(file=>file.endsWith('.node')))
            : path.join(path.dirname(to),'infra/runtime-process-entrypoints.js');
          fs.appendFileSync(filename,'altered during copy');
          fs.writeFileSync(${JSON.stringify(altered)},'real copy boundary executed');
        };
        syncBuiltinESMExports();
        `,
        );
        const owner = createVitestWorkerRun();
        try {
          // Inject only into the actual native compiler entry, never the parent's
          // module cache or a production build flag. node() joins this direct child.
          const result = await node([
            "--import",
            pathToFileURL(preload).href,
            path.join(root, compilerEntry),
            owner.descriptor.directory,
          ]);
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain("Compiled subprocess artifact changed");
          expect(fs.readFileSync(altered, "utf8")).toBe("real copy boundary executed");
          expect(fs.existsSync(path.join(owner.descriptor.directory, "manifest.json"))).toBe(false);
        } finally {
          await owner.dispose();
        }
        expect(fs.existsSync(owner.descriptor.directory)).toBe(false);
      }),
  );

  it
    .runIf(process.platform !== "win32")
    .for(["close before ready", "cancel while compiling", "terminated group", "uncertain output"])(
    "owns the real compiler lifetime: %s",
    (mode, context) =>
      fixtureLifetime.run(async () => {
        const { node } = createFixtureCommands(context);
        const directory = fixtureDirectory();
        const preload = writeFixture(
          directory,
          "compiler-lifetime.mjs",
          `
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import path from 'node:path';
      import {spawn} from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      const directory=${JSON.stringify(directory)}, mode=${JSON.stringify(mode)};
      const record=(name,value)=>fs.writeFileSync(path.join(directory,name),value);
      const copy=fsp.cp, write=fs.writeFileSync;
      const gate=()=>new Promise(resolve=>{
        const poll=setInterval(()=>{
          if(fs.existsSync(path.join(directory,'release'))) {clearInterval(poll);resolve();}
        },5);
        process.once('SIGTERM',()=>{
          record('cancel-read',fs.readFileSync(path.join(directory,'input'),'utf8'));
          clearInterval(poll);process.exit(0);
        });
      });
      fsp.cp=async (...args)=>{
        await copy(...args);
        if(path.basename(args[1])!=='native') return;
        if(mode==='cancel while compiling') {
          record('compiling',String(process.pid));
          await gate();
        } else if(mode==='terminated group' || mode==='uncertain output') {
          const leaf=spawn(process.execPath,['--input-type=module','--eval',\`
            import fs from 'node:fs';
            const poll=setInterval(()=>{
              if(!fs.existsSync(\${JSON.stringify(path.join(directory,'leaf-release'))})) return;
              fs.accessSync(\${JSON.stringify(process.argv[2])});
              // Existence is readiness: publish only the completed receipt.
              const receipt=\${JSON.stringify(path.join(directory,'leaf-read'))};
              fs.writeFileSync(receipt+'.tmp','retained input');
              fs.renameSync(receipt+'.tmp',receipt);
              clearInterval(poll);
            },5);
            fs.writeFileSync(\${JSON.stringify(path.join(directory,'leaf-pid'))},String(process.pid));
            process.send('ready');process.disconnect();
          \`],{detached:mode==='uncertain output',stdio:['ignore','inherit','inherit','ipc']});
          await new Promise((resolve,reject)=>{leaf.once('message',resolve);leaf.once('error',reject);});
          leaf.unref();
        }
      };
      fs.writeFileSync=(filename,...args)=>{
        const result=write(filename,...args);
        if(path.basename(String(filename))==='manifest.json' && mode==='close before ready') {
          record('compiled',String(process.pid));void gate();
        }
        return result;
      };
      syncBuiltinESMExports();
    `,
        );
        const driver = writeFixture(
          directory,
          "compiler-owner.mjs",
          `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      import {setTimeout as tick} from 'node:timers/promises';
      import {inspectManagedProcessGroup} from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/managed-child-process.mts")).href)};
      const directory=${JSON.stringify(directory)}, mode=${JSON.stringify(mode)};
      const file=name=>path.join(directory,name);
      fs.writeFileSync(file('input'),'compiler input');
      const spawn=cp.spawn;
      let compiler, closed=false, ready=false, finished=false, readyClosed, leafPid;
      cp.spawn=(bin,args,options)=>{
        if(args[0]!==${JSON.stringify(path.join(root, compilerEntry))}) return spawn(bin,args,options);
        compiler=spawn(bin,['--import',${JSON.stringify(pathToFileURL(preload).href)},...args],options);
        compiler.once('close',()=>{closed=true;});
        return compiler;
      };
      syncBuiltinESMExports();
      const {createVitestWorkerRun}=await import(${JSON.stringify(pathToFileURL(path.join(root, compilerModule)).href)});
      const {createVitestProcessCompletion}=await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/vitest-process-group.mts")).href)});
      const owner=createVitestWorkerRun(), generation=owner.descriptor.directory;
      const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(preparationClient.replace("await requestVitestWorkerArtifacts();", 'await requestVitestWorkerArtifacts();process.send("borrower-ready");'))}],{detached:true,stdio:['ignore','ignore','pipe','ipc']});
      child.stderr.resume();
      child.on('message',message=>{if(message==='borrower-ready'){ready=true;readyClosed=closed;}});
      const completion=owner.borrow(child,createVitestProcessCompletion({child,detached:true}));
      void completion.then(()=>{finished=true;},()=>{finished=true;});
      const observe=async name=>{
        while(!fs.existsSync(file(name))) {
          if(finished) throw new Error('borrower completed before '+name);
          await tick(5);
        }
      };
      let disposal;
      try {
        if(mode==='close before ready' || mode==='cancel while compiling') {
          await observe(mode==='close before ready'?'compiled':'compiling');
          assert.equal(closed,false);assert.equal(ready,false);
          assert.equal(fs.existsSync(path.join(generation,'manifest.json')),mode==='close before ready');
          if(mode==='cancel while compiling') {
            disposal=owner.dispose();void disposal.catch(()=>{});
          } else fs.writeFileSync(file('release'),'release');
        }
        const result=await completion;
        assert.equal(closed,true,'ready must wait for actual compiler close');
        assert.equal(inspectManagedProcessGroup(compiler,{errorPolicy:'indeterminate'}),'dead');
        if(mode==='close before ready') {
          assert.equal(result.code,0);assert.equal(readyClosed,true);await owner.dispose();
        } else {
          assert.notEqual(result.code,0);
          const error=await (disposal??owner.dispose()).then(()=>{throw new Error('expected compiler failure');},error=>error);
          if(mode==='cancel while compiling') {
            assert.equal(error.code,'ABORT_ERR');
            assert.equal(fs.readFileSync(file('cancel-read'),'utf8'),'compiler input');
          } else {
            assert.equal(error.code,'EPROCESSGROUP_CLEANUP_FAILED');
            assert.equal(error.processTreeState,mode==='terminated group'?'terminated':'indeterminate');
            leafPid=Number(fs.readFileSync(file('leaf-pid'),'utf8'));
            if(mode==='uncertain output') {
              assert.equal(fs.existsSync(generation),true);
              process.kill(leafPid,0);
              fs.writeFileSync(file('leaf-release'),'release');
              while(!fs.existsSync(file('leaf-read'))) await tick(5);
              assert.equal(fs.readFileSync(file('leaf-read'),'utf8'),'retained input');
            }
          }
        }
        assert.equal(fs.existsSync(generation),mode==='uncertain output');
        console.log(JSON.stringify({mode,compilerPid:compiler.pid,compilerClosed:closed,compilerGroup:'dead',borrowerCode:result.code,retained:fs.existsSync(generation),leafPid}));
      } finally {
        fs.writeFileSync(file('release'),'release');
        child.kill('SIGTERM');
        await completion.catch(()=>{});
        await owner.dispose().catch(()=>{});
        if(fs.existsSync(file('leaf-pid'))) {
          leafPid=Number(fs.readFileSync(file('leaf-pid'),'utf8'));
          try {process.kill(leafPid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}
          if(mode==='uncertain output') {
            while(inspectManagedProcessGroup({pid:leafPid,exitCode:0},{errorPolicy:'indeterminate'})!=='dead') await tick(5);
          }
        }
        fs.rmSync(generation,{recursive:true,force:true});
        console.log(JSON.stringify({mode,cleanup:'joined',generationRemoved:!fs.existsSync(generation)}));
      }
    `,
        );
        const result = await node([driver]);
        console.log(result.stdout);
        expect(result.code, result.stderr + result.stdout).toBe(0);
      }),
  );

  it.for(["failed observation", "cancellation", "timeout"])(
    "joins complete bodies before input disposal after %s in real Vitest",
    (fault, context) =>
      fixtureLifetime.run(async () => {
        const { node } = createFixtureCommands(context);
        const directory = fixtureDirectory();
        const receipt = path.join(directory, "lifetime.json");
        const test = writeFixture(
          directory,
          "lifetime.test.ts",
          `
        import fs from 'node:fs';
        import path from 'node:path';
        import {setTimeout as tick} from 'node:timers/promises';
        import {aroundEach,it,expect} from 'vitest';
        import {createFixtureLifetime} from ${JSON.stringify(pathToFileURL(path.join(root, "test/helpers/fixture-lifetime.ts")).href)};
        import {createDeferred} from ${JSON.stringify(pathToFileURL(path.join(root, "test/helpers/promise.ts")).href)};
        import {runNodeScript} from ${JSON.stringify(pathToFileURL(path.join(root, "test/helpers/run-node-script.ts")).href)};
        import {inspectManagedProcessGroup} from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/managed-child-process.mts")).href)};
        const lifetime=createFixtureLifetime(), events=[];
        let inputRoot, pid, leafPid, commandResult, lateResult, readyObserved=false, closed=false;
        const lateMarker=${JSON.stringify(path.join(directory, "late-launch"))};
        aroundEach(async runTest=>{try {await runTest();} finally {await lifetime.cleanup();}});
        it.fails('failed body with an unfinished sibling',${fault === "timeout" ? "{timeout:3000}," : ""}({signal,onTestFinished})=>lifetime.run(async()=>{
          inputRoot=lifetime.createTempDir('body-input-',${JSON.stringify(directory)});
          const input=path.join(inputRoot,'input');fs.writeFileSync(input,'still owned');
          const readyFile=path.join(inputRoot,'ready'), script=path.join(inputRoot,'child.mjs');
          const leafSource=\`
            const fs=require('node:fs');
            process.once('SIGTERM',()=>{console.log('leaf read: '+fs.readFileSync(\${JSON.stringify(input)},'utf8'));process.exit(0);});
            setTimeout(()=>process.exit(73),10000);
            process.send('ready');
          \`;
          fs.writeFileSync(script,\`
            import fs from 'node:fs';
            import {spawn} from 'node:child_process';
            const leaf=spawn(process.execPath,['--eval',\${JSON.stringify(leafSource)}],{stdio:['ignore','inherit','inherit','ipc']});
            process.once('SIGTERM',()=>process.exit(0));
            setTimeout(()=>process.exit(73),10000);
            leaf.once('message',()=>{
              const ready=\${JSON.stringify(readyFile)};
              fs.writeFileSync(ready+'.tmp',JSON.stringify({pid:process.pid,leafPid:leaf.pid}));fs.renameSync(ready+'.tmp',ready);
            });
          \`);
          const lateScript=path.join(${JSON.stringify(directory)},'late.mjs');
          fs.writeFileSync(lateScript,'import fs from "node:fs";fs.writeFileSync('+JSON.stringify(lateMarker)+',"launched");');
          const abort=new AbortController(), unwind=createDeferred();
          const commandSignal=AbortSignal.any([signal,abort.signal]);
          const options={signal:commandSignal,maxBuffer:2*1024*1024,requireProcessTreeExit:process.platform!=='win32',
            onReady(child) {child.once('close',()=>{closed=true;events.push('child-close');});},
          };
          const command=lifetime.track(runNodeScript(script,process.env,undefined,options).then(result=>{
            commandResult=result;return result;
          }));
          onTestFinished(async()=>{
            events.push('onTestFinished');abort.abort();
            try {await command;}
            finally {unwind.resolve();}
          });
          await Promise.all([
            lifetime.run(async()=>{
              try {const result=await command;if(result.error) throw result.error;} finally {
                await unwind.promise;
                events.push(fs.readFileSync(input,'utf8'));
                lateResult=await lifetime.track(runNodeScript(lateScript,process.env,undefined,options));
              }
            }),
            lifetime.run(async()=>{
              while(!fs.existsSync(readyFile)) {
                if(commandResult) throw new Error('child closed before readiness');
                await tick(5);
              }
              ({pid,leafPid}=JSON.parse(fs.readFileSync(readyFile,'utf8')));readyObserved=true;
              if(${JSON.stringify(fault)}==='cancellation') abort.abort();
              if(${JSON.stringify(fault)}!=='failed observation') await command;
              throw new Error('observation failed');
            }),
          ]);
        }));
        it('next fixture sees completed teardown',()=>{
          // Expected failure must not invert any cancellation or cleanup proof.
          console.log('command lifetime observation',JSON.stringify({fault:${JSON.stringify(fault)},readyObserved,pid,leafPid,closed,commandStatus:commandResult?.status,commandErrorCode:commandResult?.error?.code,lateLaunched:fs.existsSync(lateMarker),events}));
          expect(readyObserved).toBe(true);
          expect(commandResult).toMatchObject({error:{code:'ABORT_ERR'}});
          expect(lateResult.error).toBeInstanceOf(Error);
          expect(fs.existsSync(lateMarker)).toBe(false);
          expect(closed).toBe(true);
          expect(events.indexOf('child-close')).toBeLessThan(events.indexOf('still owned'));
          expect(events.indexOf('onTestFinished')).toBeLessThan(events.indexOf('still owned'));
          expect(fs.existsSync(inputRoot)).toBe(false);
          expect(()=>process.kill(pid,0)).toThrow();
          if(process.platform!=='win32') {
            expect(inspectManagedProcessGroup({pid,exitCode:0},{errorPolicy:'indeterminate'})).toBe('dead');
            expect(commandResult.stdout).toContain('leaf read: still owned');
          } else expect(()=>process.kill(leafPid,0)).toThrow();
          fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({fault:${JSON.stringify(fault)},events,closed,inputRemoved:!fs.existsSync(inputRoot)}));
        });
      `,
        );
        const config = writeFixture(
          directory,
          "vitest.config.mts",
          `
        import {sharedVitestConfig as shared} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.shared.config.ts")).href)};
        export default {...shared,test:{...shared.test,include:[${JSON.stringify(convertPathToPattern(test))}]}};
      `,
        );
        const result = await node(["scripts/run-vitest.mjs", "run", "--config", config]);
        expect(result.code, result.stderr + result.stdout).toBe(0);
        const observed = JSON.parse(fs.readFileSync(receipt, "utf8"));
        expect(observed).toMatchObject({ fault, closed: true, inputRemoved: true });
        console.log("whole-body lifetime", observed);
      }),
  );

  it.for(
    (["single", "projects"] as const).flatMap((layout) =>
      (["fresh generations", "source mode", "source and config edits"] as const).map(
        (invariant) => ({ layout, invariant }),
      ),
    ),
  )("preserves filesystem transforms for $invariant ($layout)", ({ layout, invariant }, context) =>
    fixtureLifetime.run(async () => {
      const { node } = createFixtureCommands(context);
      const directory = fixtureDirectory();
      const { config, value, configuredValue, parent, cacheDirectory } = workerProbe(
        directory,
        false,
        "auto",
        layout,
      );
      const readLines = (name: string) =>
        fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n");
      const counts = () => {
        const transformed = readLines("transforms.jsonl").map((line) =>
          path.normalize(JSON.parse(line)),
        );
        return [[value, configuredValue], [parent]].map(
          (ids) => transformed.filter((actual) => ids.includes(actual)).length,
        );
      };
      const generations: string[] = [];
      const launch = async (
        mode: "compiled" | "source",
        expectedValue = "first",
        configValue = "first",
      ) => {
        const result = await node([
          mode === "compiled" ? "scripts/run-vitest.mjs" : "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          config,
          "--project",
          "first",
        ]);
        expect(result.code, result.stderr + result.stdout).toBe(0);
        const generation: string = JSON.parse(readLines("generations.jsonl").at(-1)!);
        const observed = JSON.parse(readLines("observations.jsonl").at(-1)!);
        expect(observed.value).toBe(expectedValue);
        expect(observed.configValue).toBe(configValue);
        if (mode === "compiled") {
          const generationDirectory = fileURLToPath(new URL("../../", generation));
          expect(result.stderr.match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
          expect(generations).not.toContain(generation);
          generations.push(generation);
          expect(path.dirname(generationDirectory)).toBe(
            path.join(root, ".artifacts", "vitest-workers"),
          );
          expect(fileURLToPath(generation)).toBe(
            path.join(generationDirectory, "dist/infra/runtime-process-entrypoints.js"),
          );
          expect(observed.args[0]).toBe(
            path.join(generationDirectory, "dist/infra/sqlite-readonly-location.worker.js"),
          );
          expect(fileURLToPath(observed.knn)).toBe(
            path.join(
              generationDirectory,
              "dist/extensions/memory-core/manager-search-knn-entrypoint.js",
            ),
          );
          // Each completed repository invocation must dispose before the next starts.
          expect(fs.existsSync(generationDirectory)).toBe(false);
        } else {
          expect(result.stderr).not.toContain("[vitest-workers] prepared");
          expect(fileURLToPath(generation)).toBe(
            path.join(root, "src/infra/runtime-process-entrypoints.ts"),
          );
          expect(observed.args.slice(0, 2)).toEqual(["--import", "tsx"]);
          expect(fileURLToPath(observed.knn)).toBe(
            path.join(root, "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts"),
          );
        }
        console.log(
          "cache transport",
          JSON.stringify({ mode, ...observed, generation, transforms: counts() }),
        );
      };
      await launch("compiled");
      expect(counts()).toEqual([1, 1]);
      expect(
        JSON.parse(fs.readFileSync(path.join(cacheDirectory, "_metadata.json"), "utf8")),
      ).toEqual({ lockfileHash: expect.stringMatching(/^[a-f\d]{8}$/u) });
      if (invariant === "fresh generations") {
        await launch("compiled");
        expect(counts(), "unchanged parents must reuse filesystem transforms").toEqual([1, 1]);
      } else if (invariant === "source mode") {
        await launch("source");
        expect(counts()).toEqual([2, 2]);
        await launch("compiled");
        expect(counts()).toEqual([2, 2]);
      } else {
        fs.writeFileSync(value, 'export const value: string = "second";');
        await launch("compiled", "second");
        expect(counts()).toEqual([2, 1]);
        fs.writeFileSync(
          config,
          fs
            .readFileSync(config, "utf8")
            .replace(
              `replacement:${JSON.stringify(value)}`,
              `replacement:${JSON.stringify(configuredValue)}`,
            ),
        );
        await launch("compiled", "configured");
        expect(counts()).toEqual([3, 2]);
      }
    }),
  );

  it("observes readiness when borrower completion wins the file-watch event", () =>
    fixtureLifetime.run(async () => {
      const filename = path.join(fixtureDirectory(), "ready");
      const { promise: completion, resolve: finish } = createDeferred();
      let ready = false;
      const waiting = waitForFixtureFile(filename, completion).then(() => {
        ready = true;
      });
      fs.writeFileSync(filename, "ready");
      finish();
      await nextTurn();
      expect(ready).toBe(true);
      await waiting;
    }));

  it("keeps standalone configured Vitest on source without a subprocess owner", (context) =>
    fixtureLifetime.run(async () => {
      const { node } = createFixtureCommands(context);
      const directory = fixtureDirectory();
      const { config } = workerProbe(directory, false, "source");
      const result = await node([
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        config,
        "--project",
        "first",
      ]);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(result.stderr).not.toContain("[vitest-workers] prepared");
      const generation = JSON.parse(
        fs.readFileSync(path.join(directory, "generations.jsonl"), "utf8").trim(),
      );
      expect(fileURLToPath(generation)).toBe(
        path.join(root, "src/infra/runtime-process-entrypoints.ts"),
      );
    }));

  it.each(["src/infra/runtime-process-entrypoints.ts", "src/tui/tui-pty-runtime-test-support.ts"])(
    "recognizes native and Windows-normalized declaration IDs for %s",
    (source) => {
      const declaration = path.join(root, source);
      expect(isVitestWorkerDeclaration(declaration)).toBe(true);
      expect(isVitestWorkerDeclaration(declaration.replaceAll("\\", "/"))).toBe(true);
      expect(isVitestWorkerDeclaration(declaration.replaceAll("/", "\\"))).toBe(true);
      expect(isVitestWorkerDeclaration(`${declaration}.unrelated`)).toBe(false);
    },
  );

  it("loads the real Anthropic failover hook in a fresh process without global activation", (context) =>
    fixtureLifetime.run(async () => {
      const { node } = createFixtureCommands(context);
      const probe = writeFixture(
        fixtureDirectory(),
        "anthropic-hook.mts",
        `
          import assert from 'node:assert/strict';
          import {coerceToFailoverError} from ${JSON.stringify(pathToFileURL(path.join(root, "src/agents/failover-error.ts")).href)};
          import {getActivePluginRegistry} from ${JSON.stringify(pathToFileURL(path.join(root, "src/plugins/runtime.ts")).href)};
          assert.equal(getActivePluginRegistry(), null);
          const result = coerceToFailoverError(
            {code: 'API_ERROR', message: 'provider failure'}, {provider: 'anthropic'},
          );
          assert.equal(result?.reason, 'server_error');
          assert.equal(result?.provider, 'anthropic');
          assert.equal(getActivePluginRegistry(), null);
        `,
      );
      const result = await node(resolveRuntimeWorkerArgv(pathToFileURL(probe)), root, {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      });
      expect(result.code, result.stderr + result.stdout).toBe(0);
    }));

  it("preserves scoped and cold provider hooks in source and compiled TUI payloads", (context) =>
    fixtureLifetime.run(async () => {
      const { node, prepareWorkers } = createFixtureCommands(context);
      const owner = createVitestWorkerRun();
      try {
        const manifest = await prepareWorkers(owner);
        console.log(
          JSON.stringify({ preparationMs: manifest.durationMs, identity: manifest.identity }),
        );
        for (const mode of ["source", "compiled"] as const) {
          for (const scope of ["scoped", "cold"] as const) {
            const directory = fixtureDirectory();
            const events = path.join(directory, "provider-events.jsonl");
            const bundled = path.join(directory, "bundled");
            const pluginRoot = path.join(bundled, "fixture-hook");
            writeFixture(
              pluginRoot,
              "openclaw.plugin.json",
              JSON.stringify({
                id: "fixture-hook",
                providers: ["fixture-provider"],
                configSchema: { type: "object", additionalProperties: false, properties: {} },
              }),
            );
            writeFixture(
              pluginRoot,
              "index.cjs",
              `
            const fs = require('node:fs');
            const record = event => fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(event)+'\\n');
            record({event:'import'});
            module.exports = {id:'fixture-hook',register(api) {
              record({event:'register',mode:api.registrationMode});
              api.registerProvider({id:'fixture-provider',label:'Fixture',auth:[],
                classifyFailoverReason(context) {
                  record({event:'hook',provider:context.provider,status:context.status});
                  return 'overloaded';
                },
              });
            }};
          `,
            );
            const probe = writeFixture(
              directory,
              "provider-hook.mts",
              `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import {createEmptyPluginRegistry} from ${JSON.stringify(pathToFileURL(path.join(root, "src/plugins/registry-empty.ts")).href)};
            import {getPluginRegistryState} from ${JSON.stringify(pathToFileURL(path.join(root, "src/plugins/runtime-state.ts")).href)};
            import {withPluginRuntimeRegistryScope} from ${JSON.stringify(pathToFileURL(path.join(root, "src/plugins/runtime/gateway-request-scope.ts")).href)};
            const events = ${JSON.stringify(events)};
            const observed = () => fs.existsSync(events) ? fs.readFileSync(events,'utf8').trim().split('\\n').map(line=>JSON.parse(line)) : [];
            const started = performance.now();
            const {buildEmbeddedRunPayloads} = await import(process.argv[2]);
            const imported = performance.now();
            assert.deepEqual(observed(),[], 'importing classifier code must not materialize the provider');
            assert.equal(getPluginRegistryState()?.activeRegistry ?? null,null);
            const input = errorMessage => ({
              assistantTexts:[],sessionKey:'agent:main:fixture-hook',provider:'fixture-provider',
              lastAssistant:{role:'assistant',content:[],stopReason:'error',provider:'fixture-provider',model:'fixture-model',errorMessage},
            });
            const registry = createEmptyPluginRegistry();
            let scopedCalls = 0;
            registry.providers.push({pluginId:'fixture-hook',provider:{id:'fixture-provider',label:'Fixture',auth:[],
              classifyFailoverReason(context) {
                assert.equal(context.provider,'fixture-provider');assert.equal(context.status,403);
                scopedCalls++;return 'overloaded';
              },
            }});
            const callStarted = performance.now();
            const call = () => buildEmbeddedRunPayloads(input('403 fixture refusal'));
            const payloads = ${scope === "scoped" ? "withPluginRuntimeRegistryScope(registry,call)" : "call()"};
            const callMs = performance.now()-callStarted;
            const records = observed();
            if (${scope === "scoped"}) {
              assert.ok(scopedCalls > 0, 'payload errors must reach the scoped provider hook');
              assert.deepEqual(records,[]);
            } else {
              assert.deepEqual(records.slice(0,2),[{event:'import'},{event:'register',mode:'discovery'}]);
              assert.ok(records.length > 2);
              for (const record of records.slice(2)) assert.deepEqual(record,{event:'hook',provider:'fixture-provider',status:403});
              assert.equal(scopedCalls,0);
            }
            assert.ok(payloads.some(payload=>payload.isError && payload.text.includes('temporarily overloaded')));
            assert.equal(getPluginRegistryState()?.activeRegistry ?? null,null,'cold resolution must not install a global registry');
            console.log(JSON.stringify({pid:process.pid,mode:${JSON.stringify(mode)},scope:${JSON.stringify(scope)},importMs:imported-started,callMs,scopedCalls,records,payloads,rss:process.memoryUsage().rss}));
          `,
            );
            const url = pathToFileURL(
              mode === "source"
                ? path.join(root, "src/agents/embedded-agent-runner/run/payloads.ts")
                : path.join(
                    owner.descriptor.directory,
                    "dist/agents/embedded-agent-runner/run/payloads.js",
                  ),
            );
            const result = await node(
              [...resolveRuntimeWorkerArgv(pathToFileURL(probe)), url.href],
              root,
              {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
                OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
              },
            );
            console.log(result.stdout);
            expect(result.code, result.stderr + result.stdout).toBe(0);
          }
        }
      } finally {
        await owner.dispose();
      }
      expect(fs.existsSync(owner.descriptor.directory)).toBe(false);
    }));

  it.each([
    { args: ["run", "--", "--help"], metadata: false },
    { args: ["run", "--testNamePattern", "--help"], metadata: false },
    { args: ["run", "--help"], metadata: true },
    { args: ["bench", "--run"], metadata: false },
    { args: ["related", "--run"], metadata: false },
    { args: ["list"], metadata: true },
  ])("classifies metadata requests for $args", ({ args, metadata }) => {
    expect(isVitestWorkerMetadataRequest(args)).toBe(metadata);
  });

  it("shares one lazy build across projects and supports Promise config factories with the runner loader", (context) =>
    fixtureLifetime.run(async () => {
      const { node } = createFixtureCommands(context);
      const observed = await Promise.all(
        ["separate", "equals"].map((configForm) =>
          fixtureLifetime.run(async () => {
            const directory = fixtureDirectory();
            const { config } = workerProbe(directory);
            const result = await node([
              "scripts/run-vitest.mjs",
              "run",
              ...(configForm === "separate" ? ["--config", config] : [`--config=${config}`]),
              "--configLoader",
              "runner",
              "--",
              path.join(directory, "child.test.ts"),
            ]);
            expect(result.code, result.stderr + result.stdout).toBe(0);
            expect(result.stderr.match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
            const generations = fs
              .readFileSync(path.join(directory, "generations.jsonl"), "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as string);
            expect(generations).toHaveLength(2);
            expect(new Set(generations).size).toBe(1);
            expect(fs.existsSync(new URL(generations[0]!))).toBe(false);
            return generations[0]!;
          }),
        ),
      );
      expect(new Set(observed).size).toBe(2);
    }));

  it("shares a completed generation between real borrower processes until both finish", (context) =>
    fixtureLifetime.run(async () => {
      const { startBorrower } = createFixtureCommands(context);
      const directory = fixtureDirectory();
      const { config } = workerProbe(directory, true);
      const owner = createVitestWorkerRun();
      const preparationLog = vi.spyOn(console, "error");
      let generation: string | undefined;
      const handles = ["first", "second"].map((project) =>
        startBorrower(owner, ["run", "--config", config, "--project", project]),
      );
      const results = handles.map((handle) => handle.result);
      let secondFinished = false;
      void results[1]!.then(() => {
        secondFinished = true;
      });
      try {
        const first = await results[0]!;
        expect(first.code, first.stderr + first.stdout).toBe(0);
        expect(secondFinished).toBe(false);
        const generations = fs
          .readFileSync(path.join(directory, "generations.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string);
        expect(new Set(generations).size).toBe(1);
        generation = generations[0]!;
        expect(fs.existsSync(new URL(generation))).toBe(true);
        const declaration = path.join(root, "src/infra/runtime-process-entrypoints.ts");
        const buildDirectory = path.dirname(path.dirname(path.dirname(fileURLToPath(generation))));
        expect(
          resolveVitestWorkerDeclaration(declaration.replaceAll("/", "\\"), buildDirectory),
        ).toBe(resolveVitestWorkerDeclaration(declaration, buildDirectory));
      } finally {
        fs.writeFileSync(path.join(directory, "release"), "finish");
        try {
          const completed = await Promise.all(results);
          expect(
            preparationLog.mock.calls.filter(([line]) =>
              String(line).startsWith("[vitest-workers] prepared"),
            ),
          ).toHaveLength(1);
          for (const result of completed) {
            expect(result.code, result.stderr + result.stdout).toBe(0);
            expect(result.stderr).not.toContain("[vitest-workers] prepared");
          }
        } finally {
          preparationLog.mockRestore();
          await owner.dispose();
        }
      }
      expect(fs.existsSync(new URL(generation!))).toBe(false);
    }));

  it.for(["infra/sqlite-readonly-location.worker.js", "tui/tui.js"])(
    "refuses missing %s in the real consumer without rebuilding",
    (missingEntry, context) =>
      fixtureLifetime.run(async () => {
        const { startBorrower } = createFixtureCommands(context);
        const directory = fixtureDirectory();
        const { config } = workerProbe(directory);
        const owner = createVitestWorkerRun();
        let generation: string | undefined;
        try {
          const first = await startBorrower(owner, [
            "run",
            "--config",
            config,
            "--project",
            "first",
          ]).result;
          expect(first.code, first.stderr + first.stdout).toBe(0);
          generation = JSON.parse(
            fs.readFileSync(path.join(directory, "generations.jsonl"), "utf8").trim(),
          );
          fs.rmSync(path.join(owner.descriptor.directory, "dist", missingEntry));
          const refused = await startBorrower(owner, [
            "run",
            "--config",
            config,
            "--project",
            "second",
          ]).result;
          expect(refused.code).not.toBe(0);
          expect(refused.stderr).toContain("ENOENT");
          expect(refused.stderr.trim().split("\n").at(-1)).toBe("[test] FAILED (exit 1)");
          expect(
            fs.readFileSync(path.join(directory, "generations.jsonl"), "utf8").trim().split("\n"),
          ).toHaveLength(1);
          await expect(owner.dispose()).rejects.toThrow("ENOENT");
        } finally {
          await owner.dispose().catch(() => {});
        }
        expect(fs.existsSync(new URL(generation!))).toBe(false);
      }),
  );

  it.for(["cancel", "owner disconnect"])(
    "joins actual borrowers after %s before deleting artifacts",
    (action, context) =>
      fixtureLifetime.run(async () => {
        const { startBorrower } = createFixtureCommands(context);
        const directory = fixtureDirectory();
        const { config } = workerProbe(directory, true);
        const owner = createVitestWorkerRun();
        // Node26 parent-side child.disconnect() omits ChildProcess.close. Close the
        // fixture endpoint so the owner receives EOF and retains its real join contract.
        const disconnect = writeFixture(
          directory,
          "disconnect.mjs",
          `
        const disconnect = message => {if(message==='fixture-disconnect') {
          process.off('message',disconnect);process.disconnect();
        }};
        process.on('message',disconnect);
      `,
        );
        const handle = startBorrower(
          owner,
          ["run", "--config", config, "--project", "second"],
          action === "owner disconnect" ? ["--import", pathToFileURL(disconnect).href] : [],
        );
        try {
          const observed = path.join(directory, "generations.jsonl");
          await waitForFixtureFile(observed, handle.completion);
          const generation = JSON.parse(fs.readFileSync(observed, "utf8").trim());
          expect(fs.existsSync(new URL(generation))).toBe(true);
          if (action === "cancel") {
            handle.child.kill("SIGTERM");
          } else {
            handle.child.send("fixture-disconnect");
          }
          const result = await handle.result;
          expect(result.code).not.toBe(0);
          if (action === "owner disconnect") {
            expect(result.stderr).toContain("owner disconnected");
            expect(result.stderr.trim().split("\n").at(-1)).toBe("[test] FAILED (exit 1)");
          }
          await owner.dispose();
          expect(fs.existsSync(new URL(generation))).toBe(false);
        } finally {
          await owner.dispose();
        }
      }),
  );

  it.runIf(process.platform !== "win32")(
    "retains artifacts after an uncertain join and waits for the surviving borrower",
    (context) =>
      fixtureLifetime.run(async () => {
        const { observeChild } = createFixtureCommands(context);
        const directory = fixtureDirectory();
        const owner = createVitestWorkerRun();
        const generation = owner.descriptor.directory;
        const artifact = path.join(generation, "dist/infra/runtime-process-entrypoints.js");
        const clientScript = writeFixture(
          directory,
          "client.mjs",
          `
      import fs from 'node:fs';
      import {requestVitestWorkerArtifacts} from ${JSON.stringify(pathToFileURL(path.join(root, artifactsModule)).href)};
      await requestVitestWorkerArtifacts();
      process.on('message', command => {if(command === 'finish') {
        fs.accessSync(${JSON.stringify(artifact)});
        fs.writeFileSync(process.argv[2]+'.read','read');
        process.disconnect();
      }});
      process.channel.ref();
      fs.writeFileSync(process.argv[2],'ready');
    `,
        );
        const clients = ["first", "second"].map((name) => {
          const ready = path.join(directory, name);
          const child = spawn(process.execPath, [clientScript, ready], {
            detached: true,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          });
          const closed = new Promise<void>((resolve) => {
            child.once("close", () => resolve());
          });
          const completion = observeChild(
            child,
            owner.borrow(
              child,
              createVitestProcessCompletion({
                child,
                detached: true,
                ...(name === "first"
                  ? {
                      kill: () => {
                        throw new Error("injected process-group join failure");
                      },
                    }
                  : {}),
              }),
            ),
          );
          return { child, ready, closed, completion };
        });
        try {
          await Promise.all(
            clients.map((client) => waitForFixtureFile(client.ready, client.completion)),
          );
          clients[0]!.child.send("finish");
          await expect(clients[0]!.completion).rejects.toThrow(
            "injected process-group join failure",
          );
          let disposed = false;
          const disposal = owner.dispose().finally(() => {
            disposed = true;
          });
          void disposal.catch(() => {});
          expect(disposed).toBe(false);
          expect(clients[1]!.child.exitCode).toBeNull();
          clients[1]!.child.send("finish");
          await clients[1]!.completion;
          expect(fs.readFileSync(clients[1]!.ready + ".read", "utf8")).toBe("read");
          await expect(disposal).rejects.toThrow("injected process-group join failure");
          expect(fs.existsSync(artifact)).toBe(true);
        } finally {
          for (const { child } of clients) {
            child.kill("SIGTERM");
          }
          await Promise.all(clients.map((client) => client.closed));
          await owner.dispose().catch(() => {});
          fs.rmSync(generation, { recursive: true, force: true });
        }
      }),
  );

  it("ends verification failure with a failed trailer", (context) =>
    fixtureLifetime.run(async () => {
      const { node } = createFixtureCommands(context);
      const directory = fixtureDirectory();
      const { config } = workerProbe(directory);
      const reporter = writeFixture(
        directory,
        "tamper-reporter.mjs",
        `
      import fs from 'node:fs';
      export default class {
        onTestRunEnd() {
          const generation=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(directory, "generations.jsonl"))},'utf8').trim().split('\\n')[0]);
          fs.appendFileSync(new URL('../tui/tui.js',generation),'\\n// altered output\\n');
        }
      }
    `,
      );
      const result = await node([
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        config,
        "--reporter=default",
        `--reporter=${reporter}`,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Compiled subprocess artifact changed");
      expect(result.stderr).not.toContain("[test] passed");
      expect(result.stderr.trim().split("\n").at(-1)).toBe("[test] FAILED (exit 1)");
    }));

  it("does not build for config imports, pure shards, or metadata collection", (context) =>
    fixtureLifetime.run(async () => {
      const { node, startBorrower } = createFixtureCommands(context);
      const directory = fixtureDirectory();
      const test = writeFixture(
        directory,
        "tiny.test.ts",
        "import {it,expect} from 'vitest'; it('tiny',()=>expect(2+2).toBe(4));",
      );
      const config = writeFixture(
        directory,
        "vitest.config.mts",
        `
      import {sharedVitestConfig as shared} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.shared.config.ts")).href)};
      export default Promise.resolve({plugins:shared.plugins,test:{include:[${JSON.stringify(convertPathToPattern(test))}]}});
    `,
      );
      const imported = await node([
        "--import",
        pathToFileURL(path.join(root, "scripts/tsx.mjs")).href,
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(config).href)});`,
      ]);
      expect(imported.code, imported.stderr).toBe(0);
      expect(imported.stderr).not.toContain("[vitest-workers] prepared");
      for (const args of [
        ["run", "--config", config],
        ["list", "--config", config],
      ]) {
        const result = await node(["scripts/run-vitest.mjs", ...args]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("[vitest-workers] prepared");
      }
      const owner = createVitestWorkerRun();
      const generation = owner.descriptor.directory;
      try {
        const results = await Promise.all(
          [0, 1].map(() => startBorrower(owner, ["run", "--config", config]).result),
        );
        for (const result of results) {
          expect(result.code, result.stderr + result.stdout).toBe(0);
          expect(stripVitestAnsi(result.stdout)).toMatch(/Tests\s+1 passed/);
        }
        expect(fs.existsSync(path.join(generation, "manifest.json"))).toBe(false);
      } finally {
        await owner.dispose();
      }
    }));

  it("keeps watch launches on live source across dependency edits", ({ onTestFinished }) =>
    fixtureLifetime.run(async () => {
      const directory = fixtureDirectory();
      const observed = path.join(directory, "watch-result.txt");
      const dependency = writeFixture(
        directory,
        "value.ts",
        'export const value: string = "first"; console.log(value);',
      );
      const test = writeFixture(
        directory,
        "watch.test.ts",
        `
      import {execFileSync} from 'node:child_process';
      import fs from 'node:fs';
      import {it,expect} from 'vitest';
      import {value} from './value.ts';
      import {runtimeProcessEntrypoints} from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
      import {tuiPtyRuntimeEntrypoints} from ${JSON.stringify(path.join(root, "src/tui/tui-pty-runtime-test-support.ts"))};
      import {resolveRuntimeWorkerUrl} from ${JSON.stringify(path.join(root, "src/infra/runtime-worker-url.ts"))};
      it('uses live source',()=>{
        expect(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly).pathname).toMatch(/\\.ts$/);
        for (const entry of Object.values(tuiPtyRuntimeEntrypoints)) expect(resolveRuntimeWorkerUrl(entry).pathname).toMatch(/\\.ts$/);
        const actual=execFileSync(process.execPath,['--import','tsx',${JSON.stringify(dependency)}],{encoding:'utf8'}).trim();
        expect(actual).toBe(value);
        fs.writeFileSync(${JSON.stringify(observed)},actual);
      });
    `,
      );
      const config = writeFixture(
        directory,
        "vitest.config.mts",
        `
      import {sharedVitestConfig as shared} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.shared.config.ts")).href)};
      export default {plugins:shared.plugins,test:{include:[${JSON.stringify(convertPathToPattern(test))}],pool:'forks',maxWorkers:1}};
    `,
      );
      const handle = spawnWatchedVitestProcess({
        pnpmArgs: ["exec", "node", "node_modules/vitest/vitest.mjs", "--watch", "--config", config],
        spawnParams: resolveVitestSpawnParams(process.env),
        env: process.env,
      });
      let output = "";
      handle.child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      handle.child.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });
      onTestFinished(async () => {
        handle.child.kill("SIGTERM");
        await handle.completion;
      });
      try {
        await waitForFixtureFile(observed, handle.completion, "first");
        const rerun = waitForFixtureFile(observed, handle.completion, "second");
        fs.writeFileSync(dependency, 'export const value: string = "second"; console.log(value);');
        await rerun;
        expect(output).not.toContain("[vitest-workers] prepared");
      } finally {
        handle.child.kill("SIGTERM");
        await handle.completion;
      }
    }));

  it("builds changed source despite valid stale dist and fails visibly on missing artifacts and build errors", (context) =>
    fixtureLifetime.run(async () => {
      const { node, prepareWorkers } = createFixtureCommands(context);
      const fixture = fixtureDirectory();
      const initial = createVitestWorkerRun();
      const initialDirectory = initial.descriptor.directory;
      try {
        await prepareWorkers(initial);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(initialDirectory, "manifest.json"), "utf8"),
        ) as { inputs: Record<string, string> };
        for (const filename of [
          ...Object.keys(manifest.inputs),
          ...tooling.map((name) => path.join(root, name)),
        ]) {
          const target = path.join(fixture, path.relative(root, filename));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(filename, target);
        }
        // This is a synthetic source checkout. Its dist is valid old code, not an
        // invalid sentinel that could fail even if stale-artifact fallback regressed.
        fs.cpSync(path.join(initialDirectory, "dist"), path.join(fixture, "dist"), {
          recursive: true,
        });
        const databasePath = path.join(fixture, "probe.sqlite");
        const database = new DatabaseSync(databasePath);
        database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('native work');");
        database.close();
        const childArgs = ["--openclaw-sqlite-readonly-child", "async", databasePath];
        const stale = await node([
          path.join(fixture, "dist/infra/sqlite-readonly-location.worker.js"),
          ...childArgs,
        ]);
        expect(stale.code, stale.stderr).toBe(0);
        fs.rmSync(path.dirname(JSON.parse(stale.stdout).location), { recursive: true });

        const dependency = path.join(fixture, "src/infra/sqlite-runtime-version.ts");
        fs.writeFileSync(
          dependency,
          fs
            .readFileSync(dependency, "utf8")
            .replace("major: 3, minor: 51", "major: 99, minor: 51"),
        );
        const compilerUrl = pathToFileURL(path.join(fixture, compilerModule)).href;
        const buildScript = `
        import {spawn} from 'node:child_process';
        import {createVitestWorkerRun} from ${JSON.stringify(compilerUrl)};
        import {createVitestProcessCompletion} from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/vitest-process-group.mts")).href)};
        const owner=createVitestWorkerRun();
        const client=${JSON.stringify(preparationClient.replace(pathToFileURL(path.join(root, artifactsModule)).href, pathToFileURL(path.join(fixture, artifactsModule)).href))};
        const child=spawn(process.execPath,['--input-type=module','--eval',client],{stdio:['ignore','ignore','inherit','ipc']});
        const result=await owner.borrow(child,createVitestProcessCompletion({child,detached:false}));
        if(result.code !== 0) {await owner.dispose();throw new Error('preparation failed');}
        console.log(JSON.stringify(owner.descriptor.directory));
      `;
        const builds = await Promise.all(
          [0, 1].map(() => node(["--input-type=module", "-e", buildScript], fixture)),
        );
        const directories: string[] = [];
        for (const build of builds) {
          expect(build.code, build.stderr).toBe(0);
          directories.push(JSON.parse(build.stdout));
        }
        expect(new Set(directories).size).toBe(2);
        const freshWorker = path.join(
          directories[0]!,
          "dist/infra/sqlite-readonly-location.worker.js",
        );
        const fresh = await node([freshWorker, ...childArgs]);
        expect(fresh.code).toBe(1);
        expect(JSON.parse(fresh.stdout)).toMatchObject({
          ok: false,
          message: expect.stringContaining("unsafe"),
        });
        const changedSource = fs.readFileSync(dependency, "utf8");
        fs.appendFileSync(dependency, "\n// changed after preparation\n");
        expect(() => verifyVitestWorkerArtifacts(directories[1]!)).toThrow(
          "Source changed during compiled subprocess invocation",
        );
        fs.writeFileSync(dependency, changedSource);
        const tuiDeclaration = path.join(fixture, "src/tui/tui-pty-runtime-test-support.ts");
        const originalDeclaration = fs.readFileSync(tuiDeclaration, "utf8");
        fs.appendFileSync(tuiDeclaration, "\n// declaration changed after preparation\n");
        expect(() => verifyVitestWorkerArtifacts(directories[1]!)).toThrow(
          "Source changed during compiled subprocess invocation",
        );
        fs.writeFileSync(tuiDeclaration, originalDeclaration);
        fs.rmSync(freshWorker);
        const missing = await node([freshWorker, ...childArgs]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("MODULE_NOT_FOUND");
        const parent = path.join(fixture, ".artifacts/vitest-workers");
        const before = fs.readdirSync(parent).toSorted();
        const client = writeFixture(
          fixture,
          "failed-client.mjs",
          `import {requestVitestWorkerArtifacts} from ${JSON.stringify(pathToFileURL(path.join(fixture, artifactsModule)).href)};
        try {await requestVitestWorkerArtifacts();}
        catch(error) {console.error('owner refused:',error);process.exitCode=1;}
        finally {process.disconnect();}`,
        );
        const failedOwner = writeFixture(
          fixture,
          "failed-owner.mjs",
          `import {spawn} from 'node:child_process';
        import {createVitestWorkerRun} from ${JSON.stringify(compilerUrl)};
        import {createVitestProcessCompletion} from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/vitest-process-group.mts")).href)};
        import {runWithFailedTrailer} from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/failed-trailer.mts")).href)};
        await runWithFailedTrailer('test',async()=>{
          const owner=createVitestWorkerRun();
          const child=spawn(process.execPath,[${JSON.stringify(client)}],{stdio:['ignore','ignore','inherit','ipc']});
          try {
            const result=await owner.borrow(child,createVitestProcessCompletion({child,detached:false}));
            process.exitCode=result.code;
          } finally {await owner.dispose();}
        });`,
        );
        writeFixture(fixture, "dist/source-input.js", changedSource);
        for (const [source, error] of [
          ["this is not valid TypeScript !", "Build failed"],
          ["export * from '../../dist/source-input.js';", "tried to read dist"],
        ]) {
          fs.writeFileSync(dependency, source!);
          const failed = await node([failedOwner], fixture);
          expect(failed.code).not.toBe(0);
          expect(failed.stderr).toContain("owner refused:");
          expect(failed.stderr).toContain(error!);
          expect(failed.stderr.trim().split("\n").at(-1)).toBe("[test] FAILED (exit 1)");
          expect(fs.readdirSync(parent).toSorted()).toEqual(before);
        }
      } finally {
        await initial.dispose();
      }
    }));
});
