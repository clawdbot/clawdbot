import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  pluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "../../scripts/lib/plugin-sdk-entries.mts";
import {
  createFixture,
  declarationCacheRecords,
  declarationInputs,
  expectOutputs,
  expectStagingClean,
  loader,
  runFixture,
  runWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

const compiler = path.resolve("scripts/run-tsgo.mjs");
// Repeated end-to-end writer runs exceed the default timeout on Windows.
const WRITER_TEST_TIMEOUT_MS = process.platform === "win32" ? 360_000 : 120_000;

describe("write-plugin-sdk-entry-dts", { timeout: WRITER_TEST_TIMEOUT_MS }, () => {
  it("preserves repository input metadata during direct declaration builds", () => {
    const { root, write, declarations, production } = createFixture();
    for (const [name, roots] of Object.entries(declarations)) {
      write(
        `compiler-inputs/${name}.json`,
        JSON.stringify({ roots, sentinel: "repository input" }),
      );
    }
    const before = treeHashes(path.join(root, "compiler-inputs"));
    const direct = runFixture(root, [
      "--import",
      loader,
      path.resolve("scripts/tsdown-build.mts"),
      "--config",
      "tsdown.config.ts",
      ...Object.keys(declarations).flatMap((name) => ["--filter", name]),
    ]);
    expect(direct.status, direct.stdout + direct.stderr).toBe(0);
    expect(
      (direct.stdout + direct.stderr).match(/\[tsdown-build\] invocation \d\/2 finished/gu),
    ).toHaveLength(2);
    expect(treeHashes(path.join(root, "compiler-inputs"))).toEqual(before);
    expectOutputs(root, production, Object.keys(treeHashes(path.join(root, "dist"))));
    expectStagingClean(root);
  });

  it.each<{ name: string; badPlugin: string; before: NodeJS.ProcessEnv; after: NodeJS.ProcessEnv }>(
    [
      {
        name: "bounded plugins",
        badPlugin: "broken",
        before: { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "plain" },
        after: {},
      },
      {
        name: "optional plugins",
        badPlugin: "acpx",
        before: { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "0" },
        after: {},
      },
      {
        name: "Docker plugins",
        badPlugin: "external",
        before: {},
        after: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "external" },
      },
    ],
  )(
    "rejects newly selected $name instead of restoring their previous SDK cache",
    ({ badPlugin, before, after }) => {
      const { root, write } = createFixture();
      for (const id of ["plain", badPlugin]) {
        write(`extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id }));
        write(
          `extensions/${id}/package.json`,
          JSON.stringify({
            name: `@openclaw/${id}`,
            openclaw: { build: { bundledDist: id !== "external" } },
          }),
        );
        if (id !== badPlugin) {
          write(`extensions/${id}/index.ts`, "export {};\n");
        }
      }
      const initial = runWriter(root, false, before);
      expect(initial.status, initial.stdout + initial.stderr).toBe(0);
      const published = treeHashes(path.join(root, "dist"));
      const selected = runWriter(root, false, after);
      expect(selected.status, selected.stdout + selected.stderr).toBeGreaterThan(0);
      expect(selected.stdout + selected.stderr).toContain(`extensions/${badPlugin}/index.ts`);
      expect(treeHashes(path.join(root, "dist"))).toEqual(published);
      expectStagingClean(root);
    },
  );

  it("publishes fresh canonical partitions with stable bytes and public nominal identity", () => {
    const { root, write, writeDeclarations, production, qa } = createFixture();
    expect(production.toSorted()).toEqual(
      publicPluginSdkEntrypoints.map((entry) => `plugin-sdk/${entry}`).toSorted(),
    );
    expect(qa).toEqual(
      expect.arrayContaining(pluginSdkEntrypoints.map((entry) => `plugin-sdk/${entry}`)),
    );
    const preserved = {
      "dist/plugin-sdk/core.js": "runtime stays intact",
      "dist/plugin-sdk/.tsbuildinfo": "boundary compiler state stays intact",
      "dist/plugin-sdk/src/retained.d.ts": "source-shaped output stays intact",
      "dist/unrelated.d.ts": "unrelated root declaration stays intact",
      "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts": "local native declaration stays intact",
      "packages/plugin-sdk/dist/.tsbuildinfo": "local native compiler state stays intact",
      ".artifacts/extension-package-boundary/plugins/qa-channel/api.d.ts":
        "local plugin declaration stays intact",
    };
    for (const [relative, content] of Object.entries(preserved)) {
      write(relative, content);
    }

    const initial = runWriter(root);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    expect(
      (initial.stdout + initial.stderr).match(/\[tsdown-build\] invocation \d\/2 finished/gu),
    ).toHaveLength(2);
    const before = treeHashes(path.join(root, "dist"));
    expectOutputs(root, production, Object.keys(before));
    expectStagingClean(root);
    const records = declarationCacheRecords(root);
    expect(records).toHaveLength(2);
    const inputs = records.flatMap((record) => record.inputs ?? []);
    expect(inputs).toEqual(
      expect.arrayContaining([
        ...declarationInputs.map(({ file }) => file),
        "src/shared.ts",
        "src/schema.d.ts",
        "contracts/before.ts",
      ]),
    );
    expect(inputs.some((file) => file.endsWith("/lib.es2023.d.ts"))).toBe(true);
    expect(inputs).not.toContain("test/unrelated.test.ts");
    expect(inputs).not.toContain("ui/unrelated.ts");
    for (const entry of qa.filter((candidate) => !production.includes(candidate))) {
      expect(fs.existsSync(path.join(root, `dist/${entry}.d.ts`)), entry).toBe(false);
    }

    // Identical sources with a different QA selection must emit the extra canonical entries.
    const privateQa = runWriter(root, true);
    expect(privateQa.status, privateQa.stdout + privateQa.stderr).toBe(0);
    expect(
      (privateQa.stdout + privateQa.stderr).match(/\[tsdown-build\] invocation \d\/2 finished/gu),
    ).toHaveLength(2);
    const priorOutputs = treeHashes(path.join(root, "dist"));
    expectOutputs(root, qa, Object.keys(priorOutputs));
    expectStagingClean(root);

    writeDeclarations("after");
    fs.rmSync(path.join(root, "contracts/before.ts"));
    write("dist/plugin-sdk/obsolete.d.ts", "obsolete flat declaration");
    const changed = runWriter(root, true);
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    expect(
      (changed.stdout + changed.stderr).match(/\[tsdown-build\] invocation \d\/2 finished/gu),
    ).toHaveLength(2);
    const first = treeHashes(path.join(root, "dist"));
    const cachedDistFiles = new Set(
      declarationCacheRecords(root).flatMap((record) =>
        Object.keys(record.outputs)
          .filter((file) => file.startsWith("dist/"))
          .map((file) => file.slice("dist/".length)),
      ),
    );
    expectOutputs(root, qa, Object.keys(first));
    expectStagingClean(root);
    expect(first).not.toEqual(before);
    expect(fs.existsSync(path.join(root, "dist/plugin-sdk/obsolete.d.ts"))).toBe(false);
    for (const [relative, content] of Object.entries(preserved)) {
      expect(fs.readFileSync(path.join(root, relative), "utf8")).toBe(content);
    }
    expect(fs.readFileSync(path.join(root, "src/schema.sql"), "utf8")).toBe(
      "CREATE TABLE fixture (value TEXT NOT NULL);",
    );

    // One restore proves portable, byte-stable reuse despite unrelated edits.
    // Copy only the cache: copying Windows junctions can change the source topology.
    const {
      root: relocated,
      write: writeRelocated,
      writeDeclarations: writeRelocatedDeclarations,
    } = createFixture();
    writeRelocatedDeclarations("after");
    fs.rmSync(path.join(relocated, "contracts/before.ts"));
    writeRelocated("test/unrelated.test.ts", "export const test = 2;\n");
    writeRelocated("ui/unrelated.ts", "export const view = 2;\n");
    writeRelocated(".github/workflows/unrelated.yml", "name: unrelated after\n");
    for (const [relative, content] of Object.entries(preserved)) {
      writeRelocated(relative, content);
    }
    // The QA build can add shared chunks after the production snapshot. Seed
    // only unowned history; current cache outputs must come from the restore.
    for (const file of Object.keys(priorOutputs).filter(
      (entry) => !entry.startsWith("plugin-sdk/") && !cachedDistFiles.has(entry),
    )) {
      expect(first[file]).toBe(priorOutputs[file]);
      writeRelocated(`dist/${file}`, fs.readFileSync(path.join(root, "dist", file), "utf8"));
    }
    writeRelocated("dist/plugin-sdk/obsolete.d.ts", "obsolete restored declaration");
    fs.cpSync(
      path.join(root, ".artifacts/build-all-cache"),
      path.join(relocated, ".artifacts/build-all-cache"),
      { recursive: true },
    );
    const restored = runWriter(relocated, true);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(restored.stdout + restored.stderr).not.toContain("[tsdown-build] invocation");
    const restoredFiles = treeHashes(path.join(relocated, "dist"));
    // Include shared root chunks, not just flat SDK entries, in filename/byte determinism.
    expect(restoredFiles).toEqual(first);
    expectOutputs(relocated, qa, Object.keys(restoredFiles));
    expectStagingClean(relocated);
    for (const [relative, content] of Object.entries(preserved)) {
      expect(fs.readFileSync(path.join(relocated, relative), "utf8")).toBe(content);
    }

    write(
      "consumer.ts",
      [
        'import type { Shared } from "./dist/plugin-sdk/core.js";',
        'import type { Shared as ChannelShared } from "./dist/plugin-sdk/channel-core.js";',
        `import type { TransitiveAlias, ${declarationInputs.map(({ name }) => name).join(", ")} } from "./dist/plugin-sdk/test-fixtures.js";`,
        "declare const shared: Shared; const canonical: ChannelShared = shared;",
        "declare const channelShared: ChannelShared; const publicShared: Shared = channelShared;",
        "// @ts-expect-error An empty object cannot satisfy the nominal SDK class.",
        "const impostor: Shared = {}; void impostor;",
        "// @ts-expect-error The second public subpath must retain the nominal class too.",
        "const channelImpostor: ChannelShared = {}; void channelImpostor;",
        ...["TransitiveAlias", ...declarationInputs.map(({ name }) => name)].map(
          (name) => `const current${name}: ${name} = { value: "after" }; void current${name};`,
        ),
        "void canonical; void publicShared;",
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
    const consumer = spawnSync(
      process.execPath,
      [compiler, "-p", path.join(root, "consumer.json"), "--noEmit"],
      { cwd: root, encoding: "utf8" },
    );
    expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0);
  });

  it.each([
    { source: "source declaration export", diagnostics: ["MISSING_EXPORT", "SourceOnly"] },
    { source: "transitive declaration export", diagnostics: ["MISSING_EXPORT", "TransitiveAlias"] },
    { source: "missing entry", diagnostics: ["core.ts"] },
    { source: "invalid config", diagnostics: ["missing-config.json"] },
    { source: "missing declaration", diagnostics: ["contract"] },
    { source: "input mutation after emit", diagnostics: ["changed during compilation"] },
  ])(
    "rejects $source before replacing published or local declarations",
    ({ source, diagnostics }) => {
      const { root, write } = createFixture();
      write("dist/plugin-sdk/core.d.ts", "previous declaration");
      write("dist/shared.d.ts", "previous shared declaration");
      write("packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts", "previous local declaration");
      const published = treeHashes(path.join(root, "dist"));
      const local = treeHashes(path.join(root, "packages/plugin-sdk/dist"));
      if (source === "source declaration export") {
        write("src/contract.d.ts", "export type SourceOnly = ;");
      } else if (source === "transitive declaration export") {
        write("contracts/before.ts", "export const broken = ;");
      } else if (source === "missing entry") {
        fs.rmSync(path.join(root, "src/plugin-sdk/core.ts"));
      } else if (source === "invalid config") {
        write("tsconfig.json", '{"extends":"./missing-config.json"}');
      } else if (source === "missing declaration") {
        fs.rmSync(path.join(root, "src/contract.d.ts"));
      } else {
        write(
          "tsdown.config.ts",
          `${fs.readFileSync(path.join(root, "tsdown.config.ts"), "utf8")}
for (const config of configs) {
  if (!config.dts?.emitDtsOnly) continue;
  const done = config.hooks?.["build:done"];
  config.hooks = { ...config.hooks, "build:done": async (context) => {
    await done?.(context);
    fs.appendFileSync("src/shared.ts", "\\n");
  }};
}
`,
        );
      }
      const failed = runWriter(root, true);
      expect(failed.error).toBeUndefined();
      expect(failed.signal).toBeNull();
      expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
      expect(treeHashes(path.join(root, "dist"))).toEqual(published);
      expect(treeHashes(path.join(root, "packages/plugin-sdk/dist"))).toEqual(local);
      expectStagingClean(root);
      for (const diagnostic of diagnostics) {
        expect(failed.stdout + failed.stderr).toContain(diagnostic);
      }
    },
  );
});
