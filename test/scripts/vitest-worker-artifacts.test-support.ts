import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { convertPathToPattern } from "tinyglobby";
import { expect, it, vi, type TestContext } from "vitest";
import type { VitestWorkerManifest } from "../../scripts/lib/vitest-worker-artifacts.mts";
import type { VitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { resolveVitestSpawnParams, spawnWatchedVitestProcess } from "../../scripts/run-vitest.mts";
import { createVitestProcessCompletion } from "../../scripts/vitest-process-group.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const root = process.cwd();
const artifacts = path.join(root, ".artifacts");
const artifactsModule = "scripts/lib/vitest-worker-artifacts.mts";
export const preparationClient = `
  import {requestVitestWorkerArtifacts} from ${JSON.stringify(pathToFileURL(path.join(root, artifactsModule)).href)};
  try {await requestVitestWorkerArtifacts();}
  catch (error) {console.error(error);process.exitCode=1;}
  finally {process.disconnect();}
`;

function createWorkerArtifactFixtures({
  signal,
  onTestFinished,
}: Pick<TestContext, "signal" | "onTestFinished">) {
  const fixtureLifetime = createFixtureLifetime();
  function fixtureDirectory() {
    fs.mkdirSync(artifacts, { recursive: true });
    return fixtureLifetime.createTempDir("worker proof-", artifacts);
  }

  function createFixtureCommands() {
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

  return { fixtureLifetime, fixtureDirectory, createFixtureCommands };
}

export function createWorkerArtifactTest() {
  const test = it.extend<{ workerArtifacts: ReturnType<typeof createWorkerArtifactFixtures> }>({
    workerArtifacts: async ({ signal, onTestFinished }, use) => {
      await use(createWorkerArtifactFixtures({ signal, onTestFinished }));
    },
  });
  // Resolve the case's lifetime before runTest so cleanup follows onTestFinished.
  // Ordinary fixture teardown runs earlier and can wait on children not yet aborted.
  test.aroundEach(async (runTest, { workerArtifacts }) => {
    try {
      await runTest();
    } finally {
      await workerArtifacts.fixtureLifetime.cleanup();
    }
  });
  test.beforeAll(() => {
    vi.setConfig({ maxConcurrency: 2 });
    return () => vi.resetConfig();
  });
  return test;
}

export function writeFixture(directory: string, name: string, source: string) {
  const filename = path.join(directory, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source);
  return filename;
}

export function waitForFixtureFile(
  filename: string,
  completion: Promise<unknown>,
  expected?: string,
) {
  return new Promise<void>((resolve, reject) => {
    const matches = () =>
      fs.existsSync(filename) &&
      fs.statSync(filename).size > 0 &&
      (expected === undefined || fs.readFileSync(filename, "utf8") === expected);
    const check = () => {
      if (matches()) {
        clearInterval(poll);
        resolve();
      }
    };
    // watchFile can adopt a newly created receipt in its first stat without an event.
    // Poll the persistent state itself so readiness never depends on that race.
    const poll = setInterval(check, 50);
    void completion.then(
      () => {
        clearInterval(poll);
        if (matches()) {
          resolve();
        } else {
          reject(new Error(`Child exited before writing ${filename}`));
        }
      },
      (error: unknown) => {
        clearInterval(poll);
        reject(new Error(`Child failed before writing ${filename}`, { cause: error }));
      },
    );
    check();
  });
}

export function workerProbe(
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
    import { Worker } from 'node:worker_threads';
    import { it, expect, vi, inject } from 'vitest';
    import {value} from '#fixture-value';
    import { runtimeProcessEntrypoints } from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
    import { vectorKnnProcessEntrypoint } from ${JSON.stringify(path.join(root, "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts"))};
    import { runtimeProcessBuildEntries } from ${JSON.stringify(path.join(root, "scripts/lib/runtime-process-build-entries.mts"))};
    import { vitestWorkerBuildEntries } from ${JSON.stringify(path.join(root, "scripts/lib/vitest-worker-build-entries.mts"))};
    import { tuiPtyRuntimeEntrypoints } from ${JSON.stringify(path.join(root, "src/tui/tui-pty-runtime-test-support.ts"))};
    import { cliCompactionBackendEntrypoints } from ${JSON.stringify(path.join(root, "src/agents/command/cli-compaction-runtime.test-support.ts"))};
    import { resolveRuntimeWorkerUrl } from ${JSON.stringify(path.join(root, "src/infra/runtime-worker-url.ts"))};
    import { prepareSqliteReadOnlyLocation } from ${JSON.stringify(path.join(root, "src/infra/sqlite-readonly-location.ts"))};
    import { runSqliteTranscriptArchivePublishWorker } from ${JSON.stringify(path.join(root, "src/config/sessions/session-accessor.sqlite-archive.ts"))};
    const tuiUrls = Object.values(tuiPtyRuntimeEntrypoints).map(entry => resolveRuntimeWorkerUrl(entry).href);
    const setupUrls = cliCompactionBackendEntrypoints.map(entry => resolveRuntimeWorkerUrl(entry).href);
    // Import acquisition must finish during collection, before any fixture hook starts.
    const entriesPresentAtCollection = [...tuiUrls,...setupUrls].every(url => fs.existsSync(new URL(url)));
    vi.mock('node:child_process', async (original) => {
      const actual = await original();
      return {...actual, execFile: vi.fn(actual.execFile)};
    });
    vi.mock('node:worker_threads', async (original) => {
      const actual = await original();
      return {...actual, Worker: vi.fn(function(...args) { return new actual.Worker(...args); })};
    });
    it('runs current SQLite code in the expected execution mode', async () => {
      const launcherArgv = inject('launcherArgv');
      expect(path.isAbsolute(launcherArgv[1])).toBe(true);
      expect(path.basename(launcherArgv[1])).toBe('vitest.mjs');
      expect(Object.values(runtimeProcessBuildEntries)).toHaveLength(Object.keys(runtimeProcessEntrypoints).length + 1);
      for (const source of Object.values(runtimeProcessBuildEntries)) {
        expect(source).not.toContain('/dist/');
        expect(source).toMatch(/\\.ts$/);
        expect(fs.existsSync(source)).toBe(true);
      }
      expect(entriesPresentAtCollection).toBe(true);
      for (const entry of [...Object.values(tuiPtyRuntimeEntrypoints),...cliCompactionBackendEntrypoints]) {
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
          // The executable identifies the generation; its descriptor may live in a shared chunk.
          const generation = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly).href;
          const sourceMode = ${mode === "auto" ? "generation.endsWith('.ts')" : mode === "source"};
          await expect(runSqliteTranscriptArchivePublishWorker([])).resolves.toEqual([]);
          const [archiveUrl] = Worker.mock.calls.at(-1);
          expect(archiveUrl.href.endsWith(sourceMode ? '.ts' : '.js')).toBe(true);
          if (!sourceMode) expect(fileURLToPath(archiveUrl).startsWith(fileURLToPath(new URL('../', generation)))).toBe(true);
          expect(tuiUrls).toHaveLength(4);
          expect(setupUrls).toHaveLength(2);
          for (const url of [...tuiUrls,...setupUrls]) {
            expect(url.endsWith(sourceMode ? '.ts' : '.js')).toBe(true);
            if (!sourceMode) expect(fileURLToPath(url).startsWith(fileURLToPath(new URL('../', generation)))).toBe(true);
          }
          expect(args.includes('tsx')).toBe(sourceMode);
          expect(args[sourceMode ? 2 : 0]).toMatch(sourceMode ? /\\.ts$/ : /\\.js$/);
          fs.appendFileSync(${JSON.stringify(path.join(directory, "observations.jsonl"))}, JSON.stringify({args, tuiUrls, setupUrls, value, configValue:inject('configValue'), knn:resolveRuntimeWorkerUrl(vectorKnnProcessEntrypoint).href})+'\\n');
          fs.appendFileSync(${JSON.stringify(path.join(directory, "generations.jsonl"))}, JSON.stringify(generation)+'\\n');
          const release = inject('releaseFile');
          if (release) await new Promise(resolve => {
            const check = () => {if(fs.existsSync(release)){clearInterval(poll);resolve();}};
            const poll=setInterval(check,50);
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
