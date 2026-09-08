import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execNodeEvalSync } from "../test-utils/node-process.js";

export const unresolvedPluginImportCases = [
  {
    name: "dynamic import",
    file: "loader.mjs",
    helper: "helper.mjs",
    helperSource: 'export const value = "required dependency";',
    source:
      'export async function loadDependency() { const spec = "./helper.mjs"; return (await import(spec)).value; }',
  },
  {
    name: "dynamic require",
    file: "loader.cjs",
    helper: "helper.cjs",
    helperSource: 'exports.value = "required dependency";',
    source:
      'exports.loadDependency = () => { const spec = "./helper.cjs"; return require(spec).value; };',
  },
  {
    name: "indirect require",
    file: "loader.cjs",
    helper: "helper.cjs",
    helperSource: 'exports.value = "required dependency";',
    source: 'const load = require; exports.loadDependency = () => load("./helper.cjs").value;',
  },
  {
    name: "local require.resolve",
    file: "loader.cjs",
    helper: "helper.cjs",
    helperSource: 'exports.value = "required dependency";',
    source:
      'exports.loadDependency = () => require.resolve("./helper.cjs").split(/[\\\\/]/).at(-1);',
    expected: "helper.cjs",
    diagnostic: "require.resolve",
  },
  {
    name: "indexed require.resolve",
    file: "loader.cjs",
    helper: "helper.cjs",
    helperSource: 'exports.value = "required dependency";',
    source:
      'exports.loadDependency = () => require["resolve"]("./helper.cjs").split(/[\\\\/]/).at(-1);',
    expected: "helper.cjs",
    diagnostic: "require.resolve",
  },
];

export async function createPluginImportFixture(
  directory: string,
  { file, helper, helperSource, source }: (typeof unresolvedPluginImportCases)[number],
) {
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, helper), helperSource);
  await fs.writeFile(path.join(directory, file), source);
  const originalUrl = pathToFileURL(path.join(directory, file)).href;
  return () =>
    execNodeEvalSync(
      `const original = await import(${JSON.stringify(originalUrl)}); process.stdout.write(await original.loadDependency());`,
      { timeout: 5_000, maxBuffer: 1_024 },
    );
}
