import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readArtifactRecord } from "../../scripts/lib/build-artifact-cache.mts";
import { BOUNDARY_PLUGIN_UNITS } from "../../scripts/lib/extension-boundary-inputs.mts";
import { runNodeStep } from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  installNativeAncestorTypes,
  materializeNativeCompiler,
  resolveNativeFixtureShortPath,
  writeNativeFixtureFile,
} from "./native-boundary-fixture.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

function createPreparationFixture(mode: "package-boundary" | "all", signal: AbortSignal) {
  const ancestor = fs.realpathSync.native(fixture.createTempDir("native-preparer-"));
  const root = path.join(ancestor, ".claude/worktrees/validation");
  fs.mkdirSync(root, { recursive: true });
  const native = materializeNativeCompiler(root);
  const write = (file: string, text: string) => {
    signal.throwIfAborted();
    return writeNativeFixtureFile(root, file, text);
  };
  write("package.json", '{"name":"openclaw","type":"module"}');
  write("pnpm-workspace.yaml", "packages: []\n");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "nodenext",
        skipLibCheck: true,
        types: [],
      },
    }),
  );
  write(
    "packages/plugin-sdk/tsconfig.json",
    JSON.stringify({ extends: "../../tsconfig.json", include: ["../../src/**/*.ts"] }),
  );
  write("src/plugin-sdk/core.ts", 'export { value } from "../nested.js";');
  write("src/nested.ts", "export const value = 1;");
  for (const file of [
    "scripts/prepare-extension-package-boundary-artifacts.mts",
    "scripts/run-tsgo.mjs",
    "scripts/run-tsgo.mts",
    "scripts/tsx.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib",
    "packages/normalization-core/src",
    "packages/normalization-core/package.json",
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.resolve(file), target, { recursive: true });
  }
  write("scripts/lib/plugin-sdk-entrypoints.json", '["core"]');
  for (const name of ["tsx", "@openclaw/fs-safe"]) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules", name), target);
  }
  write(
    "packages/plugin-sdk/package.json",
    '{"name":"fixture-sdk","type":"module","types":"./dist/src/plugin-sdk/core.d.ts"}',
  );
  fs.symlinkSync("../packages/plugin-sdk", path.join(root, "node_modules/fixture-sdk"), "dir");
  const plugins = mode === "all" ? BOUNDARY_PLUGIN_UNITS : [];
  for (const [id, entry] of plugins) {
    write(
      `extensions/${id}/tsconfig.json`,
      JSON.stringify({ extends: "../../tsconfig.json", files: [`${entry}.ts`] }),
    );
    write(
      `extensions/${id}/node_modules/boundary-private-dep/package.json`,
      '{"name":"boundary-private-dep","types":"index.d.ts"}',
    );
    write(
      `extensions/${id}/node_modules/boundary-private-dep/index.d.ts`,
      "export declare function consume(callback: (value: string) => string): void;",
    );
    write(
      `extensions/${id}/${entry}.ts`,
      'export { value } from "fixture-sdk"; export { consume } from "boundary-private-dep";',
    );
  }
  const recordPath = path.join(root, ".artifacts/extension-package-boundary/plugin-sdk.json");
  const output = "packages/plugin-sdk/dist";
  const step = async (label: string, args: string[], bin?: string, env?: NodeJS.ProcessEnv) => {
    signal.throwIfAborted();
    // Expected compiler failures cancel only their own invocation, not later repair phases.
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await fixture.track(runNodeStep(label, args, 30_000, { bin, env, abortController }));
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const run = (declared = root, pwd = declared) =>
    step(
      "native-fixture",
      [
        path.join(declared, "scripts/prepare-extension-package-boundary-artifacts.mts"),
        `--mode=${mode}`,
      ],
      undefined,
      { PWD: pwd },
    );
  return { ancestor, root, native, write, plugins, recordPath, output, step, run };
}

describe("native declaration preparation", () => {
  it.for([
    { name: "Windows 8.3 short entry", entry: true, workspace: false },
    { name: "Windows 8.3 workspace junction", entry: false, workspace: true },
    { name: "Windows 8.3 short entry and workspace junction", entry: true, workspace: true },
    { name: "POSIX PWD alias (package-boundary)", mode: "package-boundary" as const },
    { name: "POSIX PWD alias (all)", mode: "all" as const },
  ])(
    "publishes cold native output and reuses warm receipts through $name",
    { timeout: 30_000 },
    ({ entry, workspace, mode }, context) => {
      if (mode ? process.platform === "win32" : process.platform !== "win32") {
        return context.skip("Checkout alias is specific to another platform");
      }
      const f = createPreparationFixture(mode ?? "package-boundary", context.signal);
      let declared = f.root;
      if (mode) {
        declared = path.join(f.ancestor, "declared-alias");
        fs.symlinkSync(f.root, declared, "dir");
        expect(fs.realpathSync.native(declared)).toBe(f.root);
      }
      if (entry) {
        const short = resolveNativeFixtureShortPath(f.root);
        if (!short) {
          return context.skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
        }
        declared = short;
        expect(fs.realpathSync(declared)).not.toBe(f.root);
        expect(fs.realpathSync.native(declared)).toBe(f.root);
      }
      if (workspace) {
        const sdk = path.join(f.root, "packages/plugin-sdk");
        const short = resolveNativeFixtureShortPath(sdk);
        if (!short) {
          return context.skip("Filesystem does not expose a distinct Windows 8.3 workspace alias");
        }
        const link = path.join(f.root, "node_modules/fixture-sdk");
        fs.unlinkSync(link);
        fs.symlinkSync(short, link, "junction");
        expect(fs.realpathSync(link)).not.toBe(sdk);
        expect(fs.realpathSync.native(link)).toBe(sdk);
      }
      return fixture.run(async () => {
        // Relative CLI entry paths use Node's physical cwd while Go can retain shell PWD.
        const cold = await f
          .run(mode ? f.root : declared, declared)
          .catch((error: unknown) => error);
        const declaration = path.join(f.root, f.output, "src/nested.d.ts");
        const metadata = path.join(f.root, f.output, ".tsbuildinfo");
        // Even the failing-before case must reach real native emit, not fail during setup.
        expect(fs.readFileSync(declaration, "utf8")).toContain("value = 1");
        const receipt: { fileNames: string[]; fileInfos: unknown[] } = JSON.parse(
          fs.readFileSync(metadata, "utf8"),
        );
        expect(receipt.fileInfos.length).toBeGreaterThan(0);
        expect(receipt.fileNames.some((file) => file.endsWith("/src/nested.ts"))).toBe(true);
        expect(cold).toBeUndefined();
        expect(readArtifactRecord(f.recordPath)?.inputs).toContain("src/nested.ts");
        const owners = [
          {
            recordPath: f.recordPath,
            output: f.output,
            files: [".tsbuildinfo", "src/nested.d.ts", "src/plugin-sdk/core.d.ts"],
          },
          ...f.plugins.map(([id, pluginEntry]) => ({
            recordPath: path.join(f.root, `.artifacts/extension-package-boundary/${id}.json`),
            output: `.artifacts/extension-package-boundary/plugins/${id}`,
            files: [".tsbuildinfo", `${pluginEntry}.d.ts`],
          })),
        ];
        const artifacts = owners.flatMap((owner) => {
          const outputs = owner.files.map((file) => `${owner.output}/${file}`);
          expect(Object.keys(readArtifactRecord(owner.recordPath)!.outputs).toSorted()).toEqual(
            outputs.toSorted(),
          );
          return [owner.recordPath, ...outputs.map((file) => path.join(f.root, file))].map(
            (file) => ({ file, bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs }),
          );
        });
        for (const spelling of [declared, f.root]) {
          await f.run(mode ? f.root : spelling, spelling);
          for (const artifact of artifacts) {
            expect(fs.readFileSync(artifact.file)).toEqual(artifact.bytes);
            expect(fs.statSync(artifact.file).mtimeMs).toBe(artifact.mtimeMs);
          }
        }
      });
    },
  );

  it.for([false, true])(
    "refuses a shared install before creating dependency links or receipts (linked=%s)",
    (linked, { signal }) => {
      const f = createPreparationFixture("package-boundary", signal);
      expect(spawnSync("git", ["init", "-q"], { cwd: f.ancestor }).status).toBe(0);
      f.write(".git", `gitdir: ${path.join(f.ancestor, ".git")}\n`);
      const modules = path.join(f.root, "node_modules");
      const primaryModules = path.join(f.ancestor, "node_modules");
      fs.renameSync(modules, primaryModules);
      if (linked) {
        fs.symlinkSync(primaryModules, modules, "junction");
      }
      const result = spawnSync(
        process.execPath,
        [
          path.join(f.root, "scripts/prepare-extension-package-boundary-artifacts.mts"),
          "--mode=package-boundary",
        ],
        { cwd: f.root, encoding: "utf8", timeout: 20_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Declaration input escapes checkout");
      expect(fs.existsSync(modules)).toBe(linked);
      expect(fs.existsSync(f.recordPath)).toBe(false);
      expect(fs.existsSync(path.join(f.root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
        false,
      );
    },
  );

  it.for(["package-boundary", "all"] as const)(
    "prunes only obsolete native declarations after success and repairs a failed partial emit (%s)",
    { timeout: 30_000 },
    (mode, { signal }) =>
      fixture.run(async () => {
        const { root, native, write, plugins, recordPath, output, step, run } =
          createPreparationFixture(mode, signal);
        await run();
        if (mode === "all") {
          const slackBoundaryEntry = BOUNDARY_PLUGIN_UNITS.find(([id]) => id === "slack")?.[1];
          if (!slackBoundaryEntry) {
            throw new Error("Slack extension boundary entry is missing");
          }
          write(
            "consumer.ts",
            `import { consume } from "./.artifacts/extension-package-boundary/plugins/slack/${slackBoundaryEntry}.js"; consume(value => value.toUpperCase());`,
          );
          await step(
            "isolated-boundary-consumer",
            [
              "--ignoreConfig",
              "--module",
              "nodenext",
              "--target",
              "es2023",
              "--strict",
              "--skipLibCheck",
              "--noEmit",
              path.join(root, "consumer.ts"),
            ],
            native,
          );
        }
        const first = readArtifactRecord(recordPath)!;
        expect(first.outputs[`${output}/src/nested.d.ts`]).toBeDefined();
        write("src/plugin-sdk/core.ts", 'export { value } from "../renamed.js";');
        fs.renameSync(path.join(root, "src/nested.ts"), path.join(root, "src/renamed.ts"));
        write("src/renamed.ts", 'export const value: number = "error";');
        write(`${output}/orphan.d.ts`, "export {};");
        write(`${output}/operator-note.txt`, "unowned");
        await expect(run()).rejects.toThrow("failed with exit code 1");
        signal.throwIfAborted();
        expect(fs.existsSync(recordPath)).toBe(false);
        expect(fs.existsSync(path.join(root, output, "src/renamed.d.ts"))).toBe(true);
        expect(fs.existsSync(path.join(root, output, "src/nested.d.ts"))).toBe(true);
        write("src/renamed.ts", "export const value = 2;");
        await run();
        const repaired = readArtifactRecord(recordPath)!;
        expect(repaired.outputs[`${output}/src/renamed.d.ts`]).toBeDefined();
        expect(repaired.outputs[`${output}/src/nested.d.ts`]).toBeUndefined();
        expect(fs.existsSync(path.join(root, output, "src/nested.d.ts"))).toBe(false);
        expect(fs.existsSync(path.join(root, output, "orphan.d.ts"))).toBe(false);
        expect(fs.readFileSync(path.join(root, output, "operator-note.txt"), "utf8")).toBe(
          "unowned",
        );
        for (const [id, entry] of plugins) {
          const record = readArtifactRecord(
            path.join(root, `.artifacts/extension-package-boundary/${id}.json`),
          )!;
          expect(record.inputs).toContain(`${output}/src/renamed.d.ts`);
          expect(
            record.outputs[`.artifacts/extension-package-boundary/plugins/${id}/${entry}.d.ts`],
          ).toBeDefined();
        }
        fs.rmSync(path.join(root, output, "src/renamed.d.ts"));
        await run();
        expect(readArtifactRecord(recordPath)?.outputs).toEqual(repaired.outputs);
        const unchanged = fs.statSync(path.join(root, output, "src/renamed.d.ts")).mtimeMs;
        const unchangedRecord = fs.statSync(recordPath).mtimeMs;
        await run();
        expect(fs.statSync(path.join(root, output, "src/renamed.d.ts")).mtimeMs).toBe(unchanged);
        expect(fs.statSync(recordPath).mtimeMs).toBe(unchangedRecord);
      }),
  );

  it.for(["src/nested.ts", "package.json"])(
    "rejects %s mutated after native emit without publishing or pruning",
    { timeout: 30_000 },
    (input, { signal }) =>
      fixture.run(async () => {
        const f = createPreparationFixture("package-boundary", signal);
        const trigger = path.join(f.root, ".artifacts/mutate-after-native");
        const source = path.join(f.root, input);
        const original = fs.readFileSync(source, "utf8");
        const launcher = path.join(f.root, "node_modules/.bin/tsgo");
        fs.unlinkSync(launcher);
        f.write(
          "node_modules/.bin/tsgo",
          `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const result = spawnSync(${JSON.stringify(f.native)}, process.argv.slice(2), { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (fs.existsSync(${JSON.stringify(trigger)})) fs.appendFileSync(${JSON.stringify(source)}, "\\n");
`,
        );
        fs.chmodSync(launcher, 0o755);
        if (process.platform === "win32") {
          f.write("node_modules/.bin/tsgo.cmd", '@node "%~dp0tsgo" %*\r\n');
        }
        await f.run();
        expect(readArtifactRecord(f.recordPath)).toBeDefined();
        f.write(`${f.output}/orphan.d.ts`, "export interface Orphan {}\n");
        f.write(".artifacts/mutate-after-native", "armed");

        // The fixture launcher mutates only after the real native emitter exits
        // successfully; its unchanged membership must still fail the seal fence.
        await expect(f.run()).rejects.toThrow("failed with exit code 1");
        expect(fs.readFileSync(source, "utf8")).toBe(`${original}\n`);
        expect(fs.existsSync(f.recordPath)).toBe(false);
        expect(fs.readFileSync(path.join(f.root, f.output, "orphan.d.ts"), "utf8")).toBe(
          "export interface Orphan {}\n",
        );
        expect(fs.existsSync(path.join(f.root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
          false,
        );
      }),
  );

  it.for(["SDK", "plugin batch"] as const)(
    "rejects ancestor inputs without publishing or pruning the %s after native success",
    { timeout: 30_000 },
    (owner, { signal }) =>
      fixture.run(async () => {
        const f = createPreparationFixture(owner === "SDK" ? "package-boundary" : "all", signal);
        await f.run();
        installNativeAncestorTypes(f.ancestor, f.root);
        const [pluginId, entry] = BOUNDARY_PLUGIN_UNITS[0];
        const input =
          owner === "SDK" ? "src/plugin-sdk/core.ts" : `extensions/${pluginId}/${entry}.ts`;
        const config =
          owner === "SDK"
            ? "packages/plugin-sdk/tsconfig.json"
            : `extensions/${pluginId}/tsconfig.json`;
        const rootDir = owner === "SDK" ? "." : `extensions/${pluginId}`;
        const emitted = owner === "SDK" ? "src/plugin-sdk/core.d.ts" : `${entry}.d.ts`;
        f.write(
          input,
          'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\n',
        );
        const units =
          owner === "SDK"
            ? [{ id: "plugin-sdk", output: f.output }]
            : f.plugins.map(([id]) => ({
                id,
                output: `.artifacts/extension-package-boundary/plugins/${id}`,
              }));
        for (const unit of units) {
          f.write(`${unit.output}/orphan.d.ts`, "export interface Orphan {}\n");
        }
        const rawOutput = path.join(f.root, ".artifacts/native-proof");
        await f.step(
          "raw-native-success",
          [
            "-p",
            path.join(f.root, config),
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            rawOutput,
            "--rootDir",
            path.join(f.root, rootDir),
            "--incremental",
            "--tsBuildInfoFile",
            path.join(rawOutput, ".tsbuildinfo"),
          ],
          f.native,
        );
        expect(fs.readFileSync(path.join(rawOutput, emitted), "utf8")).toContain(
          'inferredOrigin: "ancestor"',
        );

        // Raw native success is not publication authority. Every member of the
        // contaminated batch must seal before any old declaration can be pruned.
        await expect(f.run()).rejects.toThrow("failed with exit code 1");
        for (const unit of units) {
          expect(
            fs.existsSync(
              path.join(f.root, `.artifacts/extension-package-boundary/${unit.id}.json`),
            ),
          ).toBe(false);
          expect(fs.readFileSync(path.join(f.root, unit.output, "orphan.d.ts"), "utf8")).toBe(
            "export interface Orphan {}\n",
          );
        }
        expect(fs.existsSync(path.join(f.root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
          false,
        );
      }),
  );
});
