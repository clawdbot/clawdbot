import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireBuildArtifactLock,
  portableRelativePath,
  readArtifactRecord,
  writeArtifactRecord,
} from "../../scripts/lib/build-artifact-cache.mts";
import { BoundaryInputSnapshot } from "../../scripts/lib/extension-boundary-inputs.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);
const native: string = require(
  path.join(
    path.dirname(require.resolve("@typescript/native-preview/package.json")),
    "lib/getExePath.js",
  ),
).default();
function fixture(noEmit = false, outputRoot = "dist") {
  const root = fs.realpathSync(roots.make("native-boundary-cache-"));
  const write = (file: string, bytes: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.utimesSync(target, new Date(1000), new Date(1000));
  };
  write(
    "base.json",
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "nodenext",
        allowJs: true,
        declaration: true,
        incremental: true,
        outDir: outputRoot,
        rootDir: ".",
        skipLibCheck: true,
      },
    }),
  );
  write(
    "tsconfig.json",
    JSON.stringify({ extends: "./base.json", include: ["src/*.ts"], exclude: ["**/*.test.ts"] }),
  );
  write("package.json", '{"type":"module"}');
  write("pnpm-lock.yaml", "lock");
  write("src/api.ts", 'export { value } from "../nested/value.js";');
  write("nested/value.js", "export const value = 1;");
  write("unrelated/source.ts", "export const unrelated = 1;");
  write("src/api.test.ts", "export const test = 1;");
  const config = "tsconfig.json";
  const buildInfo = `${outputRoot}/.tsbuildinfo`;
  const args = [
    "-p",
    path.join(root, config),
    noEmit ? "--noEmit" : "--emitDeclarationOnly",
    "--tsBuildInfoFile",
    path.join(root, buildInfo),
    "--listEmittedFiles",
  ];
  const ownedOutputRoot = noEmit ? undefined : path.join(root, outputRoot);
  const prepare = () => {
    fs.mkdirSync(path.join(root, outputRoot), { recursive: true });
    const before = new BoundaryInputSnapshot(root);
    before.signature(config, args, [], ownedOutputRoot);
    fs.rmSync(path.join(root, buildInfo), { force: true });
    const startedAt = Date.now();
    const result = spawnSync(native, args, { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const files = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("TSFILE: "))
      .map((line) => portableRelativePath(root, line.slice(8).trim()))
      .toSorted();
    return { before, startedAt, files };
  };
  const seal = (run: ReturnType<typeof prepare>) =>
    new BoundaryInputSnapshot(root).record(
      config,
      args,
      buildInfo,
      run.files,
      run.before,
      run.startedAt,
      ownedOutputRoot,
    );
  return { root, write, config, args, prepare, seal, outputRoot: ownedOutputRoot };
}

describe("native owner content records", () => {
  it("traverses deep namespace candidates without resolving ordinary ancestors again", () => {
    const f = fixture(true);
    const depth = 32;
    const nested = `namespace/${"nested/".repeat(depth)}`;
    f.write(`${nested}candidate.ts`, "export {};");
    const originalRealpath = fs.realpathSync;
    let resolutions = 0;
    fs.realpathSync = new Proxy(originalRealpath, {
      apply(target, receiver, args) {
        resolutions += 1;
        return Reflect.apply(target, receiver, args);
      },
    });
    let first: string;
    try {
      const snapshot = new BoundaryInputSnapshot(f.root);
      first = snapshot.signature(f.config, f.args, []);
      expect(snapshot.signature(f.config, f.args, [])).toBe(first);
    } finally {
      fs.realpathSync = originalRealpath;
    }
    expect(resolutions).toBeLessThan(depth);
    f.write(`${nested}added.ts`, "export {};");
    expect(new BoundaryInputSnapshot(f.root).signature(f.config, f.args, [])).not.toBe(first);
  });

  it("seals a cold producer reached through its own workspace package alias", () => {
    const f = fixture(false, "packages/sdk/dist");
    f.write("packages/sdk/package.json", '{"name":"fixture-sdk","type":"module"}');
    fs.mkdirSync(path.join(f.root, "node_modules"));
    fs.symlinkSync("../packages/sdk", path.join(f.root, "node_modules/fixture-sdk"), "dir");
    fs.symlinkSync(".", path.join(f.root, "packages/sdk/self"), "dir");

    const record = f.seal(f.prepare());
    expect(record.outputs["packages/sdk/dist/src/api.d.ts"]).toBeDefined();
    expect(
      new BoundaryInputSnapshot(f.root).matches(
        record,
        f.config,
        f.args,
        Object.keys(record.outputs),
        f.outputRoot,
      ),
    ).toBe(true);
    fs.unlinkSync(path.join(f.root, "node_modules/fixture-sdk"));
    expect(
      new BoundaryInputSnapshot(f.root).matches(
        record,
        f.config,
        f.args,
        Object.keys(record.outputs),
        f.outputRoot,
      ),
    ).toBe(false);
  });

  it("retains upstream output topology when a producer snapshot is reused by a consumer", () => {
    const f = fixture(false, "packages/sdk/dist");
    f.write("packages/sdk/package.json", '{"name":"fixture-sdk","type":"module"}');
    f.write("consumer.json", '{"extends":"./base.json","files":["consumer.ts"]}');
    f.write(
      "consumer.ts",
      'import { value } from "fixture-sdk/dist/nested/value.js"; const expected: 1 = value;',
    );
    fs.mkdirSync(path.join(f.root, "node_modules"));
    fs.symlinkSync("../packages/sdk", path.join(f.root, "node_modules/fixture-sdk"), "dir");
    const producer = f.prepare();
    const shared = new BoundaryInputSnapshot(f.root);
    shared.record(
      f.config,
      f.args,
      "packages/sdk/dist/.tsbuildinfo",
      producer.files,
      producer.before,
      producer.startedAt,
      f.outputRoot,
    );
    const config = "consumer.json";
    const metadata = ".artifacts/consumer.tsbuildinfo";
    const args = [
      "-p",
      path.join(f.root, config),
      "--noEmit",
      "--incremental",
      "--tsBuildInfoFile",
      path.join(f.root, metadata),
    ];
    shared.signature(config, args, []);
    const startedAt = Date.now();
    const compiled = spawnSync(native, args, { encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const record = new BoundaryInputSnapshot(f.root).record(
      config,
      args,
      metadata,
      [metadata],
      shared,
      startedAt,
    );
    const matches = () =>
      new BoundaryInputSnapshot(f.root).matches(record, config, args, [metadata]);
    expect(matches()).toBe(true);
    f.write("packages/sdk/dist/nested/value.ts", 'export const value = "changed";');
    expect(matches()).toBe(false);
    const changed = spawnSync(native, args, { encoding: "utf8" });
    expect(changed.status, changed.stdout + changed.stderr).toBe(1);
    expect(changed.stdout).toContain("TS2322");
  });

  it.each(["node_modules", "package", "source"])(
    "invalidates new resolution candidates behind linked %s directories",
    (layout) => {
      const f = fixture(true);
      const dependency = fs.realpathSync(roots.make("linked-boundary-dependency-"));
      const packageRoot = path.join(dependency, "fixture-package");
      const moduleRoot = layout === "source" ? packageRoot : path.join(packageRoot, "dist");
      fs.mkdirSync(moduleRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}');
      fs.writeFileSync(path.join(moduleRoot, "value.d.ts"), "export declare const value: 1;");
      fs.writeFileSync(path.join(packageRoot, "unrelated.ts"), "export const unrelated = 1;");
      const link = path.join(
        f.root,
        layout === "package"
          ? "node_modules/fixture-package"
          : layout === "source"
            ? "linked"
            : layout,
      );
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(layout === "node_modules" ? dependency : packageRoot, link, "dir");
      // Repeated aliases and a back-edge must not expand the same subtree indefinitely.
      fs.symlinkSync(packageRoot, path.join(packageRoot, "self"), "dir");
      fs.symlinkSync(f.root, path.join(packageRoot, "consumer"), "dir");
      fs.symlinkSync(packageRoot, path.join(f.root, "alias"), "dir");
      const specifier =
        layout === "source" ? "../linked/value.js" : "fixture-package/dist/value.js";
      f.write("src/api.ts", `import { value } from "${specifier}"; const expected: 1 = value;`);
      const record = f.seal(f.prepare());
      expect(record.inputs?.some((file) => file.endsWith("/value.d.ts"))).toBe(true);
      const matches = () =>
        new BoundaryInputSnapshot(f.root).matches(
          record,
          f.config,
          f.args,
          Object.keys(record.outputs),
        );
      expect(matches()).toBe(true);
      fs.writeFileSync(path.join(packageRoot, "unrelated.ts"), "export const unrelated = 2;");
      f.write(".artifacts/ignored.ts", "export {};");
      f.write("dist/ignored.d.ts", "export {};");
      expect(matches()).toBe(true);
      fs.writeFileSync(path.join(moduleRoot, "value.ts"), 'export const value = "changed";');
      const staleHit = matches();
      const result = spawnSync(native, f.args, { encoding: "utf8" });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain("TS2322");
      expect(result.stdout).toContain("Type '\"changed\"' is not assignable to type '1'");
      expect(staleHit).toBe(false);
    },
  );

  it.each(["file", "directory"])("tracks dangling link %s existence and link identity", (kind) => {
    const f = fixture(true);
    const dependency = fs.realpathSync(roots.make("dangling-boundary-dependency-"));
    const target = path.join(dependency, "missing");
    const link = path.join(f.root, "missing");
    fs.symlinkSync(target, link, kind === "directory" ? "dir" : "file");
    const record = f.seal(f.prepare());
    const matches = () =>
      new BoundaryInputSnapshot(f.root).matches(
        record,
        f.config,
        f.args,
        Object.keys(record.outputs),
      );
    expect(matches()).toBe(true);
    if (kind === "directory") {
      fs.mkdirSync(target);
    } else {
      fs.writeFileSync(target, "");
    }
    expect(matches()).toBe(false);
    fs.rmSync(target, { recursive: true });
    expect(matches()).toBe(true);
    fs.unlinkSync(link);
    fs.symlinkSync(`${target}-other`, link, kind === "directory" ? "dir" : "file");
    expect(matches()).toBe(false);
  });

  it("ignores tool scratch churn under installed roots", () => {
    const f = fixture(true);
    fs.mkdirSync(path.join(f.root, "node_modules"));
    const run = f.prepare();
    // Sibling config loads mint these between the before and seal walks.
    f.write("node_modules/.vite-temp/vitest.config.ts.timestamp-1-a.mjs", "export default {};");
    const record = f.seal(run);
    const matches = () =>
      new BoundaryInputSnapshot(f.root).matches(
        record,
        f.config,
        f.args,
        Object.keys(record.outputs),
      );
    expect(matches()).toBe(true);
    fs.rmSync(path.join(f.root, "node_modules/.vite-temp"), { recursive: true });
    f.write("node_modules/.cache/jiti/config.deadbeef.mjs", "export default {};");
    expect(matches()).toBe(true);
    f.write("node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js", "export const value = 1;");
    expect(matches()).toBe(false);
  });

  it("propagates non-ENOENT link resolution errors", () => {
    const f = fixture(true);
    fs.symlinkSync("loop", path.join(f.root, "loop"));
    expect(() => new BoundaryInputSnapshot(f.root).signature(f.config, f.args, [])).toThrow(
      /ELOOP/u,
    );
  });

  it("keeps a consumer warm when a full upstream emit changes only build metadata", () => {
    const f = fixture();
    f.write("consumer.json", '{"extends":"./base.json","files":["consumer.ts"]}');
    f.write("consumer.ts", 'export type Value = typeof import("./dist/nested/value.js").value;');
    const producer = f.seal(f.prepare());
    const config = "consumer.json";
    const metadata = "cache/consumer.tsbuildinfo";
    const args = [
      "-p",
      path.join(f.root, config),
      "--noEmit",
      "--incremental",
      "--tsBuildInfoFile",
      path.join(f.root, metadata),
    ];
    const before = new BoundaryInputSnapshot(f.root);
    before.signature(config, args, []);
    const startedAt = Date.now();
    const result = spawnSync(native, args, { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const consumer = new BoundaryInputSnapshot(f.root).record(
      config,
      args,
      metadata,
      [metadata],
      before,
      startedAt,
    );
    f.write("nested/value.js", "export const value = 1; // implementation comment\n");
    const refreshed = f.seal(f.prepare());
    expect(refreshed.outputs["dist/.tsbuildinfo"]).not.toBe(producer.outputs["dist/.tsbuildinfo"]);
    expect(refreshed.outputs["dist/nested/value.d.ts"]).toBe(
      producer.outputs["dist/nested/value.d.ts"],
    );
    expect(new BoundaryInputSnapshot(f.root).matches(consumer, config, args, [metadata])).toBe(
      true,
    );
  });
  it.each([false, true])(
    "preserves declaration/compile locality (noEmit=%s), with native membership and complete output bytes",
    (noEmit) => {
      const f = fixture(noEmit);
      const record = f.seal(f.prepare());
      const stamp = path.join(f.root, ".artifacts/record.json");
      writeArtifactRecord(stamp, record);
      expect(record.inputs).toContain("nested/value.js");
      expect(record.inputs).not.toContain("src/api.test.ts");
      expect(record.inputs?.some((file) => file.endsWith("lib.es2023.d.ts"))).toBe(true);
      const matches = () =>
        new BoundaryInputSnapshot(f.root).matches(
          readArtifactRecord(stamp),
          f.config,
          f.args,
          Object.keys(record.outputs),
          f.outputRoot,
        );
      expect(matches()).toBe(true);
      f.write("unrelated/source.ts", "export const unrelated = 2;");
      f.write("src/api.test.ts", "export const test = 2;");
      expect(matches()).toBe(true);
      for (const file of Object.keys(record.outputs)) {
        fs.utimesSync(path.join(f.root, file), new Date(2000), new Date(2000));
      }
      expect(matches()).toBe(true);
      f.write("nested/value.js", "export const value = 'changed';");
      expect(matches()).toBe(false);
    },
  );

  it.each([
    "addition",
    "deletion",
    "rename",
    "higher-priority module",
    "local package scope",
    "config",
    "extends",
    "lockfile",
    "generator",
    "compiler policy",
    "missing output",
    "tampered output",
    "orphan output",
  ])("rejects %s against a real native record", (mutation) => {
    const f = fixture();
    f.write("scripts/run-tsgo.mts", "export {};");
    f.write("scripts/lib/local-check-runtime.mts", "export const policy = 1;");
    const record = f.seal(f.prepare());
    switch (mutation) {
      case "addition":
        f.write("src/added.ts", "export const added = 1;");
        break;
      case "deletion":
        fs.rmSync(path.join(f.root, "nested/value.js"));
        break;
      case "rename":
        fs.renameSync(path.join(f.root, "nested/value.js"), path.join(f.root, "nested/renamed.js"));
        break;
      case "higher-priority module":
        f.write("nested/value.ts", "export const value = 'new resolution';");
        break;
      case "local package scope":
        f.write("nested/package.json", '{"type":"commonjs"}');
        break;
      case "config":
        f.write(
          "tsconfig.json",
          '{"extends":"./base.json","include":["src/*.ts"],"compilerOptions":{"strict":true}}',
        );
        break;
      case "extends":
        f.write("base.json", '{"compilerOptions":{"target":"es2022"}}');
        break;
      case "lockfile":
        f.write("pnpm-lock.yaml", "changed lock");
        break;
      case "generator":
        f.write("scripts/run-tsgo.mts", "export const changed = true;");
        break;
      case "compiler policy":
        f.write("scripts/lib/local-check-runtime.mts", "export const policy = 2;");
        break;
      case "missing output":
        fs.rmSync(path.join(f.root, "dist/nested/value.d.ts"));
        break;
      case "tampered output":
        f.write("dist/nested/value.d.ts", "truncated");
        break;
      case "orphan output":
        f.write("dist/nested/orphan.d.ts", "export {};");
        break;
    }
    expect(
      new BoundaryInputSnapshot(f.root).matches(
        record,
        f.config,
        f.args,
        ["dist/src/api.d.ts"],
        "dist",
      ),
    ).toBe(false);
  });

  it.each(["nested/value.js", "package.json", "base.json", "pnpm-lock.yaml"])(
    "cannot seal %s changed after native consumed it",
    (file) => {
      const f = fixture();
      const run = f.prepare();
      const target = path.join(f.root, file);
      f.write(file, fs.readFileSync(target, "utf8") + "\n");
      expect(() => f.seal(run)).toThrow(/changed during compilation/u);
    },
  );

  it("uses full emitted inventories, never survivors after a renamed source or failed run", () => {
    const f = fixture();
    const first = f.seal(f.prepare());
    expect(first.outputs["dist/nested/value.d.ts"]).toBeDefined();
    f.write("src/api.ts", 'export { value } from "../nested/renamed.js";');
    fs.renameSync(path.join(f.root, "nested/value.js"), path.join(f.root, "nested/renamed.js"));
    const second = f.seal(f.prepare());
    // Ordinary native emit leaves the obsolete declaration on disk. The owner
    // must prune it; it cannot adopt the directory as its successful inventory.
    expect(fs.existsSync(path.join(f.root, "dist/nested/value.d.ts"))).toBe(true);
    expect(second.outputs["dist/nested/value.d.ts"]).toBeUndefined();
    expect(second.outputs["dist/nested/renamed.d.ts"]).toBeDefined();
  });

  it("rejects overlapping synchronous cache snapshots without reclaiming their live owner", () => {
    const root = fs.realpathSync(roots.make("artifact-cache-lock-"));
    const target = path.join(root, "cache/stamp.json");
    const lock = acquireBuildArtifactLock(target, 0);
    try {
      expect(() => acquireBuildArtifactLock(target, 0)).toThrow("file lock timeout");
      expect(lock.verifyStillHeld()).toBe(true);
    } finally {
      lock.release();
    }
    const successor = acquireBuildArtifactLock(target, 0);
    successor.release();
  });
});
