import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifactRecord } from "../../scripts/lib/build-artifact-cache.mts";
import { TSDOWN_NON_SDK_DTS_CONFIG_GROUPS } from "../../scripts/lib/tsdown-config-groups.mts";
import {
  createFixture,
  declarationInputs,
  expectStagingClean,
  runFixture,
  runUnifiedBuild,
  runUnifiedWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

describe("write-unified-entry-dts", () => {
  it("reuses six complete unified groups after unrelated byte edits while rebuilding runtime", () => {
    const { root, write, production, declarations } = createFixture(
      TSDOWN_NON_SDK_DTS_CONFIG_GROUPS,
    );
    expect(Object.values(declarations).every((entries) => entries.length > 0)).toBe(true);
    expect(production).toHaveLength(Object.values(declarations).flat().length);
    write("extensions/fixture-a/runtime-only.js", 'export const runtimeOnly = "runtime";');
    write("extensions/fixture-a/typed-runtime.js", 'export const typedRuntime = "typed";');
    write("extensions/fixture-a/typed-runtime.d.ts", 'export declare const typedRuntime: "typed";');
    fs.appendFileSync(
      path.join(root, "extensions/fixture-a/index.ts"),
      [
        '\nexport { typedRuntime } from "./typed-runtime.js";',
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
    const cache = path.join(root, ".artifacts/build-all-cache/tsdown-unified");
    const record = readArtifactRecord(path.join(cache, "stamp.json"));
    expect(record?.inputs).toEqual(
      expect.arrayContaining([
        "src/shared.ts",
        "extensions/fixture-a/typed-runtime.d.ts",
        ...declarationInputs.map(({ file }) => file),
      ]),
    );
    expect(record?.inputs).not.toContain("test/unrelated.test.ts");
    expect(record?.inputs).not.toContain("ui/unrelated.ts");
    expect(
      Object.keys(record?.outputs ?? {}).some(
        (file) => file.includes(".app/") || file.includes("control-ui/"),
      ),
    ).toBe(false);
    const cached = treeHashes(cache);
    const before = treeHashes(path.join(root, "dist"));
    write("test/unrelated.test.ts", "export const test = 2;\n");
    write("ui/unrelated.ts", "export const view = 2;\n");
    write(".github/workflows/unrelated.yml", "name: unrelated after\n");
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
    expectStagingClean(root);
  });

  it("records successful empty partitions for a bounded plugin selection", () => {
    const { root } = createFixture(TSDOWN_NON_SDK_DTS_CONFIG_GROUPS);
    const env = { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "fixture-a" };
    const initial = runUnifiedWriter(root, env);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    expect(
      (initial.stdout + initial.stderr).match(/\[tsdown-build\] invocation \d\/6 finished/gu),
    ).toHaveLength(6);
    expect(fs.existsSync(path.join(root, "dist/extensions/fixture-a/index.d.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/extensions/fixture-b/index.d.ts"))).toBe(false);
    const before = treeHashes(path.join(root, "dist"));
    const repeated = runUnifiedWriter(root, env);
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    expect(repeated.stdout + repeated.stderr).not.toContain("[tsdown-build] invocation");
    expect(treeHashes(path.join(root, "dist"))).toEqual(before);
    expectStagingClean(root);
  });

  it.each(["last compiler failure", "missing successful receipt", "input mutation after emit"])(
    "preserves the previous generation on %s",
    (failure) => {
      const { root, write, declarations } = createFixture(TSDOWN_NON_SDK_DTS_CONFIG_GROUPS);
      write("dist/index.d.ts", "previous root declaration");
      write("dist/extensions/retained/index.d.ts", "previous plugin declaration");
      const before = treeHashes(path.join(root, "dist"));
      const last = TSDOWN_NON_SDK_DTS_CONFIG_GROUPS.at(-1)!;
      if (failure === "last compiler failure") {
        write(declarations[last]![0]!, 'export type { Missing } from "@openclaw/llm-core";');
      } else {
        write(
          "tsdown.config.ts",
          `${fs.readFileSync(path.join(root, "tsdown.config.ts"), "utf8")}
const selected = configs.find(config => config.name === ${JSON.stringify(last)});
${
  failure === "missing successful receipt"
    ? "selected.hooks = {};"
    : `const done = selected.hooks["build:done"];
selected.hooks = { "build:done": async (context) => {
  await done(context);
  fs.appendFileSync("src/shared.ts", "\\n");
}};`
}
`,
        );
      }
      const failed = runUnifiedWriter(root);
      expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
      expect(failed.stdout + failed.stderr).toContain("invocation 6/6 finished");
      expect(failed.stdout + failed.stderr).toContain(
        failure === "last compiler failure"
          ? "MISSING_EXPORT"
          : failure === "missing successful receipt"
            ? "Missing successful compiler membership"
            : "changed during compilation",
      );
      expect(treeHashes(path.join(root, "dist"))).toEqual(before);
      expect(
        fs.existsSync(path.join(root, ".artifacts/build-all-cache/tsdown-unified/stamp.json")),
      ).toBe(false);
      expectStagingClean(root);
    },
  );
});
