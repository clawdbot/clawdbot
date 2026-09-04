import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findTsgoCoreTestShardViolations,
  selectChangedTsgoCoreTestShards,
  TSGO_CORE_GRAPHS,
  selectTsgoCoreTestShards,
  selectTsgoCoreTestStripe,
  TSGO_CORE_TEST_SHARDS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForPidFile } from "../helpers/process-wait.js";
import { runNodeScript } from "../helpers/run-node-script.js";

describe("tsgo core test shards", () => {
  it("stripes partition the full shard list exactly once", () => {
    for (const stripeCount of [1, 2, 3, 5]) {
      const striped = Array.from(
        { length: stripeCount },
        (_, index) => selectTsgoCoreTestStripe(`${index + 1}/${stripeCount}`) ?? [],
      );
      expect(
        striped
          .flat()
          .map((shard) => shard.name)
          .toSorted(),
      ).toEqual(TSGO_CORE_TEST_SHARDS.map((shard) => shard.name).toSorted());
      // Round-robin keeps stripe sizes within one shard of each other.
      const sizes = striped.map((shards) => shards.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
    expect(selectTsgoCoreTestStripe("0/2")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("3/2")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("src")).toBeUndefined();
  });

  it("accepts an exact once-only partition within the root budget", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts"],
        maxRoots: 1,
        shards: [
          { name: "a", roots: ["src/a.test.ts"] },
          { name: "b", roots: ["src/b.test.ts"] },
        ],
      }),
    ).toEqual([]);
  });

  it("reports missing, duplicate, extra, and oversized shard roots", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts", "src/missing.test.ts"],
        maxRoots: 1,
        shards: [
          { name: "first", roots: ["src/a.test.ts", "src/b.test.ts"] },
          { name: "second", roots: ["src/b.test.ts", "src/extra.test.ts"] },
        ],
      }),
    ).toEqual([
      "first: 2 test roots exceeds the 1 limit",
      "second: 2 test roots exceeds the 1 limit",
      "assigned 2 times (first, second): src/b.test.ts",
      "unassigned: src/missing.test.ts",
      "not in the canonical core-test graph (second): src/extra.test.ts",
    ]);
  });

  it.each(["src", "ui", "packages"])(
    "retains shared extension declarations for the %s alias",
    (group) => {
      const shards = selectTsgoCoreTestShards(group);

      expect(shards?.at(-1)).toEqual({
        name: "extension-declarations",
        config: "test/tsconfig/tsconfig.test.extension-declarations.json",
        sparseRoots: ["extensions", "src", "ui/src"],
      });
    },
  );

  it("keeps the full core-test run scoped to its canonical shards", () => {
    expect(selectTsgoCoreTestShards()).not.toContainEqual(
      expect.objectContaining({ name: "extension-declarations" }),
    );
  });

  it("routes aggregate package aliases through bounded processes", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["tsgo:core:all"]).toContain("pnpm tsgo:core:test");
    expect(packageJson.scripts["tsgo:core:all"]).not.toContain("run-tsgo.mjs -b");
    expect(packageJson.scripts["tsgo:all"]).toContain("pnpm tsgo:core:all");
    expect(packageJson.scripts["tsgo:all"]).not.toContain("run-tsgo.mjs -b");
  });
});

describe("changed core test graph selection", () => {
  const leaf = "src/agents/nested/leaf.test.ts";
  const inventory = () =>
    TSGO_CORE_GRAPHS.map((graph) => ({
      ...graph,
      roots: graph.name === "core-test-agents-other" ? [leaf] : [],
      files: graph.name === "core-test-agents-other" ? [leaf] : [],
    }));

  it("includes a consuming graph even when another graph owns the test root", () => {
    const graphs = inventory();
    graphs.find((graph) => graph.name === "core-test-agents-tools")!.files.push(leaf);
    expect(selectChangedTsgoCoreTestShards([leaf], graphs)?.map((shard) => shard.name)).toEqual([
      "agents-other",
      "agents-tools",
    ]);
  });

  it.for([
    [],
    ["src/owner.ts"],
    ["test/tsconfig/tsconfig.core.test.json"],
    ["src/shared.test-support.ts"],
    ["src/missing.test.ts"],
    [leaf, "package.json"],
  ])("retains full checks for unsupported changed paths %j", (paths) => {
    expect(selectChangedTsgoCoreTestShards(paths, inventory())).toBeUndefined();
  });

  it.each(["incomplete", "duplicate", "deleted", "production", "ambiguous"])(
    "retains full checks for %s ownership",
    (failure) => {
      const graphs = inventory();
      if (failure === "incomplete") {
        graphs.shift();
      }
      if (failure === "duplicate") {
        graphs.push(graphs[0]!);
      }
      if (failure === "deleted") {
        graphs.forEach((graph) => {
          graph.files = [];
        });
      }
      if (failure === "production") {
        graphs[0]!.files.push(leaf);
      }
      if (failure === "ambiguous") {
        graphs.find((graph) => graph.name === "core-test-agents-tools")!.roots.push(leaf);
      }
      expect(selectChangedTsgoCoreTestShards([leaf], graphs)).toBeUndefined();
    },
  );
});

// The compiler owns dependency reachability; test root partitions alone cannot prove it.
const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

it.runIf(process.platform !== "win32")(
  "checks a real type error in the non-root importing graph without repeating enumeration",
  ({ signal }) =>
    lifetime.run(async () => {
      const sourceRoot = process.cwd();
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-changed-types-"));
      const write = (name: string, content: string) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return file;
      };
      write("package.json", '{"type":"module"}');
      write("pnpm-workspace.yaml", "packages: []\n");
      for (const name of [
        "check-tsgo-core-boundary.mts",
        "run-tsgo-core-test-shards.mts",
        "run-tsgo.mts",
      ]) {
        write(`scripts/${name}`, fs.readFileSync(path.join(sourceRoot, "scripts", name), "utf8"));
      }
      fs.symlinkSync(path.join(sourceRoot, "scripts/lib"), path.join(root, "scripts/lib"), "dir");
      const leaf = "src/agents/nested/leaf.test.ts";
      const consumer = "src/agents/tools/consumer.test.ts";
      write(leaf, "export type Value = number;\n");
      write(consumer, "export {};\n");
      write("src/empty.ts", "export {};\n");
      const configs = [
        ...TSGO_CORE_GRAPHS,
        { name: "canonical", config: "test/tsconfig/tsconfig.core.test.json" },
      ];
      for (const { name, config } of configs) {
        const files =
          name === "canonical"
            ? [leaf, consumer]
            : name === "core-test-agents-other"
              ? [leaf]
              : name === "core-test-agents-tools"
                ? [consumer]
                : ["src/empty.ts"];
        write(
          config,
          JSON.stringify({
            compilerOptions: {
              noEmit: true,
              strict: true,
              types: [],
              module: "nodenext",
              target: "es2022",
              incremental: true,
              tsBuildInfoFile: path.join(root, `.artifacts/${name}.tsbuildinfo`),
            },
            files: files.map((file) => path.join(root, file)),
          }),
        );
      }
      const compiler = write(
        "node_modules/.bin/tsgo",
        `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(),'compiler-events.jsonl'),JSON.stringify(args)+'\\n');
const result=spawnSync(process.execPath,[${JSON.stringify(path.join(sourceRoot, "node_modules/@typescript/native-preview/bin/tsgo"))},...args],{stdio:'inherit'});
process.exit(result.status??1);
`,
      );
      fs.chmodSync(compiler, 0o755);
      const driver = path.join(root, "scripts/run-tsgo-core-test-shards.mts");
      const changedArgs = (paths: string[]) => ["--changed-paths-json", JSON.stringify(paths)];
      const check = async (paths = [leaf]) => {
        write("compiler-events.jsonl", "");
        const result = await lifetime.track(
          runNodeScript(
            [
              "--import",
              pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href,
              driver,
              ...changedArgs(paths),
            ],
            { ...process.env, OPENCLAW_LOCAL_CHECK: "0" },
            undefined,
            { cwd: root, signal, requireProcessTreeExit: true },
          ),
        );
        const calls = fs
          .readFileSync(path.join(root, "compiler-events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        expect(calls.filter((args) => args.includes("--listFilesOnly"))).toHaveLength(
          TSGO_CORE_GRAPHS.length,
        );
        const builds = calls
          .filter((args) => args.includes("-b"))
          .map((args) => args[args.indexOf("-b") + 1]);
        return { result, builds };
      };
      const initial = await check();
      expect(initial.result.status, initial.result.stderr).toBe(0);
      expect(initial.builds).toEqual(["test/tsconfig/tsconfig.core.test.agents-other.json"]);
      write(
        consumer,
        "import type {Value} from '../nested/leaf.test.js';\nconst value: Value = 1;\n",
      );
      const validConsumer = await check();
      expect(validConsumer.result.status, validConsumer.result.stderr).toBe(0);
      expect(validConsumer.builds).toEqual([
        "test/tsconfig/tsconfig.core.test.agents-other.json",
        "test/tsconfig/tsconfig.core.test.agents-tools.json",
      ]);
      // A removed rename source has no current root: keep the full canonical check.
      const renamed = await check([leaf, "src/agents/old.test.ts"]);
      expect(renamed.result.status, renamed.result.stderr).toBe(0);
      expect(renamed.builds).toEqual(TSGO_CORE_TEST_SHARDS.map((shard) => shard.config));
      write(leaf, "export type Value = string;\n");
      const brokenConsumer = await check();
      expect(brokenConsumer.result.status).not.toBe(0);
      expect(brokenConsumer.builds).toEqual(validConsumer.builds);
      expect(brokenConsumer.result.stdout + brokenConsumer.result.stderr).toContain(
        "consumer.test.ts(2,7): error TS2322",
      );
      // Target only the boundary owner PID; its managed compiler must forward and join its group.
      write(
        "node_modules/.bin/tsgo",
        `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(0)); process.send('ready'); setInterval(()=>{},1000);"],{stdio:['ignore','ignore','ignore','ipc']});
let terminating=false;
const finish=()=>{if(terminating && (child.exitCode!==null || child.signalCode!==null)){fs.writeFileSync('compiler.joined','joined');process.exit(0);}};
child.once('exit',finish);
process.on('SIGTERM',()=>{terminating=true;fs.writeFileSync('compiler.signal','SIGTERM');finish();});
child.once('message',()=>{child.disconnect();fs.writeFileSync('compiler.pid',String(process.pid));fs.writeFileSync('descendant.pid',String(child.pid));});
setInterval(()=>{},1000);
`,
      );
      let ownerPid: number | undefined;
      const cancel = new AbortController();
      const running = lifetime.track(
        runNodeScript(
          [
            "--import",
            pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href,
            driver,
            ...changedArgs([leaf]),
          ],
          { ...process.env, OPENCLAW_LOCAL_CHECK: "0" },
          undefined,
          {
            cwd: root,
            signal: AbortSignal.any([signal, cancel.signal]),
            requireProcessTreeExit: true,
            onReady(child) {
              ownerPid = child.pid;
            },
          },
        ),
      );
      try {
        const compilerPid = await waitForPidFile(path.join(root, "compiler.pid"), 5_000);
        const descendantPid = await waitForPidFile(path.join(root, "descendant.pid"), 5_000);
        expect(ownerPid).toBeDefined();
        process.kill(ownerPid!, "SIGTERM");
        const canceled = await running;
        expect(canceled.error).toBeUndefined();
        expect(canceled.status).toBe(143);
        expect(canceled.stderr).toContain("interrupted by SIGTERM");
        expect(fs.readFileSync(path.join(root, "compiler.signal"), "utf8")).toBe("SIGTERM");
        expect(fs.readFileSync(path.join(root, "compiler.joined"), "utf8")).toBe("joined");
        expect(isProcessAlive(compilerPid)).toBe(false);
        expect(isProcessAlive(descendantPid)).toBe(false);
        expect(() => process.kill(-compilerPid, 0)).toThrow();
      } finally {
        cancel.abort();
        await running;
      }
    }),
);
