import fs from "node:fs";
import path from "node:path";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { waitForPidFile } from "../helpers/process-wait.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const configs = [
  "test/vitest/vitest.unit-fast-isolated.config.ts",
  "test/vitest/vitest.agents-embedded-agent.config.ts",
];

export type ReportFixtureMode =
  | "overlap"
  | "serial"
  | "parallel"
  | "grouped"
  | "grouped-conflict"
  | "batch"
  | "batch-real-home"
  | "batch-parallel"
  | "batch-failure"
  | "batch-fail-fast"
  | "batch-cancel"
  | "failure"
  | "fail-fast"
  | "unhandled"
  | "ignored-unhandled"
  | "empty"
  | "retry"
  | "watchdog"
  | "cancel"
  | "missing"
  | "corrupt"
  | "merge-failure"
  | "child-write"
  | "final-write"
  | "publish-write"
  | "identity"
  | "pool-identity"
  | "config-error"
  | "suite-error"
  | "metadata"
  | "coverage-missing"
  | "teardown-timeout"
  | "single"
  | "tuple"
  | "dotted"
  | "chunks";

/** Tiny native configs shared by regression tests and retained operator proofs. */
export function createVitestReportFixture(root: string, evidence = path.join(root, "reports")) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "config/openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "xdg/config"),
    XDG_CACHE_HOME: path.join(root, "xdg/cache"),
    XDG_DATA_HOME: path.join(root, "xdg/data"),
    XDG_STATE_HOME: path.join(root, "xdg/state"),
    XDG_RUNTIME_DIR: path.join(root, "xdg/runtime"),
    TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
    TSX_DISABLE_CACHE: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    COREPACK_ENABLE_NETWORK: "0",
    GIT_OPTIONAL_LOCKS: "0",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TZ: "UTC",
    OPENCLAW_TEST_PROJECTS_TIMINGS: "0",
    OPENCLAW_VITEST_MAX_WORKERS: "1",
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "cache"),
    OPENCLAW_VITEST_NO_OUTPUT_RETRY: "0",
    OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "20000",
  };
  for (const [key, value] of Object.entries(env)) {
    if (value?.startsWith(root) && key !== "OPENCLAW_CONFIG_PATH") {
      fs.mkdirSync(value, { recursive: true });
    }
  }
  write(env.OPENCLAW_CONFIG_PATH!, "{}");

  return async (
    mode: ReportFixtureMode,
    options: {
      nativeArgs?: string[];
      entry?: "projects" | "batch-cli";
      report?: boolean;
      crashSignal?: "SIGABRT" | "SIGKILL";
    } = {},
  ) => {
    const deadline = performance.now() + 45000;
    const output = path.join(evidence, "result.json");
    const ready = path.join(root, "ready");
    const done = path.join(root, "beta.done");
    const events = path.join(evidence, "executed.jsonl");
    const realHomeReplay = mode === "batch-real-home";
    if (realHomeReplay) {
      env.USERPROFILE = env.HOME;
      env.OPENCLAW_LIVE_TEST = "1";
      env.OPENCLAW_LIVE_USE_REAL_HOME = "1";
      env.OPENCLAW_LIVE_TEST_QUIET = "1";
      env.OPENCLAW_VITEST_INCLUDE_FILE = path.join(root, "includes.json");
      write(
        env.OPENCLAW_VITEST_INCLUDE_FILE,
        JSON.stringify([path.join(root, "alpha.test.ts"), path.join(root, "beta.test.ts")]),
      );
      write(path.join(env.HOME!, "canary"), "synthetic caller home\n");
    }
    const isParallel = ["parallel", "batch-parallel", "failure", "overlap"].includes(mode);
    for (const [index, name] of ["alpha", "beta"].entries()) {
      const prelude = `import fs from 'node:fs';
${mode === "teardown-timeout" && index === 0 ? "setInterval(()=>{},1000);" : ""}
const merging = process.argv.includes('--mergeReports');
${options.crashSignal && index === 0 ? `if(!merging){process.kill(process.pid,${JSON.stringify(options.crashSignal)});await new Promise(()=>setInterval(()=>{},1000));}` : ""}
const output = process.argv.find(arg => arg.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
${mode === "coverage-missing" && index === 0 ? `if(!merging)process.once('exit',()=>{const dir=process.argv.find(arg=>arg.startsWith('--coverage.reportsDirectory='))?.split('=').slice(1).join('=');if(dir&&fs.existsSync(dir+'/lcov.info')){fs.copyFileSync(dir+'/lcov.info',dir+'/lcov.info.native-original');fs.unlinkSync(dir+'/lcov.info');}});` : ""}
${mode === "merge-failure" ? `if(merging)throw new Error('owned native merge failure');` : ""}
${mode === "config-error" && index === 1 ? "throw new Error('owned configuration failure');" : ""}
${mode === "final-write" ? `if(merging&&output)fs.mkdirSync(output);` : ""}
${mode === "child-write" && index === 0 ? `if(!merging&&output)fs.mkdirSync(output);` : ""}
${mode === "watchdog" && index === 0 ? `if(!merging&&!fs.existsSync(${JSON.stringify(ready)})){fs.writeFileSync(${JSON.stringify(ready)},'started');await new Promise(()=>setInterval(()=>{},1000));}` : ""}
${["missing", "corrupt"].includes(mode) && index === 0 ? `if(!merging)process.once('exit',()=>{const file=${mode === "missing" ? "output" : "process.argv.find(arg=>arg.startsWith('--outputFile.blob='))?.slice('--outputFile.blob='.length)"};if(file&&fs.existsSync(file)){fs.copyFileSync(file,file+'.native-original');${mode === "missing" ? "fs.unlinkSync(file)" : "fs.writeFileSync(file,'owned corruption')"};}});` : ""}
`;
      write(
        path.join(root, configs[index]!),
        prelude +
          `export default {root:${JSON.stringify(root)},cacheDir:${JSON.stringify(path.join(root, "vite-" + name))},test:{name:${mode === "identity" ? `merging?'changed-${name}':'${name}'` : JSON.stringify(name)},include:[${mode === "empty" ? "'absent.test.ts'" : JSON.stringify(name + ".test.ts")}],${mode === "empty" ? "passWithNoTests:true," : ""}${mode === "ignored-unhandled" ? "dangerouslyIgnoreUnhandledErrors:true," : ""}pool:${mode === "pool-identity" ? "merging?'threads':'forks'" : "'forks'"},maxWorkers:1,fileParallelism:false,cache:false,experimental:{fsModuleCache:false},teardownTimeout:1000,${["metadata", "coverage-missing"].includes(mode) ? "coverage:{provider:'v8',include:['covered.ts'],reporter:['json','lcov']}," : ""}${mode === "tuple" ? `reporters:[['json',{outputFile:${JSON.stringify(path.join(evidence, "tuple.json"))}}]],` : ""}}};`,
      );
      const failure =
        (["failure", "batch-failure"].includes(mode) && index === 1) ||
        (["fail-fast", "batch-fail-fast"].includes(mode) && index === 0);
      const body = `import fs from 'node:fs';import {test,expect,describe,afterAll} from 'vitest';
${realHomeReplay ? "import {homedir} from 'node:os';" : ""}
${["metadata", "coverage-missing"].includes(mode) ? "import {classify} from './covered';" : ""}
let attempt=0;
test('${name}/one',${mode === "retry" && index === 0 ? "{retry:1}," : ""}async()=>{
 fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({name:'${name}/one',pid:process.pid})+'\\n');
 ${realHomeReplay ? `expect(process.env.HOME).toBe(${JSON.stringify(env.HOME)});expect(homedir()).toBe(${JSON.stringify(env.HOME)});` : ""}
 ${["parallel", "batch-parallel"].includes(mode) && index === 0 ? `const {waitForFile}=await import(${JSON.stringify(path.join(repoRoot, "test/helpers/process-wait.ts"))});await waitForFile(${JSON.stringify(done)},15000);` : ""}
 ${["cancel", "batch-cancel"].includes(mode) && index === 0 ? `fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));await new Promise(()=>setInterval(()=>{},1000));` : ""}
 ${["unhandled", "ignored-unhandled"].includes(mode) && index === 1 ? "void Promise.reject(new Error('owned unhandled rejection'));await new Promise(resolve=>setImmediate(resolve));" : ""}
 ${["metadata", "coverage-missing"].includes(mode) ? `expect(classify(${index})).toMatchInlineSnapshot(${JSON.stringify(index === 0 ? '"zero"' : '"one"')});` : mode === "overlap" ? "expect(0, 'independent failure pid='+process.pid).toBe(1);" : mode === "retry" && index === 0 ? "expect(++attempt).toBe(2);" : `expect(1).toBe(${failure ? 2 : 1});`}
 ${index === 1 ? `fs.writeFileSync(${JSON.stringify(done)},'done');` : ""}
});
${index === 0 ? "test('alpha/two',()=>expect(2).toBe(2));" : "test.skip('beta/skip',()=>{});test.todo('beta/todo');"}`;
      write(path.join(root, `${name}.test.ts`), body);
      if (mode === "suite-error" && index === 1) {
        fs.appendFileSync(
          path.join(root, `${name}.test.ts`),
          "\ndescribe('broken suite',()=>{test('body',()=>{});afterAll(()=>{throw new Error('owned suite failure')});});",
        );
      }
    }
    write(
      path.join(root, "covered.ts"),
      "export function classify(n:number){return n===0?'zero':'one'}",
    );
    let targets = mode === "single" ? [configs[0]!] : [...configs];
    if (mode === "grouped" || mode === "grouped-conflict") {
      const leaf = "test/vitest/vitest.alpha.config.ts";
      write(
        path.join(root, leaf),
        `export default {test:{name:'alpha',include:[${JSON.stringify(path.join(root, "alpha.test.ts"))}],pool:'threads',maxWorkers:1,cache:false,experimental:{fsModuleCache:false}}};`,
      );
      write(
        path.join(root, configs[1]!),
        `export default {test:{name:'beta',include:[${JSON.stringify(mode === "grouped-conflict" ? path.join(root, "beta.test.ts") : "beta.test.ts")}],pool:'forks',maxWorkers:1,cache:false,experimental:{fsModuleCache:false}}};`,
      );
      write(
        path.join(root, configs[0]!),
        `export default {root:${JSON.stringify(root)},test:{projects:${JSON.stringify([leaf, configs[1]])}}};`,
      );
    }
    if (mode === "chunks") {
      const files = [
        "extensions/telegram/src/owned-one.test.ts",
        "extensions/telegram/src/owned-two.test.ts",
      ];
      for (const [i, file] of files.entries()) {
        write(
          path.join(root, file),
          `import {test,expect} from 'vitest';test('chunk/${i}',()=>expect(1).toBe(1));`,
        );
      }
      write(
        path.join(root, "test/vitest/vitest.extension-telegram.config.ts"),
        `import fs from 'node:fs';const file=process.env.OPENCLAW_VITEST_INCLUDE_FILE;export default {root:${JSON.stringify(root)},cacheDir:${JSON.stringify(path.join(root, "vite-chunks"))},test:{name:'chunks',include:file?JSON.parse(fs.readFileSync(file,'utf8')):${JSON.stringify(files)},pool:'forks',maxWorkers:1,cache:false,experimental:{fsModuleCache:false}}};`,
      );
      env.OPENCLAW_VITEST_INCLUDE_FILE = path.join(root, "includes.json");
      write(env.OPENCLAW_VITEST_INCLUDE_FILE, JSON.stringify(files));
      targets = ["test/vitest/vitest.extension-telegram.config.ts"];
    }
    const args = [
      "--reporter=verbose",
      "--reporter=json",
      "--configLoader=runner",
      mode === "dotted" ? `--outputFile.json=${output}` : `--outputFile=${output}`,
    ];
    if (options.report === false) {
      args.splice(0, args.length, "--configLoader=runner");
    }
    args.push(...(options.nativeArgs ?? []));
    if (mode === "dotted") {
      args.push("--reporter", "json");
    }
    if (["metadata", "coverage-missing"].includes(mode)) {
      args.push("--coverage");
    }
    if (mode === "publish-write") {
      fs.mkdirSync(output);
      write(path.join(output, "old"), "old");
    } else if (
      [
        "missing",
        "corrupt",
        "merge-failure",
        "final-write",
        "identity",
        "pool-identity",
        "config-error",
      ].includes(mode)
    ) {
      write(output, "old report");
    }
    let command = [path.join(repoRoot, "scripts/run-vitest.mjs"), "run", ...targets, ...args];
    if (options.entry === "projects" || mode === "overlap") {
      if (mode === "overlap") {
        targets = [configs[0]!, `./${configs[0]}`];
      }
      command = [
        "--import",
        path.join(repoRoot, "node_modules/tsx/dist/loader.mjs"),
        path.join(repoRoot, "scripts/test-projects.mts"),
        ...targets,
        "--",
        ...args,
      ];
    }
    if (options.entry === "batch-cli") {
      command = [
        "--import",
        path.join(repoRoot, "node_modules/tsx/dist/loader.mjs"),
        path.join(repoRoot, "scripts/test-extension-batch.mts"),
        "alpha,beta",
        "--",
        ...args,
      ];
    } else if (mode.startsWith("batch")) {
      const plan = {
        extensionCount: 2,
        extensionIds: ["alpha", "beta"],
        estimatedCost: 2,
        hasTests: true,
        testFileCount: 2,
        planGroups: configs.map((config, i) => ({
          // Real-home admission needs a canonical live-aware owner, not custom fixture configs.
          config: realHomeReplay
            ? path.join(repoRoot, "test/vitest/vitest.tooling-isolated.config.ts")
            : path.join(root, config),
          estimatedCost: 1,
          extensionIds: [i ? "beta" : "alpha"],
          roots: [path.join(root, i ? "beta.test.ts" : "alpha.test.ts")],
          testFileCount: 1,
        })),
      };
      const entry = path.join(root, "batch.mts");
      write(
        entry,
        `import {runExtensionBatchPlan} from ${JSON.stringify(path.join(repoRoot, "scripts/test-extension-batch.mts"))};process.exitCode=await runExtensionBatchPlan(${JSON.stringify(plan)},{vitestArgs:${JSON.stringify(args)}});`,
      );
      command = ["--import", path.join(repoRoot, "node_modules/tsx/dist/loader.mjs"), entry];
    }
    const childEnv = {
      ...env,
      OPENCLAW_TEST_PROJECTS_PARALLEL: isParallel ? "2" : "1",
      OPENCLAW_TEST_PROJECTS_SERIAL: isParallel ? "0" : "1",
      OPENCLAW_EXTENSION_BATCH_PARALLEL: isParallel ? "2" : "1",
      OPENCLAW_VITEST_NO_OUTPUT_RETRY:
        mode === "watchdog" ? "1" : env.OPENCLAW_VITEST_NO_OUTPUT_RETRY,
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS:
        mode === "watchdog" ? "1500" : env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS,
    };
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: command,
      homeMode: realHomeReplay ? "live-aware" : undefined,
      options: { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    });
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(
      () => child.kill("SIGTERM"),
      Math.max(0, deadline - performance.now()),
    );
    try {
      if (["cancel", "batch-cancel"].includes(mode)) {
        await waitForPidFile(ready, 15000);
        child.kill("SIGTERM");
      }
      const result = await completion;
      write(path.join(evidence, "stdout.log"), stdout);
      write(path.join(evidence, "stderr.log"), stderr);
      write(
        path.join(evidence, "run.json"),
        JSON.stringify(
          {
            command: [process.execPath, ...command],
            cwd: root,
            env: childEnv,
            ...result,
            pid: child.pid,
            joined: true,
          },
          null,
          2,
        ),
      );
      const reportSet = stderr.match(/\[test\] native report set: (.+)/u)?.[1];
      return { ...result, stdout, stderr, output, reportSet };
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await completion;
    }
  };
}
