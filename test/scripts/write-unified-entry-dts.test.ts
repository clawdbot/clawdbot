import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TSDOWN_NON_SDK_DTS_CONFIG_GROUPS } from "../../scripts/lib/tsdown-config-groups.mts";
import { resolveTsdownDeclarationGeneratorInputs } from "../../scripts/lib/tsdown-declaration-generator-inputs.mts";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";
import {
  createFixture,
  declarationCacheRecords,
  declarationInputs,
  expectStagingClean,
  runFixture,
  runUnifiedBuild,
  runUnifiedWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

describe("write-unified-entry-dts", () => {
  it("owns the executable generator closure without unrelated CI planning code", () => {
    const root = process.cwd();
    const closure = resolveTsdownDeclarationGeneratorInputs(
      root,
      "scripts/write-unified-entry-dts.ts",
    ).map((file) => path.relative(root, file).split(path.sep).join("/"));

    expect(closure).toEqual(
      expect.arrayContaining([
        "scripts/lib/tsdown-declaration-generator-inputs.mts",
        "scripts/lib/tsdown-declaration-boundary.mts",
        "scripts/lib/plugin-sdk-entrypoints.json",
        "scripts/lib/record-shared.mjs",
        "packages/normalization-core/src/mountinfo-path.ts",
        "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts",
        "src/state/openclaw-state-schema.sql",
        "src/state/openclaw-agent-schema.sql",
      ]),
    );
    expect(closure).not.toContain("scripts/lib/ci-node-test-plan.mts");
  });

  it.each([
    ["unowned dynamic", "\nvoid import(generatorTarget);\n", "Unresolved dynamic module edges"],
    ["unresolved static", '\nimport "./missing-generator-owner.mts";\n', "Unresolved import"],
  ])("rejects an %s edge in the real generator graph", (_name, injected, message) => {
    const readFileSync = fs.readFileSync.bind(fs);
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const contents = readFileSync(file, options);
      return typeof contents === "string" && String(file).endsWith("numeric-options.mjs")
        ? `${contents}${injected}`
        : contents;
    });
    try {
      expect(() =>
        resolveTsdownDeclarationGeneratorInputs(
          process.cwd(),
          "scripts/write-unified-entry-dts.ts",
        ),
      ).toThrow(message);
    } finally {
      read.mockRestore();
    }
  });

  it("rejects a same-count computed import retarget", () => {
    const readFileSync = fs.readFileSync.bind(fs);
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const contents = readFileSync(file, options);
      return typeof contents === "string" && String(file).endsWith("tsx-cli-shim.mjs")
        ? contents.replace(
            "resolveTsxImport(SHIM_CHECKOUT_ROOT)",
            "resolveTsxImport(process.cwd())",
          )
        : contents;
    });
    try {
      expect(() =>
        resolveTsdownDeclarationGeneratorInputs(
          process.cwd(),
          "scripts/write-unified-entry-dts.ts",
        ),
      ).toThrow("Unresolved dynamic module edges");
    } finally {
      read.mockRestore();
    }
  });

  it("leaves physical and external installed dependencies to lockfile topology", () => {
    const root = process.cwd();
    const list = () =>
      resolveTsdownDeclarationGeneratorInputs(root, "scripts/write-unified-entry-dts.ts").map(
        (file) => path.relative(root, file).split(path.sep).join("/"),
      );
    expect(list().some((file) => file.endsWith("/typescript/lib/typescript.d.ts"))).toBe(false);

    const realpathSync = fs.realpathSync.bind(fs);
    const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((file, options) => {
      const name = String(file).replaceAll("\\", "/");
      return name.endsWith("/node_modules/typescript/lib/typescript.d.ts")
        ? path.join(root, "node_modules/typescript/lib/typescript.d.ts")
        : realpathSync(file, options as never);
    });
    try {
      expect(list().some((file) => file.endsWith("/typescript/lib/typescript.d.ts"))).toBe(false);
    } finally {
      realpath.mockRestore();
    }
  });

  it("reuses unaffected canonical groups while rebuilding runtime after input edits", () => {
    const { root, write, production, declarations } = createFixture(
      TSDOWN_NON_SDK_DTS_CONFIG_GROUPS,
    );
    materializeNativeCompiler(root);
    expect(Object.values(declarations).every((entries) => entries.length > 0)).toBe(true);
    expect(production).toHaveLength(Object.values(declarations).flat().length);
    write("extensions/fixture-a/runtime-only.js", 'export const runtimeOnly = "runtime";');
    write("extensions/fixture-a/typed-runtime.js", 'export const typedRuntime = "typed";');
    write("extensions/fixture-a/typed-runtime.d.ts", 'export declare const typedRuntime: "typed";');
    fs.appendFileSync(
      path.join(root, "extensions/fixture-a/index.ts"),
      [
        '\nexport const pluginRevision = "fixture_zeta";',
        'export function literalOrder(flag: boolean) { return flag ? "fixture_alpha" as const : "fixture_zeta" as const; }',
        'export { typedRuntime } from "./typed-runtime.js";',
        'export type { Schema as ArrowSchema } from "apache-arrow";',
        'export type { Message as ArrowMessage } from "apache-arrow/ipc/metadata/message";',
      ].join("\n"),
    );
    const preserved = {
      "dist/control-ui/retained.d.ts": "Vite-owned declaration",
      "dist/releases/Previous.app/Contents/Resources/core.d.ts": "signed app declaration",
      "packages/plugin-sdk/dist/retained.d.ts": "native boundary declaration",
    };
    for (const [file, bytes] of Object.entries(preserved)) {
      write(file, bytes);
    }
    write("dist/obsolete.d.ts", "obsolete root declaration");
    write("dist/extensions/removed/api.d.ts", "obsolete plugin declaration");
    write(
      "consumer.ts",
      [
        'import type { Schema } from "apache-arrow";',
        'import type { Message } from "apache-arrow/ipc/metadata/message";',
        'import type { ArrowSchema, ArrowMessage } from "./dist/extensions/fixture-a/index.js";',
        "declare const schema: Schema; const projectedSchema: ArrowSchema = schema;",
        "const originalSchema: Schema = projectedSchema; void originalSchema;",
        "declare const message: Message; const projectedMessage: ArrowMessage = message;",
        "const originalMessage: Message = projectedMessage; void originalMessage;",
        "declare const encode: typeof Schema.encode; const projectedEncode: typeof ArrowSchema.encode = encode; void projectedEncode;",
      ].join("\n"),
    );
    write(
      "consumer.json",
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          types: [],
        },
        files: ["consumer.ts"],
      }),
    );
    const initial = runUnifiedBuild(root);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    expect(
      (initial.stdout + initial.stderr).match(/\[tsdown-build\] invocation \d\/\d finished/gu),
    ).toHaveLength(7);
    for (const entry of production) {
      expect(fs.statSync(path.join(root, `dist/${entry}.d.ts`)).size, entry).toBeGreaterThan(0);
    }
    const readPluginDeclaration = () =>
      fs.readFileSync(path.join(root, "dist/extensions/fixture-a/index.d.ts"), "utf8");
    const originalFunction = readPluginDeclaration().match(
      /^(?:export )?declare function literalOrder\(.*;$/mu,
    )?.[0];
    expect(originalFunction).toBeDefined();
    const consumer = runFixture(root, [
      path.resolve("scripts/run-tsgo.mjs"),
      "-p",
      "consumer.json",
      "--noEmit",
    ]);
    expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0);
    for (const name of ["runtime-only", "typed-runtime"]) {
      expect(
        fs.statSync(path.join(root, `dist/extensions/fixture-a/${name}.js`)).size,
      ).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, `dist/extensions/fixture-a/${name}.d.ts`))).toBe(false);
    }
    expect(fs.existsSync(path.join(root, "dist/obsolete.d.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "dist/extensions/removed/api.d.ts"))).toBe(false);
    for (const [file, bytes] of Object.entries(preserved)) {
      expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(bytes);
    }
    const cache = path.join(root, ".artifacts/build-all-cache");
    const records = declarationCacheRecords(root);
    const inputs = records.flatMap((record) => record.inputs ?? []);
    expect(inputs).toEqual(
      expect.arrayContaining([
        "src/shared.ts",
        "extensions/fixture-a/typed-runtime.d.ts",
        ...declarationInputs.map(({ file }) => file),
      ]),
    );
    expect(inputs).not.toContain("test/unrelated.test.ts");
    expect(inputs).not.toContain("ui/unrelated.ts");
    expect(
      records
        .flatMap((record) => Object.keys(record.outputs))
        .some((file) => file.includes(".app/") || file.includes("control-ui/")),
    ).toBe(false);
    const cached = treeHashes(cache);
    const before = treeHashes(path.join(root, "dist"));
    write("test/unrelated.test.ts", "export const test = 2;\n");
    write("ui/unrelated.ts", "export const view = 2;\n");
    write(".github/workflows/unrelated.yml", "name: unrelated after\n");
    fs.appendFileSync(
      path.join(root, "scripts/lib/ci-node-test-plan.mts"),
      "\n// Unrelated CI planning edit.\n",
    );
    fs.rmSync(path.join(root, "dist"), { recursive: true });
    for (const [file, bytes] of Object.entries(preserved)) {
      write(file, bytes);
    }
    const repeated = runUnifiedBuild(root);
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    expect(
      (repeated.stdout + repeated.stderr).match(/\[tsdown-build\] invocation \d\/\d finished/gu),
    ).toHaveLength(1);
    expect(treeHashes(path.join(root, "dist"))).toEqual(before);
    expect(treeHashes(cache)).toEqual(cached);
    const pluginInput = "extensions/fixture-a/index.ts";
    // A prior literal allocation must not reorder the unchanged function's public type.
    write(
      pluginInput,
      fs
        .readFileSync(path.join(root, pluginInput), "utf8")
        .replace('pluginRevision = "fixture_zeta"', 'pluginRevision = "fixture_alpha"'),
    );
    const isolatedEdit = runUnifiedBuild(root);
    expect(isolatedEdit.status, isolatedEdit.stdout + isolatedEdit.stderr).toBe(0);
    expect(
      (isolatedEdit.stdout + isolatedEdit.stderr).match(
        /\[tsdown-build\] invocation \d\/\d finished/gu,
      ),
    ).toHaveLength(2);
    expect(records).toHaveLength(TSDOWN_NON_SDK_DTS_CONFIG_GROUPS.length);
    expect(records.filter((record) => record.inputs?.includes(pluginInput))).toHaveLength(1);
    expect(records.filter((record) => record.inputs?.includes("src/shared.ts"))).toHaveLength(
      TSDOWN_NON_SDK_DTS_CONFIG_GROUPS.length,
    );
    const changedDeclaration = readPluginDeclaration();
    expect(changedDeclaration).toContain('pluginRevision = "fixture_alpha"');
    expect(
      changedDeclaration.match(/^(?:export )?declare function literalOrder\(.*;$/mu)?.[0],
    ).toBe(originalFunction);
    const changedCacheGroups = new Set(
      Object.entries(treeHashes(cache))
        .filter(([file, digest]) => cached[file] !== digest)
        .map(([file]) => file.split("/")[0]),
    );
    expect(changedCacheGroups.size).toBe(1);
    const mixedGeneration = treeHashes(path.join(root, "dist"));
    const cold = runUnifiedWriter(root, { OPENCLAW_BUILD_CACHE: "0" });
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
    expect(
      (cold.stdout + cold.stderr).match(/\[tsdown-build\] invocation \d\/6 finished/gu),
    ).toHaveLength(6);
    expect(treeHashes(path.join(root, "dist"))).toEqual(mixedGeneration);
    expectStagingClean(root);
  });

  it("records successful empty partitions for a bounded plugin selection", () => {
    const { root } = createFixture(TSDOWN_NON_SDK_DTS_CONFIG_GROUPS);
    const env = { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "fixture-a" };
    const initial = runUnifiedWriter(root, env);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    for (const group of TSDOWN_NON_SDK_DTS_CONFIG_GROUPS) {
      expect(initial.stderr).toContain(
        `[tsdown-unified] ${group}: cache miss (record-unavailable)`,
      );
    }
    expect(
      (initial.stdout + initial.stderr).match(/\[tsdown-build\] invocation \d\/6 finished/gu),
    ).toHaveLength(6);
    expect(fs.existsSync(path.join(root, "dist/extensions/fixture-a/index.d.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/extensions/fixture-b/index.d.ts"))).toBe(false);
    const before = treeHashes(path.join(root, "dist"));
    const repeated = runUnifiedWriter(root, env);
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    for (const group of TSDOWN_NON_SDK_DTS_CONFIG_GROUPS) {
      expect(repeated.stderr).toContain(`[tsdown-unified] ${group}: cache hit (fresh-cache)`);
    }
    expect(repeated.stdout + repeated.stderr).not.toContain("[tsdown-build] invocation");
    expect(treeHashes(path.join(root, "dist"))).toEqual(before);
    expectStagingClean(root);
  });

  it.each([
    "last compiler failure",
    "missing successful receipt",
    "cached input mutation after emit",
  ])("preserves the previous generation on %s", (failure) => {
    const { root, write, declarations } = createFixture(TSDOWN_NON_SDK_DTS_CONFIG_GROUPS);
    write("dist/index.d.ts", "previous root declaration");
    write("dist/extensions/retained/index.d.ts", "previous plugin declaration");
    let before = treeHashes(path.join(root, "dist"));
    let cached: Record<string, string> = {};
    const last = TSDOWN_NON_SDK_DTS_CONFIG_GROUPS.at(-1)!;
    if (failure === "last compiler failure") {
      write(declarations[last]![0]!, 'export type { Missing } from "@openclaw/llm-core";');
    } else {
      write(
        "tsdown.config.ts",
        `${fs.readFileSync(path.join(root, "tsdown.config.ts"), "utf8")}
const selected = configs.find(config => config.name === ${JSON.stringify(last)});
const register = selected.hooks;
selected.hooks = async hooks => {
  await register(hooks);
${
  failure === "missing successful receipt"
    ? '  hooks.clearHook("build:done");'
    : `  hooks.hook("build:done", () => {
    if (fs.existsSync(".artifacts/mutate-cached-input")) {
      fs.appendFileSync(${JSON.stringify(declarations[TSDOWN_NON_SDK_DTS_CONFIG_GROUPS[0]!]![0])}, "\\nexport const cachedRevision = 'after';\\n");
    }
  });`
}
};
`,
      );
    }
    if (failure === "cached input mutation after emit") {
      const initial = runUnifiedWriter(root);
      expect(initial.status, initial.stdout + initial.stderr).toBe(0);
      before = treeHashes(path.join(root, "dist"));
      cached = treeHashes(path.join(root, ".artifacts/build-all-cache"));
      write(".artifacts/mutate-cached-input", "armed");
      fs.appendFileSync(path.join(root, declarations[last]![0]!), "\n");
    }
    const failed = runUnifiedWriter(root);
    expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
    expect(failed.stdout + failed.stderr).toContain(
      failure === "cached input mutation after emit"
        ? "invocation 1/1 finished"
        : "invocation 6/6 finished",
    );
    expect(failed.stdout + failed.stderr).toContain(
      failure === "last compiler failure"
        ? "MISSING_EXPORT"
        : failure === "missing successful receipt"
          ? "Missing successful compiler membership"
          : "changed during compilation",
    );
    expect(treeHashes(path.join(root, "dist"))).toEqual(before);
    expect(treeHashes(path.join(root, ".artifacts/build-all-cache"))).toEqual(cached);
    expectStagingClean(root);
  });
});
