import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { portableRelativePath } from "../../scripts/lib/build-artifact-cache.mts";
import { BoundaryInputSnapshot } from "../../scripts/lib/extension-boundary-inputs.mts";
import { createDeclarationInputBoundary } from "../../scripts/lib/tsdown-declaration-boundary.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  installNativeAncestorTypes,
  materializeNativeCompiler,
  resolveNativeFixtureShortPath,
  writeNativeFixtureFile,
} from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it.each([true, false])(
  "diagnoses declaration escapes with an ancestor install=%s",
  (ancestorInstall) => {
    const ancestor = fs.realpathSync.native(roots.make("declaration-escape-diagnosis-"));
    const root = path.join(ancestor, ".claude/worktrees/validation");
    fs.mkdirSync(root, { recursive: true });
    const install = path.join(ancestor, ancestorInstall ? "node_modules" : "other/node_modules");
    const file = path.join(install, "synthetic-package/package.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    const boundary = createDeclarationInputBoundary(root);
    expect(() => boundary.assert(file)).toThrow(`Declaration input escapes checkout: ${file}`);
    if (ancestorInstall) {
      expect(() => boundary.assert(file)).toThrow(`another install at ${install}`);
      expect(() => boundary.assert(file)).toThrow("separate physical checkout");
      expect(() => boundary.assert(file)).toThrow("Repeating pnpm install will not isolate");
    } else {
      expect(() => boundary.assert(file)).toThrow(
        "shared installs and external symlinks are unsupported",
      );
      expect(() => boundary.assert(file)).toThrow(
        "does not establish a missing or undeclared dependency",
      );
    }
  },
);

function createNativeFixture(root: string, declared = root) {
  fs.mkdirSync(root, { recursive: true });
  const native = materializeNativeCompiler(declared);
  const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        types: [],
        skipLibCheck: true,
        rootDir: "src",
        declaration: true,
        incremental: true,
      },
      files: ["src/index.ts"],
    }),
  );
  write(
    "src/index.ts",
    'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\n',
  );
  const compile = (noEmit = false, extraArgs: string[] = []) => {
    const config = path.join(declared, "tsconfig.json");
    const buildInfo = "dist/.tsbuildinfo";
    const outputRoot = noEmit ? undefined : path.join(root, "dist");
    const args = [
      "-p",
      config,
      noEmit ? "--noEmit" : "--emitDeclarationOnly",
      "--outDir",
      path.join(declared, "dist"),
      "--tsBuildInfoFile",
      path.join(declared, buildInfo),
      "--listEmittedFiles",
      ...extraArgs,
    ];
    const before = new BoundaryInputSnapshot(declared);
    before.signature(config, args, [], outputRoot);
    fs.rmSync(path.join(root, buildInfo), { force: true });
    const startedAt = Date.now();
    const compiled = spawnSync(native, args, {
      cwd: declared,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const outputs = compiled.stdout
      .split("\n")
      .filter((line) => line.startsWith("TSFILE: "))
      .map((line) => portableRelativePath(root, fs.realpathSync.native(line.slice(8).trim())));
    const info: { fileNames: string[]; fileInfos: unknown[]; packageJsons?: string[] } = JSON.parse(
      fs.readFileSync(path.join(root, buildInfo), "utf8"),
    );
    const record = () =>
      new BoundaryInputSnapshot(declared).record(
        config,
        args,
        buildInfo,
        outputs,
        before,
        startedAt,
        outputRoot,
      );
    return { config, args, buildInfo, outputs, info, outputRoot, record, trace: compiled.stdout };
  };
  return { native, write, compile };
}

it.each([false, true])(
  "rejects successful native ancestor membership before acceptance (noEmit=%s)",
  (noEmit) => {
    const ancestor = fs.realpathSync.native(roots.make("native-declaration-ancestor-"));
    const root = path.join(ancestor, ".claude/worktrees/validation");
    const f = createNativeFixture(root);
    installNativeAncestorTypes(ancestor, root);
    const run = f.compile(noEmit);
    expect(
      run.info.fileNames.some((name) =>
        name.includes("../../../node_modules/@types/synthetic-core"),
      ),
    ).toBe(true);
    if (!noEmit) {
      expect(fs.readFileSync(path.join(root, "dist/index.d.ts"), "utf8")).toContain(
        'inferredOrigin: "ancestor"',
      );
    }
    // The successful native receipt is evidence of contamination, never an accepted generation.
    expect(run.record).toThrow(/Declaration input escapes checkout/);
  },
);

it("diagnoses manifest-only ancestor probes and seals the same local inputs in a standalone checkout", () => {
  const ancestor = fs.realpathSync.native(roots.make("native-manifest-probe-"));
  const nested = path.join(ancestor, ".claude/worktrees/validation");
  const standalone = fs.realpathSync.native(roots.make("native-manifest-isolated-"));
  const manifest = JSON.stringify({ name: "synthetic-js", version: "1.0.0", main: "index.js" });
  writeNativeFixtureFile(ancestor, "node_modules/synthetic-js/package.json", manifest);
  writeNativeFixtureFile(
    ancestor,
    "node_modules/synthetic-js/index.js",
    "exports.origin = 'ancestor';\n",
  );
  for (const root of [nested, standalone]) {
    const f = createNativeFixture(root);
    f.write("src/index.ts", 'export type { Value } from "synthetic-wrapper";\n');
    f.write("node_modules/synthetic-wrapper/package.json", '{"types":"index.d.ts"}');
    f.write(
      "node_modules/synthetic-wrapper/index.d.ts",
      'export type Value = typeof import("synthetic-js");\n',
    );
    f.write("node_modules/synthetic-js/package.json", manifest);
    f.write("node_modules/synthetic-js/index.js", "exports.origin = 'local';\n");
    const run = f.compile(false, ["--traceResolution"]);
    const directory = path.join(root, "dist");
    const sourceFiles = run.info.fileNames.slice(0, run.info.fileInfos.length);
    const externalManifest = path.join(ancestor, "node_modules/synthetic-js/package.json");
    expect(
      sourceFiles.some((file) =>
        path.relative(root, path.resolve(directory, file)).startsWith(`..${path.sep}`),
      ),
    ).toBe(false);
    expect(run.trace.replaceAll("\\", "/")).toContain(
      `'synthetic-js' was successfully resolved to '${root.replaceAll("\\", "/")}/node_modules/synthetic-js/index.js'`,
    );
    if (root === nested) {
      // Declaration lookup visits outer manifests before falling back to local JavaScript.
      expect(run.info.packageJsons?.map((file) => path.resolve(directory, file))).toContain(
        externalManifest,
      );
      expect(run.record).toThrow("complete local install");
      expect(run.record).toThrow("Repeating pnpm install will not isolate");
      continue;
    }
    const record = run.record();
    expect(record.inputs).toContain("node_modules/synthetic-js/package.json");
    expect(record.inputs?.some((file) => file.startsWith("../"))).toBe(false);
    const warm = new BoundaryInputSnapshot(root);
    expect(warm.matches(record, run.config, run.args, run.outputs, run.outputRoot)).toBe(true);
    f.write("node_modules/synthetic-js/package.json", `${manifest}\n`);
    expect(
      new BoundaryInputSnapshot(root).matches(
        record,
        run.config,
        run.args,
        run.outputs,
        run.outputRoot,
      ),
    ).toBe(false);
  }
});

for (const kind of [
  "directory alias",
  "Windows 8.3 alias",
  "directory alias targeting Windows 8.3",
  "Windows namespaced executable",
]) {
  it.skipIf(kind.includes("Windows") && process.platform !== "win32")(
    `emits, records every native input, and stays warm through a ${kind}`,
    (context) => {
      const ancestor = fs.realpathSync.native(roots.make("native-declaration-alias-"));
      const longExecutable = kind === "Windows namespaced executable";
      const directory = longExecutable ? "LongNativeCheckout".repeat(10) : "validation";
      const root = path.join(ancestor, ".claude/worktrees", directory);
      fs.mkdirSync(root, { recursive: true });
      let target = root;
      if (kind.includes("8.3")) {
        const short = resolveNativeFixtureShortPath(root);
        if (!short) {
          context.skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
          return;
        }
        target = short;
      }
      let declared = target;
      if (kind.startsWith("directory alias") || longExecutable) {
        declared = path.join(path.dirname(root), "declared-alias");
        fs.symlinkSync(target, declared, "junction");
      }
      if (kind === "directory alias targeting Windows 8.3") {
        expect(fs.realpathSync(declared)).not.toBe(declared);
        expect(fs.realpathSync(declared)).not.toBe(root);
      }
      const f = createNativeFixture(root, declared);
      if (longExecutable) {
        // Exercise the actual installed getExePath contract, not a synthetic path adapter.
        expect(f.native.startsWith("\\\\?\\")).toBe(true);
        expect(f.native.slice(4).length).toBeGreaterThanOrEqual(248);
      }
      installNativeAncestorTypes(ancestor, root);
      fs.rmSync(path.join(ancestor, "node_modules"), { recursive: true });
      const run = f.compile();
      expect(fs.readFileSync(path.join(root, "dist/index.d.ts"), "utf8")).toContain(
        'inferredOrigin: "local"',
      );
      const record = run.record();
      const receiptDirectory = path.dirname(path.join(declared, run.buildInfo));
      // Native's receipt lists source membership, compact bundled libraries, and
      // package manifests. Admission must retain the entire successful inventory.
      const sourceInputs = run.info.fileNames
        .slice(0, run.info.fileInfos.length)
        .map((file) =>
          path.resolve(
            file.startsWith("lib.") && !file.includes("/")
              ? path.dirname(f.native)
              : receiptDirectory,
            file,
          ),
        );
      const packageInputs = (run.info.packageJsons ?? []).map((file) =>
        path.resolve(receiptDirectory, file),
      );
      const nativeInputs = [...sourceInputs, ...packageInputs].map((file) =>
        portableRelativePath(root, fileURLToPath(pathToFileURL(fs.realpathSync.native(file)))),
      );
      expect(record.inputs).toEqual([...new Set(nativeInputs)].toSorted());
      expect(record.inputs).toContain("src/index.ts");
      expect(record.inputs).toContain(
        "node_modules/.pnpm/core/node_modules/@types/synthetic-core/index.d.ts",
      );
      expect(record.inputs?.some((file) => file.endsWith("/lib.es2023.d.ts"))).toBe(true);
      const warm = new BoundaryInputSnapshot(declared);
      expect(warm.matches(record, run.config, run.args, run.outputs, run.outputRoot)).toBe(true);
      const sourceHash = warm.hash(path.join(root, "src/index.ts"));
      for (const spelling of [declared, fs.realpathSync(declared), root]) {
        expect(warm.hash(path.join(spelling, "src/index.ts")), spelling).toBe(sourceHash);
      }
    },
  );
}

it("rejects a real native reference through an unrelated outside symlink back inside", () => {
  const ancestor = fs.realpathSync.native(roots.make("native-declaration-symlink-back-"));
  const root = path.join(ancestor, ".claude/worktrees/validation");
  const f = createNativeFixture(root);
  const outside = path.join(ancestor, "outside-reference");
  fs.symlinkSync(path.join(root, "src"), outside, "junction");
  f.write("src/referenced.d.ts", 'interface FixtureContract { origin: "local" }\n');
  const reference = path.join(outside, "referenced.d.ts");
  f.write(
    "src/index.ts",
    `/// <reference path="${reference.replaceAll(path.sep, "/")}" />\nexport type Marker = FixtureContract;\n`,
  );
  const run = f.compile();
  expect(fs.realpathSync.native(reference)).toBe(path.join(root, "src/referenced.d.ts"));
  expect(
    run.info.fileNames.some(
      (file) => path.relative(reference, path.resolve(root, "dist", file)) === "",
    ),
  ).toBe(true);
  expect(run.record).toThrow(/Declaration input escapes checkout/);
});
