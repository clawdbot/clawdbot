import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  pluginSdkEntrypoints,
  productionPluginSdkEntrypoints,
} from "../../scripts/lib/plugin-sdk-entries.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const sourceRoot = process.cwd();
const loader = pathToFileURL(path.resolve("scripts/tsx.mjs")).href;
const writer = path.resolve("scripts/write-plugin-sdk-entry-dts.ts");
const compiler = path.resolve("scripts/run-tsgo.mjs");
const declarationInputs = [
  { file: "src/contract.d.ts", specifier: "../contract.js", name: "SourceOnly" },
  { file: "root.d.mts", specifier: "../../root.mjs", name: "RootOnly" },
  {
    file: "scripts/fixture-types.d.ts",
    specifier: "../../scripts/fixture-types.js",
    name: "ScriptOnly",
  },
  { file: "test/fixture-types.d.cts", specifier: "../../test/fixture-types.cjs", name: "TestOnly" },
  { file: "src/actual.mts", specifier: "../actual.mjs", name: "EmittedMts" },
  { file: "src/actual.cts", specifier: "../actual.cjs", name: "EmittedCts" },
] as const;

function runFixture(root: string, args: string[], privateQa = false) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_BUILD_PRIVATE_QA: privateQa ? "1" : "0",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      // Use the build owner's existing direct-tool path, without a fixture pnpm shim.
      OPENCLAW_BUILD_ALL_NO_PNPM: "1",
    },
  });
}

function readConfigEntries(root: string, privateQa: boolean) {
  const result = runFixture(
    root,
    [
      "--import",
      loader,
      "--input-type=module",
      "--eval",
      `
import configs from ${JSON.stringify(pathToFileURL(path.join(root, "tsdown.config.ts")).href)};
import { TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS } from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, "scripts/lib/tsdown-config-groups.mts")).href)};
const groups = configs.filter(config => TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS.includes(config.name));
if (groups.length !== TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS.length) throw new Error("Missing SDK declaration groups");
const selected = Object.fromEntries(groups.flatMap(config =>
  Object.entries(config.entry).filter(([, source]) => config.dts.entry.includes(source))
));
process.stdout.write(JSON.stringify({ inputs: Object.values(groups[0].entry), selected }));
`,
    ],
    privateQa,
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { inputs: string[]; selected: Record<string, string> };
}

function createFixture() {
  const root = path.join(fs.realpathSync(createTempDir("openclaw-sdk-declarations-")), "Project");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, ".artifacts"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  const write = (source: string, contents: string) => {
    const relative = path.relative(root, path.resolve(root, source));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Fixture input escapes its root: ${source}`);
    }
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write(
    "package.json",
    '{"name":"sdk-declaration-fixture","version":"0.0.0","private":true,"type":"module"}',
  );
  write("tsdown.config.ts", fs.readFileSync(path.join(sourceRoot, "tsdown.config.ts"), "utf8"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "extensions"));
  fs.mkdirSync(path.join(root, "scripts/lib"));
  for (const entry of fs.readdirSync(path.join(sourceRoot, "scripts/lib"), {
    withFileTypes: true,
  })) {
    const source = path.join(sourceRoot, "scripts/lib", entry.name);
    const target = path.join(root, "scripts/lib", entry.name);
    if (entry.name === "runtime-process-build-entries.mts") {
      fs.copyFileSync(source, target);
    } else {
      fs.symlinkSync(source, target, entry.isDirectory() ? "junction" : "file");
    }
  }
  // These owners derive runtime inputs from import.meta.url; keep that graph inside the fixture.
  const runtimeEntryOwners = new Set([
    "src/infra/runtime-process-entrypoints.ts",
    "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts",
  ]);
  for (const source of runtimeEntryOwners) {
    write(source, fs.readFileSync(path.join(sourceRoot, source), "utf8"));
  }
  // The unmodified config reads workspace export metadata before selecting its SDK groups.
  for (const entry of fs.readdirSync(path.join(sourceRoot, "packages"), { withFileTypes: true })) {
    const metadata = path.join(sourceRoot, "packages", entry.name, "package.json");
    if (entry.isDirectory() && fs.existsSync(metadata)) {
      write(`packages/${entry.name}/package.json`, fs.readFileSync(metadata, "utf8"));
    }
  }
  // The full config resolves these runtime inputs before selecting declaration groups.
  for (const source of [
    "src/worker/worker-deploy-browser-runtime.ts",
    "extensions/browser/src/browser/playwright-core.runtime.ts",
    "src/infra/net/undici-dispatcher-options.ts",
  ]) {
    write(source, "export {};\n");
  }
  const production = readConfigEntries(root, false);
  const qa = readConfigEntries(root, true);
  // Rolldown resolves the complete canonical entry graph even for declaration-only groups.
  // Empty non-SDK sources are fixture inputs, never replacement compiler output.
  for (const source of new Set(qa.inputs)) {
    const relative = path.relative(root, path.resolve(root, source)).replaceAll(path.sep, "/");
    if (!runtimeEntryOwners.has(relative)) {
      write(source, "export {};\n");
    }
  }
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: [],
        paths: {
          "@openclaw/llm-core": ["./src/shared.ts"],
          "@openclaw/llm-core/contract": ["./contracts/current.ts"],
        },
      },
      include: ["src/**/*.ts"],
    }),
  );
  write(
    "src/shared.ts",
    '/** Nominal contract documentation. */\nexport class Shared { private brand = "canonical"; }',
  );
  const writeDeclarations = (value: string) => {
    for (const { file, name } of declarationInputs) {
      write(file, `export interface ${name} { value: "${value}"; }`);
    }
    write(`contracts/${value}.ts`, `export interface TransitiveAlias { value: "${value}"; }`);
    write("contracts/current.ts", `export type { TransitiveAlias } from "./${value}.js";`);
  };
  writeDeclarations("before");
  write("src/schema.d.ts", 'declare module "*.sql" { const text: string; export default text; }');
  write("src/schema.sql", "CREATE TABLE fixture (value TEXT NOT NULL);");
  for (const source of Object.values(qa.selected)) {
    write(
      source,
      [
        'export { Shared } from "@openclaw/llm-core";',
        'export type { TransitiveAlias } from "@openclaw/llm-core/contract";',
        ...declarationInputs.map(
          ({ specifier, name }) => `export type { ${name} } from "${specifier}";`,
        ),
      ].join("\n"),
    );
  }
  write(
    "src/plugin-sdk/core.ts",
    [
      '/// <reference path="../schema.d.ts" />',
      'import schema from "../schema.sql";',
      'export { Shared } from "@openclaw/llm-core";',
      "export function getSchema(): string { return schema; }",
    ].join("\n"),
  );
  return {
    root,
    write,
    writeDeclarations,
    production: Object.keys(production.selected),
    qa: Object.keys(qa.selected),
  };
}

function runWriter(root: string, privateQa = false) {
  return runFixture(root, ["--import", loader, writer], privateQa);
}

function treeHashes(root: string) {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => fs.statSync(path.join(root, name)).isFile())
      .toSorted()
      .map((name) => [
        name.replaceAll(path.sep, "/"),
        createHash("sha256")
          .update(fs.readFileSync(path.join(root, name)))
          .digest("hex"),
      ]),
  );
}

function expectOutputs(root: string, entries: readonly string[]) {
  const sdk = path.join(root, "dist/plugin-sdk");
  expect(
    fs
      .readdirSync(sdk)
      .filter((name) => name.endsWith(".d.ts"))
      .toSorted(),
  ).toEqual(entries.map((entry) => `${entry.slice("plugin-sdk/".length)}.d.ts`).toSorted());
  for (const entry of entries) {
    expect(fs.statSync(path.join(root, `dist/${entry}.d.ts`)).size, entry).toBeGreaterThan(0);
  }
  const files = Object.keys(treeHashes(path.join(root, "dist")));
  const text = files
    .filter((name) => /\.d\.[cm]?ts$/u.test(name))
    .map((name) => fs.readFileSync(path.join(root, "dist", name), "utf8"))
    .join("\n");
  expect(text).toContain("Nominal contract documentation.");
  expect(text).not.toContain("schema.sql");
  expect(text).not.toContain("CREATE TABLE fixture");
  expect(text).not.toContain(root);
  expect(text).not.toContain("plugin-sdk-staging-");
  expect(files.some((name) => name.endsWith(".sql"))).toBe(false);
}

function expectStagingClean(root: string) {
  expect(
    fs
      .readdirSync(path.join(root, ".artifacts"))
      .filter((name) => name.startsWith("plugin-sdk-staging-")),
  ).toEqual([]);
  expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(false);
}

describe("write-plugin-sdk-entry-dts", () => {
  it("publishes fresh canonical partitions with stable bytes and public nominal identity", () => {
    const { root, write, writeDeclarations, production, qa } = createFixture();
    expect(production).toEqual(
      expect.arrayContaining(productionPluginSdkEntrypoints.map((entry) => `plugin-sdk/${entry}`)),
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
    expectOutputs(root, production);
    expectStagingClean(root);
    for (const entry of qa.filter((entry) => !production.includes(entry))) {
      expect(fs.existsSync(path.join(root, `dist/${entry}.d.ts`)), entry).toBe(false);
    }
    const before = treeHashes(path.join(root, "dist"));

    writeDeclarations("after");
    fs.rmSync(path.join(root, "contracts/before.ts"));
    write("dist/plugin-sdk/obsolete.d.ts", "obsolete flat declaration");
    const changed = runWriter(root, true);
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    expectOutputs(root, qa);
    expectStagingClean(root);
    const first = treeHashes(path.join(root, "dist"));
    expect(first).not.toEqual(before);
    const repeated = runWriter(root, true);
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    // Include shared root chunks, not just flat SDK entries, in filename/byte determinism.
    expect(treeHashes(path.join(root, "dist"))).toEqual(first);
    expectOutputs(root, qa);
    expectStagingClean(root);
    expect(fs.existsSync(path.join(root, "dist/plugin-sdk/obsolete.d.ts"))).toBe(false);
    for (const [relative, content] of Object.entries(preserved)) {
      expect(fs.readFileSync(path.join(root, relative), "utf8")).toBe(content);
    }
    expect(fs.readFileSync(path.join(root, "src/schema.sql"), "utf8")).toBe(
      "CREATE TABLE fixture (value TEXT NOT NULL);",
    );

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
      } else {
        fs.rmSync(path.join(root, "src/contract.d.ts"));
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
