import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TSDOWN_NON_SDK_DTS_CONFIG_GROUPS,
  TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  createFixture,
  declarationCacheRecords,
  expectStagingClean,
  runFixtureModule,
  runUnifiedWriter,
  runWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

const { createTempDir } = createScriptTestHarness();
const coreText = (origin: string) =>
  `export interface Marker { origin: "${origin}" }\ndeclare global { const declarationOrigin: "${origin}"; }\n`;

function nestedFixture(groups: readonly string[] = TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS) {
  const ancestor = fs.realpathSync.native(createTempDir("openclaw-declaration-resolution-"));
  const root = path.join(ancestor, ".claude/worktrees/validation");
  const fixture = createFixture(groups, root);
  const ancestorPackage = path.join(ancestor, "node_modules/@types/synthetic-core");
  fs.mkdirSync(ancestorPackage, { recursive: true });
  fs.writeFileSync(
    path.join(ancestorPackage, "package.json"),
    JSON.stringify({ name: "@types/synthetic-core", version: "1.0.0", types: "index.d.ts" }),
  );
  const ancestorInput = path.join(ancestorPackage, "index.d.ts");
  fs.writeFileSync(ancestorInput, coreText("ancestor"));
  const wrapper = "node_modules/.pnpm/wrapper/node_modules/@types/synthetic-wrapper";
  const local = "node_modules/.pnpm/core/node_modules/@types/synthetic-core";
  for (const [directory, name, text] of [
    [
      wrapper,
      "synthetic-wrapper",
      '/// <reference types="synthetic-core" />\nexport type { Marker } from "synthetic-core";\n',
    ],
    [local, "synthetic-core", coreText("local")],
    [
      "node_modules/@types/synthetic-automatic",
      "synthetic-automatic",
      'declare function declarationDirectoryName(): "declared-cwd";\n',
    ],
  ] as const) {
    fixture.write(
      `${directory}/package.json`,
      JSON.stringify({ name: `@types/${name}`, version: "2.0.0", types: "index.d.ts" }),
    );
    fixture.write(`${directory}/index.d.ts`, text);
  }
  const link = (target: string, alias: string) => {
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(alias), target), alias, "junction");
  };
  link(path.join(root, wrapper), path.join(root, "node_modules/@types/synthetic-wrapper"));
  link(path.join(root, local), path.join(root, path.dirname(wrapper), "synthetic-core"));
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")) as {
    compilerOptions: { types: string[] };
  };
  tsconfig.compilerOptions.types = ["synthetic-automatic"];
  fixture.write("tsconfig.json", JSON.stringify(tsconfig));
  fixture.write(
    "src/shared.ts",
    'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\nexport function directoryName() { return declarationDirectoryName(); }\nexport class Shared { private brand = "canonical"; }\n',
  );
  const entry = Object.values(fixture.declarations).flat()[0]!;
  fs.appendFileSync(
    path.join(root, entry),
    '\nexport { inferredOrigin } from "@openclaw/llm-core";\n',
  );
  return { ...fixture, ancestorInput, localInput: `${local}/index.d.ts` };
}

describe("tsdown checkout declaration resolution", () => {
  for (const kind of [
    "directory alias",
    "Windows 8.3 alias",
    "directory alias targeting Windows 8.3",
    "directory alias targeting a case alias",
  ]) {
    it.skipIf(kind.includes("Windows") && process.platform !== "win32")(
      `compiles and receipts every local input through a ${kind}`,
      (context) => {
        const { root, localInput, ancestorInput } = nestedFixture();
        // Even an ancestor package pointing back inside must remain undiscoverable.
        fs.rmSync(path.dirname(ancestorInput), { recursive: true });
        fs.symlinkSync(
          path.join(root, path.dirname(localInput)),
          path.dirname(ancestorInput),
          "junction",
        );
        let target = root;
        if (kind.includes("Windows")) {
          const short = spawnSync(
            "cmd.exe",
            ["/d", "/c", 'for %I in ("%DECLARATION_ALIAS_ROOT%") do @echo %~sI'],
            {
              encoding: "utf8",
              // cmd.exe owns this command's quotes; libuv must not backslash-escape them.
              windowsVerbatimArguments: true,
              env: { ...process.env, DECLARATION_ALIAS_ROOT: root },
            },
          );
          expect(short.status, short.stderr).toBe(0);
          target = short.stdout.trim();
          expect(fs.realpathSync.native(target)).toBe(root);
          if (fs.realpathSync(target).toLowerCase() === root.toLowerCase()) {
            context.skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
          }
        } else if (kind.endsWith("case alias")) {
          target = path.join(path.dirname(root), path.basename(root).toUpperCase());
          if (!fs.existsSync(target)) {
            context.skip("Filesystem does not expose a case-insensitive checkout alias");
          }
          expect(fs.realpathSync.native(target)).toBe(root);
        }
        let alias = target;
        if (kind.startsWith("directory alias")) {
          alias = `${root}-alias`;
          fs.symlinkSync(target, alias, "junction");
        }
        if (kind.startsWith("directory alias targeting")) {
          // Keep all three spellings distinct so native fixture roots cannot mask the bug.
          expect(fs.realpathSync(alias)).not.toBe(alias);
          expect(fs.realpathSync(alias)).not.toBe(root);
        }
        const result = runFixtureModule(
          root,
          `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import ts from "typescript";
import { createDeclarationBoundaryHooks, resolveDeclarationInputCaptureModule } from "./scripts/lib/tsdown-declaration-boundary.mts";
import { createDeclarationStage, createDeclarationInputCapture, requestDeclarationInputs, readDeclarationInputs } from "./scripts/lib/tsdown-declaration-inputs.mts";
const cwd = ${JSON.stringify(alias)};
const canonical = fs.realpathSync.native(cwd);
const stage = createDeclarationStage(cwd);
const outDir = path.join(cwd, path.relative(canonical, fs.realpathSync.native(stage)), "dist");
requestDeclarationInputs(outDir, "alias", [path.join(cwd, "src/shared.ts")]);
const bundles = await build({
  config: false, cwd, entry: path.join(cwd, "src/shared.ts"), outDir,
  dts: true, clean: false, logLevel: "silent",
  hooks: createDeclarationBoundaryHooks({ "build:done": createDeclarationInputCapture("alias") }),
  plugins: [{ name: "fixture-checkout-alias", buildStart: { order: "post", handler() {
    for (const spelling of [cwd, fs.realpathSync(cwd), canonical]) {
      assert.match(ts.sys.readFile(path.join(spelling, "src/shared.ts")), /inferredOrigin/);
      assert.equal(ts.sys.fileExists(path.join(spelling, "src/shared.ts")), true);
      assert.equal(ts.sys.directoryExists(path.join(spelling, "src")), true);
    }
    assert.equal(ts.sys.fileExists(${JSON.stringify(ancestorInput)}), false);
    assert.equal(ts.sys.directoryExists(${JSON.stringify(path.dirname(ancestorInput))}), false);
    assert.deepEqual(ts.sys.getDirectories(${JSON.stringify(path.dirname(ancestorInput))}), []);
  } } }],
});
try {
  const declaration = fs.readFileSync(path.join(outDir, "shared.d.mts"), "utf8");
  assert.match(declaration, /inferredOrigin: "local"/);
  assert.match(declaration, /directoryName\\(\\): "declared-cwd"/);
  const inputs = readDeclarationInputs(outDir, "alias");
  assert.ok(inputs.includes(${JSON.stringify(localInput)}));
  const { globalContext } = await import(pathToFileURL(resolveDeclarationInputCaptureModule()).href);
  const consumed = [...new Set(globalContext.programs.flatMap(program => program.getSourceFiles()
    .map(source => path.relative(canonical, fs.realpathSync.native(source.fileName)).split(path.sep).join("/"))))].sort();
  assert.deepEqual(inputs, consumed, "receipt must retain every actual Program input");
} finally {
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
  fs.rmSync(stage, { recursive: true, force: true });
}
`,
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        if (!kind.includes("Windows")) {
          return;
        }
        const dist = path.join(root, "dist");
        fs.mkdirSync(dist, { recursive: true });
        // An installed alias exposes live output to topology scanning. Its physical
        // owner must still be excluded when the writer starts through a short cwd.
        fs.symlinkSync(dist, path.join(root, "node_modules/fixture-published"), "junction");
        const cold = runWriter(alias);
        expect(cold.status, cold.stdout + cold.stderr).toBe(0);
        expect(declarationCacheRecords(root).flatMap((record) => record.inputs ?? [])).toContain(
          localInput,
        );
        const published = treeHashes(dist);
        const cache = path.join(root, ".artifacts/build-all-cache");
        const cached = treeHashes(cache);
        const warm = runWriter(alias);
        expect(warm.status, warm.stdout + warm.stderr).toBe(0);
        expect(warm.stdout + warm.stderr).not.toContain("[tsdown-build] invocation");
        expect(treeHashes(dist)).toEqual(published);
        expect(treeHashes(cache)).toEqual(cached);
        expectStagingClean(root);
      },
    );
  }

  it("preserves object and registration hooks while enforcing the declaration boundary", () => {
    const { root } = nestedFixture();
    const result = runFixtureModule(
      root,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "tsdown";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
for (const registration of [false, true]) {
  const calls = [];
  const existing = {
    "build:prepare": async () => { await Promise.resolve(); calls.push("prepare"); },
    "build:done": () => { calls.push("done"); },
  };
  const hooks = createDeclarationBoundaryHooks(registration
    ? async hooks => { hooks.addHooks(existing); }
    : existing);
  const outDir = ".artifacts/hook-composition-" + registration;
  const bundles = await build({ config: false, entry: "src/shared.ts", dts: { newContext: true }, outDir, clean: false, logLevel: "silent", hooks });
  try {
    assert.deepEqual(calls, ["prepare", "done"]);
    assert.match(fs.readFileSync(outDir + "/shared.d.mts", "utf8"), /inferredOrigin: "local"/);
  } finally {
    for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
  }
}
`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each(
    ["node", "workspace", "AI"].flatMap((owner) => [true, false].map((dts) => ({ owner, dts }))),
  )("honors resolved dts=$dts over the opposite $owner default", ({ owner, dts }) => {
    const { root, write } = nestedFixture();
    write("tsdown.ai.config.ts", fs.readFileSync("tsdown.ai.config.ts", "utf8"));
    const outside = path.join(path.dirname(root), "runtime.ts");
    fs.writeFileSync(outside, 'export const runtimeValue = "outside-runtime";');
    const result = runFixtureModule(
      root,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { resolveDeclarationInputCaptureModule } from "./scripts/lib/tsdown-declaration-boundary.mts";
const ts = createRequire(resolveDeclarationInputCaptureModule())("typescript");
const root = process.cwd();
const canonicalRoot = fs.realpathSync.native(root);
const original = { ...ts.sys };
process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = ${JSON.stringify(dts ? "1" : "0")};
const { default: configs } = await import("./tsdown.config.ts");
const { default: ai } = await import("./tsdown.ai.config.ts");
const owner = ${JSON.stringify(owner)};
const config = owner === "AI" ? ai : configs.find(config => config.outDir ===
  (owner === "node" ? "packages/agent-core/dist" : "packages/gateway-protocol/dist"));
assert.ok(config);
assert.equal(config.dts, ${!dts});
for (const key of Object.keys(original)) assert.equal(ts.sys[key], original[key], "config import mutated " + key);
// The build API's cwd, rather than the importing process's cwd, owns inputs.
process.chdir(path.dirname(root));
let finishedRuntime;
const runtimeDone = new Promise(resolve => { finishedRuntime = resolve; });
const bundles = await build({
  ...config, config: false, cwd: root, clean: false, logLevel: "silent",
  dts: ${dts ? '{ enabled: true, entry: ["src/shared.ts"], cjsReexport: false, newContext: true }' : owner === "AI" ? "{ enabled: false }" : "false"}, format: ["esm", "cjs"], concurrency: 1,
  entry: ${JSON.stringify(dts ? "src/shared.ts" : outside)},
  outDir: "override-output", outExtensions: undefined, fixedExtension: true,
  inputOptions: async (input, format, context) => {
    const resolved = await config.inputOptions?.(input, format, context) ?? input;
    return { ...resolved, plugins: [resolved.plugins, {
      name: "fixture-independent-cjs",
      buildStart: { order: context.cjsDts ? "post" : "pre", async handler() {
        if (${dts} && !context.cjsDts) {
          assert.equal(ts.sys.getCurrentDirectory(), canonicalRoot, "callback plugin started before boundary acquisition");
        }
        // CJS declarations must remain bounded after the runtime sibling finishes.
        if (context.cjsDts) await runtimeDone;
      } },
      buildEnd: { order: "post", handler() {
        if (format === "cjs" && !context.cjsDts) finishedRuntime();
      } },
    }] };
  },
});
try {
  const files = fs.readdirSync(path.join(root, "override-output"));
  if (${dts}) {
    for (const extension of ["mts", "cts"]) {
      const declaration = fs.readFileSync(path.join(root, "override-output/shared.d." + extension), "utf8");
      assert.match(declaration, /inferredOrigin: "local"/, extension + " used ancestor declarations");
      assert.match(declaration, /directoryName\\(\\): "declared-cwd"/, extension + " lost automatic types from declared cwd");
    }
  } else {
    assert.equal(files.some(file => /\\.d\\.[cm]?ts$/.test(file)), false);
    for (const extension of ["mjs", "cjs"]) {
      assert.match(fs.readFileSync(path.join(root, "override-output/runtime." + extension), "utf8"), /outside-runtime/);
    }
  }
  if (${dts && owner === "AI"}) {
    let starts = 0;
    const objectOptions = await build({
      ...config, config: false, cwd: root, clean: false, logLevel: "silent",
      dts: { cwd: path.join(root, "src"), entry: ["shared.ts"] }, format: "cjs", entry: "src/shared.ts", outDir: "object-options-output",
      inputOptions: { plugins: [{ name: "fixture-object-options", buildStart() { starts++; } }] },
    });
    try {
      assert.equal(starts, 2, "object inputOptions plugin must run for runtime and declarations");
      assert.match(fs.readFileSync(path.join(root, "object-options-output/shared.d.cts"), "utf8"), /inferredOrigin: "local"/);
      assert.match(fs.readFileSync(path.join(root, "object-options-output/shared.d.cts"), "utf8"), /directoryName\\(\\): "declared-cwd"/);
    } finally {
      for (const bundle of objectOptions) await bundle[Symbol.asyncDispose]();
    }
  }
  for (const key of Object.keys(original)) assert.equal(ts.sys[key], original[key], "build retained " + key);
} finally {
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
}
console.log("resolved declaration override honored");
`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("resolved declaration override honored");
  });

  it("restores the compiler system after overlapping workspace and AI builds, including failures", () => {
    const { root, write, ancestorInput } = nestedFixture();
    write("tsdown.ai.config.ts", fs.readFileSync("tsdown.ai.config.ts", "utf8"));
    write(
      "src/second.ts",
      'import "synthetic-wrapper"; export const secondOrigin = declarationOrigin;',
    );
    const result = runFixtureModule(
      root,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import ts from "typescript";
const root = process.cwd();
const canonicalRoot = fs.realpathSync.native(root);
const methods = ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"];
const delegated = new Set();
for (const name of methods) {
  const saved = ts.sys[name];
  ts.sys[name] = function (...args) {
    assert.equal(this, ts.sys, name + " lost the original System receiver");
    delegated.add(name);
    return saved.apply(this, args);
  };
}
const original = { ...ts.sys };
const { default: configs } = await import("./tsdown.config.ts");
const { default: ai } = await import("./tsdown.ai.config.ts");
for (const key of Object.keys(original)) assert.equal(ts.sys[key], original[key], "config import mutated " + key);
const workspace = configs.find(config => config.outDir === "packages/gateway-protocol/dist");
assert.ok(workspace);
process.chdir(path.dirname(root));
for (const failure of [false, true]) {
  delegated.clear();
  const unrelatedWrite = (...args) => original.write.apply(ts.sys, args);
  let started = 0;
  let finishedFirst;
  const firstDone = new Promise(resolve => { finishedFirst = resolve; });
  let bothStarted;
  const barrier = new Promise(resolve => { bothStarted = resolve; });
  const launch = (config, index) => build({
    ...config, config: false, cwd: root, clean: false, logLevel: "silent",
    entry: index ? "src/second.ts" : "src/shared.ts",
    outDir: ".artifacts/lifecycle-" + index,
    plugins: [config.plugins, {
      name: "fixture-lifecycle",
      buildStart: { order: "post", async handler() {
        assert.notEqual(ts.sys.readFile, original.readFile);
        ts.sys.write = unrelatedWrite;
        assert.equal(ts.sys.getCurrentDirectory(), canonicalRoot);
        assert.equal(process.cwd(), path.dirname(root), "boundary changed process cwd");
        assert.match(ts.sys.readFile("src/shared.ts"), /inferredOrigin/);
        assert.equal(ts.sys.fileExists("tsconfig.json"), true);
        assert.equal(ts.sys.directoryExists("src"), true);
        assert.ok(ts.sys.getDirectories(".").includes("src"));
        assert.ok(ts.sys.readDirectory(".", [".ts"], ["node_modules"], ["src/*"]).map(file => fs.realpathSync.native(file)).includes(path.join(canonicalRoot, "src/shared.ts")));
        assert.equal(ts.sys.realpath("."), canonicalRoot);
        assert.equal(ts.sys.fileExists(${JSON.stringify(ancestorInput)}), false);
        assert.equal(ts.sys.directoryExists(process.cwd()), false);
        assert.deepEqual(ts.sys.getDirectories(process.cwd()), []);
        assert.deepEqual(ts.sys.readDirectory(process.cwd()), []);
        if (++started === 2) bothStarted();
        await barrier;
        if (index) {
          await firstDone;
          assert.notEqual(ts.sys.readFile, original.readFile, "first sibling restored a live compiler");
          assert.equal(ts.sys.getCurrentDirectory(), canonicalRoot, "first sibling restored a live compiler cwd");
          if (failure) throw new Error("fixture buildStart failure");
        }
      } },
    }],
  });
  const results = await Promise.allSettled([
    launch(workspace, 0).finally(() => finishedFirst()),
    launch(ai, 1),
  ]);
  assert.equal(results[0].status, "fulfilled", results[0].reason?.stack);
  assert.equal(results[1].status, failure ? "rejected" : "fulfilled", results[1].reason?.stack);
  for (const name of methods) assert.ok(delegated.has(name), name + " was not delegated");
  assert.equal(ts.sys.write, unrelatedWrite, "restoration overwrote another hook's method");
  ts.sys.write = original.write;
  for (const key of Object.keys(original)) assert.equal(ts.sys[key], original[key], "build retained " + key);
  assert.equal(ts.sys.getCurrentDirectory(), process.cwd());
  if (!failure) {
    assert.match(fs.readFileSync(path.join(root, ".artifacts/lifecycle-1/second.d.mts"), "utf8"), /secondOrigin: "local"/);
  }
}
console.log("workspace/AI lifecycle restored after success and failure");
`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("workspace/AI lifecycle restored after success and failure");
  });

  it.each([
    {
      name: "SDK",
      groups: TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
      run: (root: string, env = {}) => runWriter(root, false, env),
    },
    { name: "unified", groups: TSDOWN_NON_SDK_DTS_CONFIG_GROUPS, run: runUnifiedWriter },
  ])("uses local explicit references and seals real inputs for $name", ({ groups, run }) => {
    const { root, write, ancestorInput, localInput } = nestedFixture(groups);
    write(
      "tsdown.config.ts",
      `${fs.readFileSync(path.join(root, "tsdown.config.ts"), "utf8")}
for (const config of configs) {
  if (!config.dts?.emitDtsOnly) continue;
  const register = config.hooks;
  config.hooks = async hooks => {
    await register(hooks);
    hooks.hook("build:done", () => {
      const marker = ".artifacts/replace-input";
      if (!fs.existsSync(marker)) return;
      const file = fs.readFileSync(marker, "utf8") === "ancestor" ? ${JSON.stringify(ancestorInput)} : ${JSON.stringify(localInput)};
      fs.writeFileSync(file + ".replacement", fs.readFileSync(file));
      fs.renameSync(file + ".replacement", file);
    });
  };
}
`,
    );
    const initial = run(root);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    const published = treeHashes(path.join(root, "dist"));
    const declarations = Object.keys(published)
      .filter((file) => file.endsWith(".d.ts"))
      .map((file) => fs.readFileSync(path.join(root, "dist", file), "utf8"))
      .join("\n");
    expect(declarations.match(/declare const inferredOrigin: [^;]+;/u)?.[0]).toBe(
      'declare const inferredOrigin: "local";',
    );
    const inputs = declarationCacheRecords(root).flatMap((record) => record.inputs ?? []);
    expect(inputs).toContain(localInput);
    for (const input of inputs) {
      const relative = path.relative(root, fs.realpathSync(path.resolve(root, input)));
      expect(
        relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        input,
      ).toBe(false);
    }
    expectStagingClean(root);
    // Both writers seal through the same owner. Replay its mutation cycle once;
    // the unified suite separately covers failed and mixed-cache publication.
    if (groups === TSDOWN_NON_SDK_DTS_CONFIG_GROUPS) {
      return;
    }
    const cached = treeHashes(path.join(root, ".artifacts/build-all-cache"));
    write(".artifacts/replace-input", "ancestor");
    const ancestorChanged = run(root, { OPENCLAW_BUILD_CACHE: "0" });
    expect(ancestorChanged.status, ancestorChanged.stdout + ancestorChanged.stderr).toBe(0);
    expect(treeHashes(path.join(root, "dist"))).toEqual(published);
    const restored = run(root);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(restored.stdout + restored.stderr).not.toContain("[tsdown-build] invocation");
    write(".artifacts/replace-input", "local");
    const localChanged = run(root, { OPENCLAW_BUILD_CACHE: "0" });
    expect(localChanged.status, localChanged.stdout + localChanged.stderr).toBeGreaterThan(0);
    expect(localChanged.stdout + localChanged.stderr).toContain("changed during compilation");
    expect(treeHashes(path.join(root, "dist"))).toEqual(published);
    expect(treeHashes(path.join(root, ".artifacts/build-all-cache"))).toEqual(cached);
    expectStagingClean(root);
  });

  it.each([
    "ancestor module",
    "package symlink",
    "source symlink",
    "source reference",
    "ancestor symlink reference",
  ])("refuses an escaped %s before publication", (kind) => {
    const { root, write, ancestorInput } = nestedFixture();
    const outside = `${root}-outside`;
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "index.d.ts"), "export interface Marker { escaped: true }");
    if (kind === "ancestor module") {
      write("src/shared.ts", 'export type { Marker as Shared } from "synthetic-core";');
    } else if (kind === "package symlink") {
      fs.writeFileSync(
        path.join(outside, "package.json"),
        '{"name":"escaped","types":"index.d.ts"}',
      );
      fs.symlinkSync(outside, path.join(root, "node_modules/escaped"), "junction");
      write("src/shared.ts", 'export type { Marker as Shared } from "escaped";');
    } else if (kind === "source symlink") {
      fs.symlinkSync(path.join(outside, "index.d.ts"), path.join(root, "src/escaped.d.ts"));
      write("src/shared.ts", 'export type { Marker as Shared } from "./escaped.js";');
    } else {
      if (kind === "ancestor symlink reference") {
        fs.rmSync(path.join(outside, "index.d.ts"));
        fs.symlinkSync(path.join(root, "src/contract.d.ts"), path.join(outside, "index.d.ts"));
      }
      write(
        "src/shared.ts",
        `/// <reference path="${path.join(outside, "index.d.ts").replaceAll(path.sep, "/")}" />\nexport class Shared {}\n`,
      );
      write(
        "tsdown.config.ts",
        `${fs.readFileSync(path.join(root, "tsdown.config.ts"), "utf8")}
for (const config of configs) {
  if (!config.dts?.emitDtsOnly) continue;
  config.plugins = [config.plugins, {
    name: "fixture-read-error",
    buildEnd(error) {
      if (!error) console.log("fixture: compiler reached buildEnd without a bundler error");
    },
  }];
}
`,
      );
    }
    fs.appendFileSync(
      path.join(root, "src/shared.ts"),
      '\nexport const inferredOrigin = "unused";\n',
    );
    write("dist/plugin-sdk/core.d.ts", "previous declaration");
    const before = treeHashes(path.join(root, "dist"));
    const failed = runWriter(root);
    expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
    expect(failed.stdout + failed.stderr).toContain("Declaration input escapes checkout");
    if (kind.endsWith("reference")) {
      expect(failed.stdout + failed.stderr).toContain(
        "fixture: compiler reached buildEnd without a bundler error",
      );
    }
    expect(failed.stdout + failed.stderr).toContain(
      kind === "ancestor module" ? ancestorInput : outside,
    );
    expect(treeHashes(path.join(root, "dist"))).toEqual(before);
    expectStagingClean(root);
  });
});
